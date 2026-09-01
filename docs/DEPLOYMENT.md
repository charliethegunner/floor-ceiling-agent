# Deployment & Production Readiness Guide

Phase 23.0. This document defines operational SLAs, containerization patterns,
process/WASM memory limits, and monitoring controls for running the "System 2"
LLM-verified multi-domain engine (`CeilingAgent`, the five verification floors,
`WorkerPoolEvaluator`/`BRepWorkerPoolEvaluator`, `EngineTracer`) described in
`ARCHITECTURE.md` §7 onward, in a production environment. Every value below is
taken from the real defaults in `src/` on `main` (`f9b92a6`) — see the
**Source-of-truth appendix** for exact file/line references. Nothing here is
gated in CI; treat a stale number in this file as a bug, same as
`ARCHITECTURE.md`.

## 0. What this system actually is (read before the rest of this doc)

This project ships **no HTTP server, no `/healthz` route, no Dockerfile, and
no Kubernetes manifest** as of `f9b92a6`. It is a Node/TypeScript library plus
a CLI (`bin/translate.ts`, run via `npm run translate`) invoked programmatically
via `runCeilingAgent` / `TaskGraphExecutor`. There is no build step — every
entrypoint (`bin/translate.ts`, `scripts/*.ts`, the worker-thread scripts
themselves) runs directly under `tsx` (`package.json`'s `scripts` block; CI
runs `npx tsc --noEmit` only for type-checking, never `tsc` to emit `.js`).

Sections 1-3 below therefore split into two kinds of guidance:

- **Real, documented behavior** — the engine's actual configuration surface
  (constructor options, exported constants), its actual memory/timeout
  defaults, its actual shutdown and telemetry behavior. Cited to file/line.
- **Recommended operator wiring** — how to containerize this and expose
  environment variables, health probes, and container resource limits *around*
  it, since none of that exists in-repo today. Marked explicitly as
  recommendation, not existing code, so this document can't be mistaken for a
  description of a deployment pipeline that doesn't exist yet.

Any team embedding this engine behind their own service process (an HTTP API,
a queue worker, a batch job) should follow §2's env-var convention when
building that wrapper, and implement §2.4's health-check pattern inside it.

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
- **No exposed network port** unless your own wrapper adds an HTTP/gRPC
  server around `runCeilingAgent`/`TaskGraphExecutor` — the engine itself
  never binds a socket (the one exception, `src/layer1/distributed/`'s real
  gRPC transport for `DistributedWorkerPoolEvaluator`, is opt-in and used only
  when a caller constructs it explicitly).

## 2. Environment Configuration & Fail-Closed Safety

### 2.1 Current state: no environment variables are read by the engine

A repo-wide search for `process.env.*` in `src/`, `lib/`, and `bin/` returns
zero hits relevant to Z3, thread pools, or retries. Every knob referenced in
this section's title (Z3 timeout, thread pool size, `MAX_RETRIES_DEFAULT`) is
a **TypeScript constructor option or exported constant**, not an environment
variable, as of `f9b92a6`:

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

### 2.2 Recommended `ENV_VAR` → option mapping (operator wiring, not existing code)

If you build a wrapper entrypoint around this engine (§0), the following
mapping is recommended so operators can tune it without a code change. This
is a **convention for your entrypoint script to implement** — nothing in
`src/CeilingAgent.ts` or `src/layer1/*` reads `process.env` today.

| Env var | Maps to | Suggested default |
|---|---|---|
| `CEILING_MAX_RETRIES` | `runCeilingAgent(..., { maxRetries: Number(...) })` | `5` (matches `MAX_RETRIES_DEFAULT`) |
| `WORKER_POOL_SIZE` | `new WorkerPoolEvaluator({ poolSize: Number(...) })` | unset → engine default (`os.cpus().length - 1`) |
| `WORKER_TASK_TIMEOUT_MS` | `WorkerPoolOptions.taskTimeoutMs` | `30000` |
| `WORKER_MAX_RSS_BYTES` | `WorkerPoolOptions.maxWorkerRssBytes` | `536870912` (512MB) |
| `BREP_POOL_SIZE` | `BRepWorkerPoolOptions.poolSize` | `1` — do not raise without re-measuring host memory; each unit costs ~450-500MB RSS at rest |
| `BREP_MAX_RSS_BYTES` | `BRepWorkerPoolOptions.maxWorkerRssBytes` | `943718400` (900MB) |
| `LLM_BASE_URL` | `OpenAiCompatibleClientOptions.baseUrl` | required, no safe default (e.g. `http://localhost:11434/v1` for local Ollama) |
| `LLM_TIMEOUT_MS` | `OpenAiCompatibleClientOptions.timeoutMs` | `120000` |
| `LLM_API_KEY` | `OpenAiCompatibleClientOptions.apiKey` | unset for a local Ollama/vLLM endpoint with no auth |

Validate and fail closed at process startup (not at first request) if a
required var like `LLM_BASE_URL` is missing or a numeric var fails to parse —
never silently fall back to an in-code default for a variable the operator
explicitly set but got wrong.

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

### 2.4 Health check probes (recommended — no HTTP server exists in-repo)

Since this engine exposes no HTTP endpoint, `/healthz` and readiness/liveness
probes are guidance for the wrapping service, built on real, inspectable
engine state:

- **Liveness** — the wrapper process is alive and its event loop is
  responsive. A worker-thread pool doesn't block the main thread, so a
  simple periodic timer-based heartbeat is sufficient; treat a missed
  heartbeat beyond ~2× the check interval as a hung event loop.
- **Readiness** — fail closed (return not-ready) if any of:
  - `pool.poolSize === 0` for either worker pool (construction failed or
    every slot died without respawning).
  - A synthetic self-check candidate (a trivial known-good `instruction` or
    `topology` candidate) fails to pass `verify()` within
    `taskTimeoutMs + 5s` on a rolling schedule (e.g. every 30s) — this
    exercises the real Z3/ts-morph/OpenCASCADE code paths, not just process
    existence.
  - `recycledWorkerCount` has increased more than N times (start at 5) in the
    last 5 minutes — not itself fatal (§2.3), but sustained high recycling
    indicates a task profile the current `maxWorkerRssBytes`/`poolSize`
    combination can't sustain, and new work should stop routing here until
    it's investigated.
  - The configured `LLM_BASE_URL` endpoint fails a lightweight reachability
    check — `runCeilingAgent` cannot make progress without it, and letting
    traffic route to a replica that will only fail after a 120s LLM timeout
    (§2.1) wastes the retry budget for no benefit.
- **Startup probe**: allow at least the sum of both pools' cold-init cost —
  Z3 WASM (~200ms) + ts-morph project load, times `poolSize`, plus OpenCASCADE
  WASM (~600ms per B-Rep worker, `ARCHITECTURE.md` §7.5) — before the first
  readiness check counts against the pod.

### 2.5 Graceful shutdown (real, existing behavior)

`src/layer1/process-lifecycle.ts` installs exactly one process-level
`SIGINT`/`SIGTERM` handler (not one per pool, to avoid Node's max-listener
warning and a multi-handler `process.exit()` race) that fans out to every
currently-registered `WorkerPoolEvaluator`/`BRepWorkerPoolEvaluator` and calls
`terminate()` on each, then exits `130` (SIGINT) or `143` (SIGTERM) — the
conventional `128 + signal number` POSIX codes. This is real and already
wired automatically by both pools' constructors — no additional operator
configuration is required for clean pod termination beyond sizing
`terminationGracePeriodSeconds` per §1.4.

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
approximation of it.

### 3.2 `WorkerGateOutcome.elapsedMs`

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

Verified directly against `main` at `f9b92a6` (Phase 22.0). Re-verify this
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
- `EngineTracer` — `src/telemetry/tracer.ts`
- `WorkerGateOutcome` — `src/layer1/worker-pool-worker.ts`
- Generic gate/floor contract and `onGateComplete` timing hook — `src/verification-floor.ts`
- CI Node version pin (`'20'`) — `.github/workflows/ci.yml:16`
- No `process.env` reads relevant to these settings anywhere in `src/`, `lib/`, `bin/` — verified by repo-wide search, `f9b92a6`
- No `Dockerfile`/Kubernetes manifest in this repository — verified by repo-wide search, `f9b92a6`
