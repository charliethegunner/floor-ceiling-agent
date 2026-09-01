# Deployment & Production Readiness Guide

Phase 23.0, extended by Phase 24.0. This document defines operational SLAs,
containerization patterns, process/WASM memory limits, and monitoring
controls for running the "System 2" LLM-verified multi-domain engine
(`CeilingAgent`, the five verification floors,
`WorkerPoolEvaluator`/`BRepWorkerPoolEvaluator`, `EngineTracer`) described in
`ARCHITECTURE.md` §7 onward, and the HTTP runtime wrapper that now exposes it
(`src/server/`, Phase 24.0), in a production environment. Every value below is
taken from the real defaults in `src/` on `main` — see the **Source-of-truth
appendix** for exact file/line references. Nothing here is gated in CI; treat
a stale number in this file as a bug, same as `ARCHITECTURE.md`.

## 0. What this system actually is (read before the rest of this doc)

As of Phase 24.0, this project ships a real, lightweight HTTP entrypoint —
`src/server/index.ts` (`createServer`), run via `npm run server` — that wraps
`runCeilingAgent`, `WorkerPoolEvaluator`, and `BRepWorkerPoolEvaluator` behind
`/healthz`, `/live`, `/ready`, `/verify`, and `/metrics` (§2.4, §3). It is
still a plain `node:http` server with **no framework dependency**, and this
repository still ships **no Dockerfile and no Kubernetes manifest** — §1.4's
container guidance remains recommended operator wiring, not in-repo code.
There is still no build step — every entrypoint (`bin/translate.ts`,
`src/server/index.ts`, `scripts/*.ts`, the worker-thread scripts themselves)
runs directly under `tsx` (`package.json`'s `scripts` block; CI runs `npx tsc
--noEmit` only for type-checking, never `tsc` to emit `.js`).

Sections 1-3 below therefore split into two kinds of guidance:

- **Real, documented behavior** — the engine's and the HTTP wrapper's actual
  configuration surface (constructor options, exported constants, parsed
  environment variables), their actual memory/timeout defaults, and their
  actual shutdown/telemetry/routing behavior. Cited to file/line.
- **Recommended operator wiring** — how to containerize this deployment
  (base image, resource limits, Kubernetes manifests), since none of that
  exists in-repo today. Marked explicitly as recommendation, not existing
  code, so this document can't be mistaken for a description of a deployment
  pipeline that doesn't exist yet.

A team that needs behavior `src/server/` doesn't cover (a different protocol,
auth, multi-tenancy) should still follow §2's real env-var names when
extending it, and can reuse `createServer`'s dependency-injection shape
(`ServerDependencies`) rather than re-wrapping `runCeilingAgent` from scratch.

## 1. Process Isolation & Resource Hardening

### 1.1 The three isolation boundaries that already exist

| Boundary | Mechanism | File |
|---|---|---|
| Verification work off the main thread | `worker_threads.Worker`, not `child_process` | `src/layer1/worker-pool.ts`, `src/layer1/brep/brep-worker-pool.ts` |
| Arbitrary LLM-generated code execution | a fresh `worker_threads.Worker` per execution, never pooled/reused, with a hard termination deadline | `src/layer1/sandbox-runner.ts` |
| Filesystem/subprocess mutation | path-traversal-guarded writes confined to `targetWorkspace`, gated on `outcome === 'PASS'` | `src/layer1/action-floor.ts` |

**Important caveat that must inform any container memory limit you set**:
`worker_threads` are real OS threads sharing ONE process's address space
(unlike `child_process`). `process.memoryUsage().rss()` — what both worker
pools read to decide whether to recycle a worker — is a **process-wide**
reading, not one worker's exclusive share (`src/layer1/worker-pool.ts:94-106`,
`ARCHITECTURE.md` §7.5). A container memory limit must therefore be sized
against the pool's aggregate footprint, not against one worker's RSS
threshold in isolation.

### 1.2 Worker pool sizing and recycling — real defaults

| | `WorkerPoolEvaluator` | `BRepWorkerPoolEvaluator` |
|---|---|---|
| Handles | `instruction` / `topology` / `claim` / `spatial` | `brep` only |
| File | `src/layer1/worker-pool.ts` | `src/layer1/brep/brep-worker-pool.ts` |
| Default pool size | `os.cpus().length - 1` (`worker-pool.ts:117`) | `1` (`brep-worker-pool.ts:84`) — a single OpenCASCADE-loaded worker costs ~450-500MB RSS at rest |
| Default task timeout | `30_000`ms (`DEFAULT_TASK_TIMEOUT_MS`, both files) | `30_000`ms |
| Default RSS recycle threshold | `512 * 1024 * 1024` (`DEFAULT_MAX_WORKER_RSS_BYTES`, `worker-pool.ts:41`) | `900 * 1024 * 1024` (`brep-worker-pool.ts:42`) |
| Why that threshold | a cold worker already measures ~258MB (Z3 + ts-morph eagerly loaded regardless of task domain); 10 mixed tasks on one worker climbed to ~475MB | OpenCASCADE's own steady-state RSS (~470-500MB) measured flat across 200 build+check cycles |
| Recycling trigger | after every task, if that worker's reported `rssBytes` exceeds the threshold: `worker.terminate()` then respawn at the same slot index, `recycledWorkerCount++` | identical mechanism |
| Fallback on infra failure | `verify()` **never rejects** — a dead pool/worker, a timeout, or a thrown error resolves to the caller-supplied `fallback()` (typically in-process `runVerificationFloor`) | identical fail-open contract — see §2.5 |

Both are configured via constructor options only — `poolSize`, `taskTimeoutMs`,
`maxWorkerRssBytes` — there is no environment-variable wiring for either pool
today (§2.1).

### 1.3 V8 heap flags and container memory budget

Nothing in this repo currently sets `--max-old-space-size` — `package.json`'s
scripts invoke `tsx`/`vitest` with no `NODE_OPTIONS`. For a containerized
deployment, set it explicitly rather than relying on V8's own heuristic
(which sizes itself off total host memory, not the container's cgroup limit,
on Node builds that predate reliable cgroup-aware defaults):

- **Main process** (hosts the `WorkerPoolEvaluator`/`BRepWorkerPoolEvaluator`
  slots plus their workers, all in one address space): budget for
  `1 (main, light — no Z3/ts-morph/OCCT loaded on the main thread by this
  codebase) + poolSize × 512MB (general pool ceiling) + brepPoolSize × 900MB
  (brep pool ceiling)`, then add ~25% headroom above that sum before the
  container is OOM-killed, since the RSS check only fires *after* a task
  completes (§1.2) — a single task's peak can transiently exceed the
  recycling threshold before the check runs.
- Recommended `NODE_OPTIONS=--max-old-space-size=<N>` where `N` (MB) is set
  per worker-slot budget above, not per container total — each
  `worker_threads.Worker` gets its own V8 isolate and old-space ceiling
  independent of the main thread's.
- Concrete example: `poolSize=3` general workers + `brepPoolSize=1`:
  `1 + 3×512 + 1×900 = 2437MB` minimum; set a container memory limit of
  **≥3200MB** (25% headroom) and `--max-old-space-size=896` (~87.5% of the
  912MB `os.cpus()`-driven per-worker budget, leaving room for non-heap V8
  overhead — Z3/OpenCASCADE WASM linear memory is *outside* the V8 old-space
  heap and is not bounded by this flag at all).

### 1.4 Container runtime boundaries (recommended — not in-repo)

There is no Dockerfile in this repository (the only `Dockerfile` under this
checkout belongs to the `opencascade.js` dependency's own build tooling in
`node_modules/`, unrelated to deploying this engine). Recommended pattern for
a team building one:

- **Base image**: `node:20-slim` or later — CI (`.github/workflows/ci.yml`)
  pins `node-version: '20'`; do not deploy on an untested major version.
- **No build stage needed**: this repo ships no `.js` build output — `tsx`
  must be present at runtime (`devDependencies`, so a production image needs
  `npm ci` without `--omit=dev`, or `tsx` promoted to a runtime dependency).
- **One container = one `WorkerPoolEvaluator`/`BRepWorkerPoolEvaluator`
  lifetime**: both pools register a single shared `SIGINT`/`SIGTERM` handler
  (`src/layer1/process-lifecycle.ts`) that tears down every live worker slot
  and exits `130`/`143` respectively (the conventional POSIX
  signal-terminated codes) — this is real, existing behavior, and maps
  directly onto Kubernetes' default `terminationGracePeriodSeconds` + SIGTERM
  pattern with no extra wiring required. Ensure your pod's
  `terminationGracePeriodSeconds` exceeds the longest in-flight
  `taskTimeoutMs` (30s default, §1.2) plus worker teardown time — 45-60s is a
  safe floor.
- **CPU requests**: size Kubernetes `resources.requests.cpu` to at least
  `poolSize + 1` vCPU — `poolSize` defaults to `os.cpus().length - 1`
  specifically so the main thread keeps one core free (`worker-pool.ts:117`);
  under-provisioning CPU below that count defeats the reason that default
  exists.
- **Expose one network port**: `src/server/index.ts` (Phase 24.0) binds
  `PORT` (default `8080`, §2.2) via plain `node:http` — no gRPC port unless
  you also construct a `DistributedWorkerPoolEvaluator`
  (`src/layer1/distributed/`, opt-in, used only when a caller constructs it
  explicitly).

## 2. Environment Configuration & Fail-Closed Safety

### 2.1 The core engine still reads no environment variables directly

A repo-wide search for `process.env.*` in `src/CeilingAgent.ts`,
`src/layer1/*` (excluding `src/server/`), and `lib/` returns zero hits
relevant to Z3, thread pools, or retries. Every knob referenced in this
section's title (Z3 timeout, thread pool size, `MAX_RETRIES_DEFAULT`) is a
**TypeScript constructor option or exported constant** at the engine layer,
not an environment variable:

| Setting | Real default | Where | Type |
|---|---|---|---|
| Candidate retry limit | `MAX_RETRIES_DEFAULT = 5` | `src/CeilingAgent.ts:159`, consumed at `:656` (`options.maxRetries ?? MAX_RETRIES_DEFAULT`) | exported `const`, overridable via `runCeilingAgent(request, llm, { maxRetries })` |
| General worker pool size | `os.cpus().length - 1` | `src/layer1/worker-pool.ts:117` | `WorkerPoolOptions.poolSize` |
| B-Rep worker pool size | `1` | `src/layer1/brep/brep-worker-pool.ts:84` | `BRepWorkerPoolOptions.poolSize` |
| Worker task timeout (both pools) | `30_000`ms | `worker-pool.ts:28`, `brep-worker-pool.ts:41` | `taskTimeoutMs` |
| Worker RSS recycle threshold | `512MB` / `900MB` | `worker-pool.ts:41`, `brep-worker-pool.ts:42` | `maxWorkerRssBytes` |
| LLM HTTP call timeout | `120_000`ms | `src/CeilingAgent.ts:47` (`DEFAULT_OLLAMA_TIMEOUT_MS`) | `OpenAiCompatibleClientOptions.timeoutMs` |
| Meta-kernel rule cap | `1000` | `src/layer5/meta-kernel.ts` (`maxRules`, per `ARCHITECTURE.md` §7.6) | `MetaKernelCompiler` option |
| **Z3 solver timeout** | **none** | — | Z3 gates have no dedicated solver-level timeout anywhere in `src/`; a Z3 gate run through a worker pool is bounded only by that pool's `taskTimeoutMs` (30s default) — run in-process (no pool supplied), it is **unbounded** and relies entirely on Z3 itself terminating. Flag this as a real gap if you route `instruction`-domain traffic in-process without a worker pool. |

### 2.2 Real `ENV_VAR` → option mapping (`src/server/config.ts`, Phase 24.0)

`loadServerConfig(env)` (`src/server/config.ts`) parses these — the HTTP
wrapper's `main()` (`src/server/index.ts`) passes the resolved fields
straight into `OpenAiCompatibleLlmClient`/`WorkerPoolEvaluator`/
`BRepWorkerPoolEvaluator`'s own constructor options:

| Env var | Maps to | Unset behavior |
|---|---|---|
| `MAX_RETRIES` | `runCeilingAgent(..., { maxRetries })` | `undefined` → engine default (`MAX_RETRIES_DEFAULT = 5`) |
| `WORKER_POOL_SIZE` | `WorkerPoolOptions.poolSize` | `undefined` → engine default (`os.cpus().length - 1`) |
| `BREP_WORKER_POOL_SIZE` | `BRepWorkerPoolOptions.poolSize` | `undefined` → engine default (`1`) — do not raise without re-measuring host memory; each unit costs ~450-500MB RSS at rest |
| `WORKER_RSS_THRESHOLD_MB` (megabytes) | `WorkerPoolOptions.maxWorkerRssBytes` (bytes, `×1024×1024`) | `undefined` → engine default (512MB) |
| `BREP_RSS_THRESHOLD_MB` (megabytes) | `BRepWorkerPoolOptions.maxWorkerRssBytes` (bytes) | `undefined` → engine default (900MB) |
| `LLM_TIMEOUT_MS` | `OpenAiCompatibleClientOptions.timeoutMs` | `undefined` → engine default (`120000`) |
| `LLM_BASE_URL` | `OpenAiCompatibleClientOptions.baseUrl` | **required** — `loadServerConfig` throws at startup if missing, no safe default (e.g. `http://localhost:11434/v1` for local Ollama) |
| `LLM_MODEL` | `OpenAiCompatibleClientOptions.model` | **required** — throws if missing |
| `LLM_API_KEY` | `OpenAiCompatibleClientOptions.apiKey` | unset for a local Ollama/vLLM endpoint with no auth |
| `PORT` | the HTTP port `server.listen()` binds | defaults to `8080` |

Deliberate design choice, not an oversight: every numeric field resolves to
`undefined` (not a duplicated literal) when its env var is unset, so
`options.x ?? DEFAULT` at each constructor is the *only* place that default
number lives — `config.ts` can never drift out of sync with a default that
changes inside `worker-pool.ts`/`brep-worker-pool.ts`/`CeilingAgent.ts` later.
There is no `WORKER_TASK_TIMEOUT_MS`/`Z3_TIMEOUT_MS` — the 30s
`taskTimeoutMs` and the absent Z3 solver timeout (§2.1's last row) are not
exposed as env vars by this wrapper today.

`loadServerConfig` validates and fails closed at process startup (not at
first request): a missing `LLM_BASE_URL`/`LLM_MODEL`, or any numeric var that
isn't a positive integer, throws immediately rather than silently falling
back to an in-code default for a variable the operator explicitly set but
got wrong.

### 2.3 Fail-open vs. fail-closed — read this before wiring alerts

These are **not the same thing** in this codebase, and conflating them will
misroute an incident:

- **The worker pools are deliberately fail-OPEN at the infra layer.**
  `WorkerPoolEvaluator.verify()` / `BRepWorkerPoolEvaluator.verify()` never
  reject on a dead pool, a crashed worker, or a timeout — they resolve to the
  caller's `fallback()` (in-process verification), because "a pool problem
  degrades to no isolation for this candidate, never a silently-failed
  candidate" (`ARCHITECTURE.md` §7.5). Do **not** page on a single worker
  recycle or a single fallback invocation — that is documented, intended
  behavior, not a fault.
- **The candidate-verification outcome itself is fail-closed.** A candidate
  that never passes all gates within `maxRetries` attempts throws
  `CeilingAgentExhaustedError` (`src/CeilingAgent.ts`) — it is rejected, never
  silently accepted. `TaskGraphExecutor.requireBRepPoolIfNeeded` fails closed
  even earlier: it throws before any LLM call at all if a graph has a `brep`
  node and no `brepPool` was supplied (`ARCHITECTURE.md` §7.4).
- **Your own health-check wrapper (§2.4) should be fail-closed**, independent
  of the engine's internal fail-open pool contract: if the wrapper cannot
  construct its worker pools, or a liveness self-check task doesn't complete
  within a bounded window, the wrapper should report not-ready — that is a
  property of the surrounding service, not of `WorkerPoolLike.verify()`.

### 2.4 Health check probes (real routes, `src/server/index.ts`, Phase 24.0)

- **`GET /healthz` (alias `GET /live`) — liveness.** Measures a real
  `setImmediate` round-trip (`measureEventLoopLagMs`) rather than trusting
  "this handler ran" — under moderate event-loop backup a handler can still
  eventually execute, so the lag itself is the signal. Returns `200
  { status: 'ok', eventLoopLagMs }` under `LIVENESS_MAX_EVENT_LOOP_LAG_MS`
  (1000ms), else `503 { status: 'degraded', eventLoopLagMs }`.
- **`GET /ready` — readiness.** Fails closed (`503`) if any of:
  - `pool.poolSize === 0` for either worker pool (construction failed or
    every slot died without respawning).
  - A synthetic self-check candidate — a known-good `spatial` sphere for
    `WorkerPoolEvaluator`, a known-good `brep` box for
    `BRepWorkerPoolEvaluator` — is round-tripped through the real
    `pool.verify()`. Because `verify()` never rejects (§2.3's fail-open
    contract), responsiveness is inferred from whether the caller-supplied
    `fallback()` was actually invoked, not from a thrown error.
  - `recycledWorkerCount` (the one real counter both pools expose — neither
    has a direct RSS getter, per §1.1's process-wide-RSS caveat) has grown by
    more than `READY_RECYCLE_THRESHOLD` (`5`) within the trailing
    `READY_RECYCLE_WINDOW_MS` (5 minutes), tracked per pool by
    `RecycleWindowTracker`. Not itself fatal on its own (§2.3), but sustained
    growth is the closest available proxy for "the RSS limit is being
    breached repeatedly."
  - Response body reports both pools' `poolSize`/`responsive`/
    `recycledWorkerCount`/`recentRecycles`/`rssLimitOk` for diagnosis.
  - `LLM_BASE_URL` reachability is **not** checked by `/ready` today — it
    only inspects worker-pool state, per its own name. A misconfigured or
    unreachable LLM endpoint surfaces at `/verify` time instead (a 120s
    `LLM_TIMEOUT_MS` timeout per request, §2.1), not at `/ready`.
- **Startup probe**: allow at least the sum of both pools' cold-init cost —
  Z3 WASM (~200ms) + ts-morph project load, times `poolSize`, plus OpenCASCADE
  WASM (~600ms per B-Rep worker, `ARCHITECTURE.md` §7.5) — before the first
  readiness check counts against the pod.

### 2.5 Graceful shutdown (real, existing behavior)

`src/layer1/process-lifecycle.ts` installs exactly one process-level
`SIGINT`/`SIGTERM` handler (not one per pool, to avoid Node's max-listener
warning and a multi-handler `process.exit()` race) that fans out to every
currently-registered `Terminable` and calls `terminate()` on each, then exits
`130` (SIGINT) or `143` (SIGTERM) — the conventional `128 + signal number`
POSIX codes. `WorkerPoolEvaluator`/`BRepWorkerPoolEvaluator` self-register in
their own constructors; as of Phase 24.0, `src/server/index.ts`'s `main()`
registers the `http.Server` itself the same way (`closeHttpServer` wrapped as
a `Terminable`), so one `SIGTERM` tears down the HTTP listener and both
worker pools through the SAME shared fan-out, not three separate handlers.
Ensure your pod's `terminationGracePeriodSeconds` exceeds the longest
in-flight `taskTimeoutMs` (30s default, §1.2) plus worker teardown time —
45-60s is a safe floor.

## 3. Telemetry & Observability

### 3.1 `EngineTracer` — real OTLP-JSON span shape

`src/telemetry/tracer.ts` produces genuinely OTLP-trace-proto-shaped JSON —
real hex `traceId`/`spanId` via `node:crypto`, real `SPAN_KIND_INTERNAL` (1)
and `STATUS_CODE` (`UNSET`=0/`OK`=1/`ERROR`=2) enum values — with zero
`@opentelemetry/*` dependency (`ARCHITECTURE.md` §7.7). One instance = one
trace = one `runCeilingAgent` call.

- `startTrace(requestId, domain)` opens the root span, named
  `runCeilingAgent:${domain}`.
- `recordFloorGate(gateName, passed, latencyMs, diagnostics?)` creates a real
  child span `floor_gate:${gateName}` carrying a `latency_ms` attribute —
  this is the exact field `scripts/load-test-engine.ts` reads back to
  cross-check recorded span latency against independently measured
  wall-clock time. **Structured-log every `floor_gate:*` span's
  `latency_ms` and `passed`/`status` fields** — this is the primary signal
  for §3.3's per-domain failure-rate and latency alerts.
- `exportSpanJson(status?)` closes the root span and returns the full
  `OtlpTraceExport` (`resourceSpans[].scopeSpans[].spans[]`,
  `resource.attributes` carrying `service.name: 'floor-ceiling-agent'`).

Ship `exportSpanJson()`'s output as structured JSON — one line per exported
trace — to your log aggregator; it is already a complete, self-describing
JSON document with no additional formatting needed. A real OTLP collector can
also ingest it directly, since the shape matches the spec, not an
approximation of it. As of Phase 24.0, `POST /verify` (`src/server/index.ts`)
does exactly this: every response body includes a `telemetry` field carrying
that request's own `exportSpanJson()` output verbatim (`'OK'` on success,
`'ERROR'` on a `CeilingAgentExhaustedError`).

`getGateLatencies()` (`src/telemetry/tracer.ts`, Phase 24.0) returns the same
per-gate data (`{ gate, ok, elapsedMs }[]`) already held in the tracer's
internal spans, without needing to re-parse `exportSpanJson()`'s OTLP
attribute-value union — `GET /metrics`'s `recentGateLatenciesMs` (§3.2) is
built from this.

### 3.2 `WorkerGateOutcome.elapsedMs` and `GET /metrics`

```ts
export interface WorkerGateOutcome {
  gate: string
  ok: boolean
  details: string
  /** Real per-gate latency, measured INSIDE the worker via
   *  runVerificationFloor's onGateComplete hook. */
  elapsedMs?: number
}
```

(`src/layer1/worker-pool-worker.ts`, re-exported from `worker-pool.ts`.) This
is the source of every per-gate timing number produced for worker-routed
verification — log `{ gate, ok, elapsedMs }` per outcome alongside the
`EngineTracer` spans in §3.1; the two are populated from the same underlying
`runVerificationFloor(floor, candidate, onGateComplete)` hook
(`src/verification-floor.ts`) and should never disagree by more than
scheduling jitter.

`GET /metrics` (`src/server/index.ts`, Phase 24.0) exposes, as JSON:
`uptimeSeconds`, `totalVerifications`/`failedVerifications`/
`verificationsByDomain` (a running count `MetricsState` keeps across
`/verify` calls), `recentGateLatenciesMs` (the last 50 `{gate, ok, elapsedMs}`
samples across all requests, from `EngineTracer.getGateLatencies()` above),
and `workerPool`/`brepWorkerPool` (`{ poolSize, recycledWorkerCount }`).
**There is no live RSS reading in this payload** — neither
`WorkerPoolEvaluator` nor `BRepWorkerPoolEvaluator` exposes one in its public
API (§1.1's caveat: `process.memoryUsage().rss()` is process-wide even where
it's read internally), so `recycledWorkerCount` is reported instead, as the
real, available memory-pressure proxy — do not mistake its absence for the
metric being forgotten.

### 3.3 Alert thresholds

Grounded in the real defaults from §1-§2 — none of these are asserted in CI
(`ARCHITECTURE.md` §8/§9 explicitly declines hard wall-clock gates for
flakiness reasons); they are production alerting recommendations layered on
top of real, already-emitted telemetry:

| Signal | Source field | Threshold | Rationale |
|---|---|---|---|
| Retry-loop exhaustion | `CeilingAgentExhaustedError` rate | > 0 sustained over 5 min for one domain | a single exhaustion is expected LLM noise; a sustained rate means the LLM, the prompt, or a floor gate itself regressed |
| Elevated retries short of exhaustion | `CeilingAttempt` count in `CeilingSuccess.history` | p95 attempts > 3 (of `maxRetries=5` default) over 15 min, per domain | approaching the retry ceiling without tripping it is an early-warning signal, not yet an incident |
| Z3/worker task timeout | worker pool `taskTimeoutMs` expiry (falls back to in-process, §2.3 — not a rejection, but still worth counting) | > 1% of tasks over 10 min | Z3 has no dedicated timeout (§2.1) — a rising rate against the 30s pool-level timeout is the only signal available today |
| Per-domain failure rate | `FloorReport.ok === false`, bucketed by the 5 real domains (`instruction`/`topology`/`claim`/`spatial`/`brep`) | > 2× the trailing 24h baseline for that specific domain | domains have materially different natural failure rates (e.g. `brep` gates are stricter than `topology`'s); alert on relative deviation per domain, never one shared absolute threshold across all 5 |
| Worker recycling frequency | `pool.recycledWorkerCount` delta | > 5 recycles / 5 min, either pool | expected occasionally (§2.3); sustained high frequency means the task mix has outgrown the current `poolSize`/`maxWorkerRssBytes` combination |
| LLM endpoint unresponsive | `OpenAiCompatibleLlmClient` timeout rate (120s default, §2.1) | any occurrence | this is a hard dependency — `runCeilingAgent` cannot make progress at all without it; treat as page-worthy immediately, not a rate threshold |

## Source-of-truth appendix

Verified directly against `main`, most recently at Phase 24.0. Re-verify this
table, not just the prose above it, before trusting a number here after a
future phase changes these files:

- `MAX_RETRIES_DEFAULT` — `src/CeilingAgent.ts:159`
- `DEFAULT_TASK_TIMEOUT_MS` (general pool) — `src/layer1/worker-pool.ts:28`
- `DEFAULT_MAX_WORKER_RSS_BYTES` (general pool, 512MB) — `src/layer1/worker-pool.ts:41`
- General pool size default (`os.cpus().length - 1`) — `src/layer1/worker-pool.ts:117`
- `DEFAULT_TASK_TIMEOUT_MS` (B-Rep pool) — `src/layer1/brep/brep-worker-pool.ts:41`
- `DEFAULT_MAX_WORKER_RSS_BYTES` (B-Rep pool, 900MB) — `src/layer1/brep/brep-worker-pool.ts:42`
- B-Rep pool size default (`1`) — `src/layer1/brep/brep-worker-pool.ts:84`
- `DEFAULT_OLLAMA_TIMEOUT_MS` — `src/CeilingAgent.ts:47`
- Graceful shutdown / signal handling — `src/layer1/process-lifecycle.ts`
- `EngineTracer`, `getGateLatencies()` — `src/telemetry/tracer.ts`
- `WorkerGateOutcome` — `src/layer1/worker-pool-worker.ts`
- Generic gate/floor contract and `onGateComplete` timing hook — `src/verification-floor.ts`
- CI Node version pin (`'20'`) — `.github/workflows/ci.yml:16`
- No `process.env` reads relevant to these settings anywhere in `src/CeilingAgent.ts`, `src/layer1/*` (excluding `src/server/`), `lib/` — verified by repo-wide search
- No `Dockerfile`/Kubernetes manifest in this repository — verified by repo-wide search
- **Phase 24.0 (HTTP runtime wrapper):**
  - `loadServerConfig`, `ServerConfig`, env var names/defaults — `src/server/config.ts`
  - `createServer`, `ServerDependencies`, route handlers, `RecycleWindowTracker`, `READY_RECYCLE_WINDOW_MS`/`READY_RECYCLE_THRESHOLD`, `MetricsState`, `main()`/graceful-shutdown wiring — `src/server/index.ts`
  - Route/config/shutdown test coverage — `src/server/index.test.ts`
  - `npm run server` script — `package.json`
