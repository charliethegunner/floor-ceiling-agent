import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  runCeilingAgent,
  CeilingAgentExhaustedError,
  OpenAiCompatibleLlmClient,
  type CeilingRequest,
  type CeilingRequestKind,
  type LlmClient,
} from '../CeilingAgent'
import { WorkerPoolEvaluator, type WorkerVerifyTask, type WorkerGateOutcome } from '../layer1/worker-pool'
import { BRepWorkerPoolEvaluator, type BRepWorkerVerifyTask } from '../layer1/brep/brep-worker-pool'
import { registerForGracefulShutdown } from '../layer1/process-lifecycle'
import { EngineTracer } from '../telemetry/tracer'
import type { SpatialCandidate } from '../spatial-floor'
import type { BRepCandidate } from '../layer1/brep/brep-floor'
import { loadServerConfig, type ServerConfig } from './config'

// Phase 24.0: a lightweight HTTP entrypoint wrapping runCeilingAgent and the
// two real worker pools (WorkerPoolEvaluator, BRepWorkerPoolEvaluator) with
// the operational surface docs/DEPLOYMENT.md §2 describes - no framework
// dependency (node:http only), matching this project's existing pattern of
// zero non-essential runtime dependencies (EngineTracer's own header comment
// makes the same call for OTLP export).

// ---------------------------------------------------------------------------
// Dependencies (injected, not hardcoded, for the same testability reason
// CeilingAgent.ts's LlmClient is injected - see its header comment).
// ---------------------------------------------------------------------------

export interface ServerDependencies {
  llmClient: LlmClient
  workerPool: WorkerPoolEvaluator
  brepPool: BRepWorkerPoolEvaluator
}

// ---------------------------------------------------------------------------
// Small JSON HTTP helpers - no framework, this project has none as a
// dependency and the route surface here is small enough not to need one.
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ---------------------------------------------------------------------------
// GET /healthz (alias /live) - liveness: verifies the event loop itself is
// still scheduling callbacks promptly, via a real setImmediate round-trip,
// not just "this handler ran" (which would be true even under moderate
// event-loop backup, since Node still eventually gets to it).
// ---------------------------------------------------------------------------

const LIVENESS_MAX_EVENT_LOOP_LAG_MS = 1000

function measureEventLoopLagMs(): Promise<number> {
  const start = performance.now()
  return new Promise((resolve) => {
    setImmediate(() => resolve(performance.now() - start))
  })
}

async function handleLiveness(res: ServerResponse): Promise<void> {
  const eventLoopLagMs = await measureEventLoopLagMs()
  const ok = eventLoopLagMs < LIVENESS_MAX_EVENT_LOOP_LAG_MS
  sendJson(res, ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', eventLoopLagMs })
}

// ---------------------------------------------------------------------------
// GET /ready - readiness: inspects real worker-thread pool state.
// WorkerPoolEvaluator/BRepWorkerPoolEvaluator expose no direct RSS getter
// (verified against src/layer1/worker-pool.ts and
// src/layer1/brep/brep-worker-pool.ts's public API) - process.memoryUsage().rss()
// is a process-wide reading anyway (ARCHITECTURE.md §7.5), not a per-pool
// one. Two real, exposed signals stand in, per docs/DEPLOYMENT.md §2.4:
// (1) a bounded synthetic self-check candidate actually round-tripped
//     through pool.verify() - if the pool's own worker path is unresponsive,
//     verify()'s fail-open contract (ARCHITECTURE.md §7.5) silently falls
//     back, so the fallback passed here flips a flag instead of doing real
//     work, making "did the real worker path respond" observable from
//     outside;
// (2) `recycledWorkerCount`, the one real counter both pools already expose
//     - a rolling-window delta above docs/DEPLOYMENT.md §2.4/§3.3's
//     recommended threshold is the closest available proxy for "RSS limit
//     is breached repeatedly", since a recycle IS the pool's own reaction to
//     crossing maxWorkerRssBytes.
// ---------------------------------------------------------------------------

const READY_SELF_CHECK_SPHERE: SpatialCandidate = {
  surface: { type: 'sphere', center: [0, 0, 0], radius: 1 },
  boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
}
const READY_SELF_CHECK_BOX: BRepCandidate = {
  solid: { type: 'box', center: [0, 0, 0], halfExtents: [1, 1, 1] },
  boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
}

async function isGeneralPoolResponsive(pool: WorkerPoolEvaluator): Promise<boolean> {
  let usedFallback = false
  const task: WorkerVerifyTask = { domain: 'spatial', candidateText: JSON.stringify(READY_SELF_CHECK_SPHERE) }
  await pool.verify(task, async (): Promise<WorkerGateOutcome[]> => {
    usedFallback = true
    return []
  })
  return !usedFallback
}

async function isBrepPoolResponsive(pool: BRepWorkerPoolEvaluator): Promise<boolean> {
  let usedFallback = false
  const task: BRepWorkerVerifyTask = { domain: 'brep', candidate: READY_SELF_CHECK_BOX }
  await pool.verify(task, async (): Promise<WorkerGateOutcome[]> => {
    usedFallback = true
    return []
  })
  return !usedFallback
}

export const READY_RECYCLE_WINDOW_MS = 5 * 60 * 1000 // docs/DEPLOYMENT.md §2.4/§3.3: "last 5 minutes"
export const READY_RECYCLE_THRESHOLD = 5 // docs/DEPLOYMENT.md §2.4/§3.3: "> 5 recycles / 5 min"

/** Tracks how much a monotonically-increasing counter (recycledWorkerCount)
 *  has grown within a trailing time window, without needing a full
 *  timestamped event log. */
export class RecycleWindowTracker {
  private samples: { time: number; count: number }[] = []

  constructor(private readonly windowMs: number) {}

  /** Records `count` at `now` (defaults to Date.now()) and returns how much
   *  the counter has grown since the oldest sample still inside the window. */
  recordAndCountRecent(count: number, now: number = Date.now()): number {
    this.samples.push({ time: now, count })
    const cutoff = now - this.windowMs
    while (this.samples.length > 1 && this.samples[0].time < cutoff) this.samples.shift()
    return count - this.samples[0].count
  }
}

interface RecycleTrackers {
  general: RecycleWindowTracker
  brep: RecycleWindowTracker
}

async function handleReady(deps: ServerDependencies, trackers: RecycleTrackers, res: ServerResponse): Promise<void> {
  const generalHasSlots = deps.workerPool.poolSize > 0
  const brepHasSlots = deps.brepPool.poolSize > 0

  const [generalResponsive, brepResponsive] = await Promise.all([
    generalHasSlots ? isGeneralPoolResponsive(deps.workerPool) : Promise.resolve(false),
    brepHasSlots ? isBrepPoolResponsive(deps.brepPool) : Promise.resolve(false),
  ])

  const generalRecentRecycles = trackers.general.recordAndCountRecent(deps.workerPool.recycledWorkerCount)
  const brepRecentRecycles = trackers.brep.recordAndCountRecent(deps.brepPool.recycledWorkerCount)
  const generalRssOk = generalRecentRecycles <= READY_RECYCLE_THRESHOLD
  const brepRssOk = brepRecentRecycles <= READY_RECYCLE_THRESHOLD

  const ok = generalHasSlots && brepHasSlots && generalResponsive && brepResponsive && generalRssOk && brepRssOk

  sendJson(res, ok ? 200 : 503, {
    status: ok ? 'ready' : 'not-ready',
    workerPool: {
      poolSize: deps.workerPool.poolSize,
      responsive: generalResponsive,
      recycledWorkerCount: deps.workerPool.recycledWorkerCount,
      recentRecycles: generalRecentRecycles,
      rssLimitOk: generalRssOk,
    },
    brepWorkerPool: {
      poolSize: deps.brepPool.poolSize,
      responsive: brepResponsive,
      recycledWorkerCount: deps.brepPool.recycledWorkerCount,
      recentRecycles: brepRecentRecycles,
      rssLimitOk: brepRssOk,
    },
  })
}

// ---------------------------------------------------------------------------
// GET /metrics - real request counts and real per-gate latency samples
// (EngineTracer.getGateLatencies(), backed by the same onGateComplete hook
// WorkerGateOutcome.elapsedMs is populated from - verification-floor.ts).
// ---------------------------------------------------------------------------

interface GateLatencySample {
  gate: string
  ok: boolean
  elapsedMs: number
}

const RECENT_GATE_SAMPLES_LIMIT = 50

export class MetricsState {
  private readonly startedAtMs = Date.now()
  private totalVerifications = 0
  private failedVerifications = 0
  private readonly verificationsByDomain = new Map<CeilingRequestKind, number>()
  private readonly recentGateLatencies: GateLatencySample[] = []

  recordVerification(kind: CeilingRequestKind, ok: boolean, gateLatencies: GateLatencySample[]): void {
    this.totalVerifications++
    if (!ok) this.failedVerifications++
    this.verificationsByDomain.set(kind, (this.verificationsByDomain.get(kind) ?? 0) + 1)
    this.recentGateLatencies.push(...gateLatencies)
    while (this.recentGateLatencies.length > RECENT_GATE_SAMPLES_LIMIT) this.recentGateLatencies.shift()
  }

  snapshot(workerPool: WorkerPoolEvaluator, brepPool: BRepWorkerPoolEvaluator): Record<string, unknown> {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAtMs) / 1000),
      totalVerifications: this.totalVerifications,
      failedVerifications: this.failedVerifications,
      verificationsByDomain: Object.fromEntries(this.verificationsByDomain),
      recentGateLatenciesMs: this.recentGateLatencies,
      // No direct RSS getter is exposed by either pool's public API (see the
      // /ready comment above) - recycledWorkerCount is the real, available
      // memory-pressure signal.
      workerPool: { poolSize: workerPool.poolSize, recycledWorkerCount: workerPool.recycledWorkerCount },
      brepWorkerPool: { poolSize: brepPool.poolSize, recycledWorkerCount: brepPool.recycledWorkerCount },
    }
  }
}

// ---------------------------------------------------------------------------
// POST /verify - the primary handler: runs a real CeilingRequest through
// runCeilingAgent (src/CeilingAgent.ts) and returns its structured result,
// including any StructuredDiagnostic a failed gate carried (CeilingAttempt.failedGate.structured).
// ---------------------------------------------------------------------------

const VALID_KINDS: readonly CeilingRequestKind[] = ['instruction', 'patch', 'topology', 'claim', 'spatial', 'brep']

interface VerifyRequestBody {
  kind: CeilingRequestKind
  description: string
  maxRetries?: number
}

function parseVerifyRequestBody(raw: string): VerifyRequestBody {
  let body: unknown
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw)
  } catch {
    throw new Error('request body must be valid JSON')
  }
  if (typeof body !== 'object' || body === null) throw new Error('request body must be a JSON object')

  const { kind, description, maxRetries } = body as Record<string, unknown>
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as CeilingRequestKind)) {
    throw new Error(`"kind" must be one of: ${VALID_KINDS.join(', ')}`)
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error('"description" must be a non-empty string')
  }
  if (maxRetries !== undefined && (typeof maxRetries !== 'number' || !Number.isInteger(maxRetries) || maxRetries <= 0)) {
    throw new Error('"maxRetries" must be a positive integer when provided')
  }

  return { kind: kind as CeilingRequestKind, description, maxRetries: maxRetries as number | undefined }
}

async function handleVerify(req: IncomingMessage, res: ServerResponse, deps: ServerDependencies, config: ServerConfig, metrics: MetricsState): Promise<void> {
  let parsed: VerifyRequestBody
  try {
    parsed = parseVerifyRequestBody(await readRequestBody(req))
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    return
  }

  const tracer = new EngineTracer()
  const request: CeilingRequest = { kind: parsed.kind, description: parsed.description }

  try {
    const success = await runCeilingAgent(request, deps.llmClient, { maxRetries: parsed.maxRetries ?? config.maxRetries, tracer })
    const telemetry = tracer.exportSpanJson('OK')
    metrics.recordVerification(parsed.kind, true, tracer.getGateLatencies())
    sendJson(res, 200, { ok: true, result: success.result, attempts: success.attempts, gates: success.gates, history: success.history, telemetry })
  } catch (error) {
    if (error instanceof CeilingAgentExhaustedError) {
      const telemetry = tracer.exportSpanJson('ERROR')
      metrics.recordVerification(parsed.kind, false, tracer.getGateLatencies())
      sendJson(res, 422, { ok: false, attempts: error.report.attempts, history: error.report.history, error: error.message, telemetry })
      return
    }
    metrics.recordVerification(parsed.kind, false, [])
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

// ---------------------------------------------------------------------------
// Router + server factory. createServer() has no side effects beyond
// constructing the http.Server object - it never calls listen() itself, so
// importing this module (e.g. from a test) never binds a real port. See
// main() below for the real bootstrap.
// ---------------------------------------------------------------------------

async function routeRequest(req: IncomingMessage, res: ServerResponse, config: ServerConfig, deps: ServerDependencies, metrics: MetricsState, trackers: RecycleTrackers): Promise<void> {
  const method = req.method ?? 'GET'
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname

  try {
    if (method === 'GET' && (pathname === '/healthz' || pathname === '/live')) return await handleLiveness(res)
    if (method === 'GET' && pathname === '/ready') return await handleReady(deps, trackers, res)
    if (method === 'POST' && pathname === '/verify') return await handleVerify(req, res, deps, config, metrics)
    if (method === 'GET' && pathname === '/metrics') return sendJson(res, 200, metrics.snapshot(deps.workerPool, deps.brepPool))
    sendJson(res, 404, { error: `no route for ${method} ${pathname}` })
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

export function createServer(config: ServerConfig, deps: ServerDependencies): Server {
  const metrics = new MetricsState()
  const trackers: RecycleTrackers = { general: new RecycleWindowTracker(READY_RECYCLE_WINDOW_MS), brep: new RecycleWindowTracker(READY_RECYCLE_WINDOW_MS) }

  return createHttpServer((req, res) => {
    void routeRequest(req, res, config, deps, metrics, trackers)
  })
}

/** Closes an http.Server as a real Promise - used both by the graceful
 *  shutdown wiring below and directly by tests. */
export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

// ---------------------------------------------------------------------------
// Real bootstrap - only runs when this file is executed directly (`tsx
// src/server/index.ts` / `npm run server`), never on import, so
// src/server/index.test.ts can import createServer() without needing
// LLM_BASE_URL/LLM_MODEL set or a real port bound.
// ---------------------------------------------------------------------------

function isRunAsMain(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
}

async function main(): Promise<void> {
  const config = loadServerConfig(process.env)
  const llmClient = new OpenAiCompatibleLlmClient({ baseUrl: config.llmBaseUrl, model: config.llmModel, apiKey: config.llmApiKey, timeoutMs: config.llmTimeoutMs })
  const workerPool = new WorkerPoolEvaluator({ poolSize: config.workerPoolSize, maxWorkerRssBytes: config.workerRssThresholdBytes })
  const brepPool = new BRepWorkerPoolEvaluator({ poolSize: config.brepWorkerPoolSize, maxWorkerRssBytes: config.brepRssThresholdBytes })
  const server = createServer(config, { llmClient, workerPool, brepPool })

  // workerPool/brepPool already self-register with process-lifecycle in
  // their own constructors - registering the http.Server here means
  // SIGINT/SIGTERM tears down all three via the SAME shared fan-out
  // (src/layer1/process-lifecycle.ts), not a separate handler.
  registerForGracefulShutdown({ terminate: () => closeHttpServer(server) })

  server.listen(config.port, () => {
    console.log(JSON.stringify({ level: 'info', message: `server listening on port ${config.port}` }))
  })
}

if (isRunAsMain()) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : String(error) }))
    process.exitCode = 1
  })
}
