import { randomUUID } from 'node:crypto'
import { Project, SyntaxKind } from 'ts-morph'
import { type VerificationFloor, runVerificationFloor } from './verification-floor'
import { TOPOLOGY_FLOOR, type TopologyCandidate } from './topology-floor'
import { CLAIM_VERIFICATION_FLOOR, type ClaimCandidate } from './claim-floor'
import { SPATIAL_VERIFICATION_FLOOR, type SpatialCandidate } from './spatial-floor'
import { BREP_VERIFICATION_FLOOR, type BRepCandidate } from './layer1/brep/brep-floor'
import { verifyInstructionCandidate } from './instruction-floor'
import { ParallelCandidateSampler } from './layer3/sampler'
import type { TemperatureStrategy, WorkerOffload } from './layer3/types'
import type { WorkerDomain } from './layer1/worker-pool'
import type { WorkerPoolLike } from './layer1/worker-pool-like'
import { MetaKernelCompiler, classifyFailurePattern, derivePatch } from './layer5/meta-kernel'
import type { EngineTracer } from './telemetry/tracer'
import { formatEngineResponse, type FormattedEngineResponse, type ResolvedLayer } from './telemetry/output-formatter'

export { verifyInstructionCandidate } from './instruction-floor'

// ---------------------------------------------------------------------------
// LLM client. A local Ollama or vLLM server both expose an OpenAI-compatible
// chat-completions endpoint (Ollama at `/v1/chat/completions`, vLLM at the
// same path), so that shape is the common denominator this targets. The
// client is injected, not hardcoded, so runCeilingAgent stays testable
// without a live server — see CeilingAgent.test.ts for the fake used there.
// ---------------------------------------------------------------------------

export interface LlmClient {
  complete(prompt: string, temperature?: number): Promise<string>
}

export interface OpenAiCompatibleClientOptions {
  baseUrl: string // e.g. 'http://localhost:11434/v1' (Ollama) or 'http://localhost:8000/v1' (vLLM)
  model: string
  apiKey?: string
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  constructor(private readonly options: OpenAiCompatibleClientOptions) {}

  async complete(prompt: string, temperature = 0): Promise<string> {
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
      }),
    })

    if (!response.ok) {
      throw new Error(`LLM endpoint ${this.options.baseUrl} returned ${response.status}: ${await response.text()}`)
    }

    const data: unknown = await response.json()
    const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('LLM response missing choices[0].message.content')
    }
    return content.trim()
  }
}

// ---------------------------------------------------------------------------
// Request / result shapes
// ---------------------------------------------------------------------------

export type CeilingRequestKind = 'instruction' | 'patch' | 'topology' | 'claim' | 'spatial' | 'brep'

export interface CeilingRequest {
  kind: CeilingRequestKind
  /** 'instruction': the x86 instruction text to translate.
   *  'patch': a prose description of the TypeScript function to generate.
   *  'topology': a prose description of the module layout to propose.
   *  'claim': a prose description of the claim to produce and verify.
   *  'spatial': a prose description of the SDF/CSG surface to propose.
   *  'brep': a prose description of the solid B-Rep CAD geometry to propose. */
  description: string
}

export interface GateCheckResult {
  gate: string
  ok: boolean
  details: string
}

export interface CeilingAttempt {
  attempt: number
  candidate: string
  failedGate: GateCheckResult
}

export interface CeilingSuccess {
  ok: true
  result: string
  attempts: number
  gates: GateCheckResult[]
  /** Attempts rejected before the successful one, in order. Empty on a first-try success. */
  history: CeilingAttempt[]
  /** Phase 11.4: only present when options.formatResponse is set - a purely
   *  additive presentation layer, never required by existing callers. */
  formatted?: FormattedEngineResponse
}

export interface CeilingFailureReport {
  request: CeilingRequest
  attempts: number
  history: CeilingAttempt[]
  /** Phase 11.4: only present when options.formatResponse is set. */
  formatted?: FormattedEngineResponse
}

export class CeilingAgentExhaustedError extends Error {
  readonly report: CeilingFailureReport

  constructor(report: CeilingFailureReport) {
    super(
      `CeilingAgent exhausted ${report.attempts} attempt(s) without a verified solution for ` +
        `${report.request.kind} "${report.request.description}". ` +
        `Last failure (gate "${report.history[report.history.length - 1]?.failedGate.gate}"): ` +
        `${report.history[report.history.length - 1]?.failedGate.details}`
    )
    this.name = 'CeilingAgentExhaustedError'
    this.report = report
  }
}

export const MAX_RETRIES_DEFAULT = 5

// ---------------------------------------------------------------------------
// 'patch' mode verification: the candidate is a TypeScript source snippet.
// Checked with ts-morph's in-memory filesystem only — no real file is ever
// written or read, and the code is never executed. Fuzz/symbolic gates are
// explicitly not applicable here: proving anything about arbitrary generated
// code would require actually running it, and executing untrusted
// LLM-generated code is a real security concern this scope deliberately
// avoids rather than papers over.
// ---------------------------------------------------------------------------

function verifyPatchCandidate(candidate: string): GateCheckResult[] {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } })

  let file
  try {
    file = project.createSourceFile('candidate.ts', candidate)
  } catch (error) {
    return [{ gate: 'static', ok: false, details: `not parseable TypeScript: ${error instanceof Error ? error.message : String(error)}` }]
  }

  const diagnostics = project.getPreEmitDiagnostics()
  if (diagnostics.length > 0) {
    return [{ gate: 'static', ok: false, details: `compile diagnostics: ${diagnostics.map((d) => d.getMessageText()).join('; ')}` }]
  }

  const anyUsages = file.getDescendantsOfKind(SyntaxKind.AnyKeyword)
  if (anyUsages.length > 0) {
    return [
      { gate: 'static', ok: false, details: `explicit "any" usage at line(s) ${anyUsages.map((n) => n.getStartLineNumber()).join(', ')}` },
    ]
  }

  if (!file.getFunctions().some((fn) => fn.isExported())) {
    return [{ gate: 'static', ok: false, details: 'candidate must export at least one function' }]
  }

  return [
    { gate: 'static', ok: true, details: '0 diagnostics, 0 "any" usages, at least one exported function' },
    { gate: 'fuzz', ok: true, details: 'not applicable to patch candidates: would require executing untrusted code' },
    { gate: 'symbolic', ok: true, details: 'not applicable to patch candidates: would require executing untrusted code' },
  ]
}

// ---------------------------------------------------------------------------
// 'topology' and 'claim' mode verification: the candidate is JSON text
// parsed into TOPOLOGY_FLOOR's / CLAIM_VERIFICATION_FLOOR's Candidate shape
// (src/topology-floor.ts, src/claim-floor.ts) and run through that floor
// unchanged - this is the generic VerificationFloor contract (Phase 4)
// driving domains beyond ARM64 instruction translation. Malformed JSON, or
// JSON missing a required array field, is caught here and reported as a
// failure of that floor's first gate, matching verifyPatchCandidate's
// "unparseable candidate fails the first gate" precedent - never left as an
// uncaught exception that would break the retry loop.
//
// A live benchmark run (scripts/benchmark-live.ts) found real local models
// wrapping their JSON in a ```json ... ``` fence despite the prompt
// explicitly saying "no markdown fences" - every fenced attempt failed
// JSON.parse identically, and since the model kept resubmitting the same
// fenced text on each retry, self-correction never happened across the
// whole retry budget. stripJsonFences extracts the first fenced block
// (with or without a language tag) from anywhere in the response - not
// just when the ENTIRE response is exactly the fence - so a model's own
// surrounding prose ("Here's the JSON:\n```json\n{...}\n```\nLet me know!")
// doesn't defeat it either (Phase 5.1). Falls back to the raw trimmed text
// when no fence is present, so a plain unfenced JSON response is unchanged.
// ---------------------------------------------------------------------------

const JSON_FENCE_PATTERN = /```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```/

export function stripJsonFences(candidateText: string): string {
  const trimmed = candidateText.trim()
  const match = JSON_FENCE_PATTERN.exec(trimmed)
  return match ? match[1].trim() : trimmed
}

/** Called after each individual gate resolves, with its outcome and real
 *  measured latency - Phase 11.1's EngineTracer wiring uses this to record
 *  genuine per-gate spans, but any caller can pass one. */
export type GateCompleteHook = (gate: GateCheckResult, elapsedMs: number) => void

export async function verifyTopologyCandidate(candidateText: string, onGateComplete?: GateCompleteHook): Promise<GateCheckResult[]> {
  try {
    const parsed = JSON.parse(stripJsonFences(candidateText)) as TopologyCandidate
    const report = await runVerificationFloor(TOPOLOGY_FLOOR, parsed, onGateComplete)
    return report.gates
  } catch (error) {
    return [{ gate: TOPOLOGY_FLOOR.gates[0].name, ok: false, details: `candidate could not be verified: ${error instanceof Error ? error.message : String(error)}` }]
  }
}

export async function verifyClaimCandidate(candidateText: string, onGateComplete?: GateCompleteHook): Promise<GateCheckResult[]> {
  try {
    const parsed = JSON.parse(stripJsonFences(candidateText)) as ClaimCandidate
    const report = await runVerificationFloor(CLAIM_VERIFICATION_FLOOR, parsed, onGateComplete)
    return report.gates
  } catch (error) {
    return [{ gate: CLAIM_VERIFICATION_FLOOR.gates[0].name, ok: false, details: `candidate could not be verified: ${error instanceof Error ? error.message : String(error)}` }]
  }
}

export async function verifySpatialCandidate(candidateText: string, onGateComplete?: GateCompleteHook): Promise<GateCheckResult[]> {
  try {
    const parsed = JSON.parse(stripJsonFences(candidateText)) as SpatialCandidate
    const report = await runVerificationFloor(SPATIAL_VERIFICATION_FLOOR, parsed, onGateComplete)
    return report.gates
  } catch (error) {
    return [{ gate: SPATIAL_VERIFICATION_FLOOR.gates[0].name, ok: false, details: `candidate could not be verified: ${error instanceof Error ? error.message : String(error)}` }]
  }
}

// Phase 15.1: the in-process fallback every other worker-eligible domain
// already has (verifyTopologyCandidate/verifyClaimCandidate/
// verifySpatialCandidate above) - used whenever runCeilingAgent is called
// directly for kind 'brep' without going through TaskGraphExecutor's own
// dedicated BRepWorkerPoolEvaluator dispatch (see task-graph.ts). This is a
// real, working path, not a stub - it pays OpenCASCADE's real ~600ms/
// ~450-500MB cost on the calling thread, same as any other one-off call
// would; 'brep' is deliberately absent from WORKER_DOMAIN_BY_KIND below
// because BRepWorkerPoolEvaluator doesn't structurally satisfy
// WorkerPoolLike (its task carries a structured BRepCandidate, not
// candidateText: string) - so bestOfN.workerPool can never route to it,
// only TaskGraphExecutor's direct dispatch can.
export async function verifyBRepCandidate(candidateText: string, onGateComplete?: GateCompleteHook): Promise<GateCheckResult[]> {
  try {
    const parsed = JSON.parse(stripJsonFences(candidateText)) as BRepCandidate
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, parsed, onGateComplete)
    return report.gates
  } catch (error) {
    return [{ gate: BREP_VERIFICATION_FLOOR.gates[0].name, ok: false, details: `candidate could not be verified: ${error instanceof Error ? error.message : String(error)}` }]
  }
}

// ---------------------------------------------------------------------------
// Retry loop
// ---------------------------------------------------------------------------

// The self-healing correction loop's whole value depends on this being
// deterministic (same request + same rejection history -> byte-identical
// prompt, always - no Date.now()/Math.random() anywhere near it) and on
// each rejected attempt's counterexample surfacing verbatim, not summarized
// or dropped: a Z3 gate's `details` already contains its SAT model (see
// checkSymbolicEquivalence's "Z3 found a disagreeing case (SAT model): ...")
// and a fast-check-driven gate's `details` would carry its own shrunk
// counterexample the same way - buildPrompt doesn't need to know which kind
// of gate produced the failure, only to pass its details through exactly.
export function buildPrompt(request: CeilingRequest, history: CeilingAttempt[]): string {
  const feedback = history
    .map(
      (a) =>
        `Attempt ${a.attempt} was rejected - gate "${a.failedGate.gate}".\n` +
        `Counterexample/details: ${a.failedGate.details}\n` +
        `Rejected candidate:\n${a.candidate}`
    )
    .join('\n\n')

  const header = PROMPT_HEADERS[request.kind](request.description)

  return feedback ? [...header, '', 'Previous attempts were rejected:', feedback, 'Fix the issue and try again.'].join('\n') : header.join('\n')
}

const PROMPT_HEADERS: Record<CeilingRequestKind, (description: string) => string[]> = {
  instruction: (description) => [
    'Translate this single x86-64 instruction to ARM64 assembly.',
    `x86 instruction: ${description}`,
    'Register mapping: RAX=X0, RBX=X1, RCX=X2, RDX=X3, RSP=SP, RBP=FP, RDI=X4.',
    'Respond with ONLY the ARM64 instruction text - no explanation, no markdown fences.',
  ],
  patch: (description) => [
    `Write a single exported TypeScript function implementing this: ${description}`,
    'Follow strict TypeScript (no "any"). Respond with ONLY the code - no explanation, no markdown fences.',
  ],
  topology: (description) => [
    `Propose a small TypeScript module layout satisfying this: ${description}`,
    'Respond with ONLY a JSON object matching the TopologyCandidate shape: ' +
      '{ inMemoryFiles: Record<filePath, sourceText>, expectedExports: [{ filePath, exportedNames }], ' +
      'reachability: [{ from: { filePath, functionName }, to: { filePath, functionName }, expectReachable }] } - ' +
      'no explanation, no markdown fences.',
  ],
  claim: (description) => [
    `Produce a claim verification payload for this: ${description}`,
    'Respond with ONLY a JSON object matching the ClaimCandidate shape: ' +
      '{ claims: [{ statement, subject: { modulePath, exportName }, assertion: { args, expected } }] } - ' +
      'no explanation, no markdown fences.',
  ],
  spatial: (description) => [
    `Propose a Signed Distance Function (SDF) / CSG surface satisfying this: ${description}`,
    'Respond with ONLY a JSON object matching the SpatialCandidate shape: ' +
      '{ surface: SdfNode, boundingBox: { min: [x,y,z], max: [x,y,z] } }, where SdfNode is one of ' +
      '{ type: "sphere", center: [x,y,z], radius }, { type: "box", center: [x,y,z], halfExtents: [x,y,z] }, ' +
      '{ type: "plane", normal: [x,y,z], distance }, { type: "torus", center: [x,y,z], majorRadius, minorRadius }, ' +
      '{ type: "union"|"intersection", children: SdfNode[] }, or { type: "subtraction", a: SdfNode, b: SdfNode } - ' +
      'no explanation, no markdown fences.',
  ],
  brep: (description) => [
    `Propose a solid B-Rep (Boundary Representation) CAD shape satisfying this: ${description}`,
    'Respond with ONLY a JSON object matching the BRepCandidate shape: ' +
      '{ solid: BRepNode, boundingBox: { min: [x,y,z], max: [x,y,z] } }, where BRepNode is one of ' +
      '{ type: "box", center: [x,y,z], halfExtents: [x,y,z] }, { type: "cylinder", baseCenter: [x,y,z], radius, height }, ' +
      '{ type: "sphere", center: [x,y,z], radius }, { type: "union"|"intersection", children: BRepNode[] }, or ' +
      '{ type: "subtraction", a: BRepNode, b: BRepNode } - no explanation, no markdown fences.',
  ],
}

// Dynamic multi-domain routing (Phase 5): each request kind maps to the
// verifier for its VerificationFloor, so runCeilingAgent's retry loop stays
// domain-agnostic - adding a new floor means adding one entry here, not a
// new branch in the loop itself.
const VERIFIERS: Record<
  CeilingRequestKind,
  (request: CeilingRequest, candidate: string, onGateComplete?: GateCompleteHook) => Promise<GateCheckResult[]> | GateCheckResult[]
> = {
  instruction: (request, candidate, onGateComplete) => verifyInstructionCandidate(request.description, candidate, onGateComplete),
  patch: (_request, candidate) => verifyPatchCandidate(candidate),
  topology: (_request, candidate, onGateComplete) => verifyTopologyCandidate(candidate, onGateComplete),
  claim: (_request, candidate, onGateComplete) => verifyClaimCandidate(candidate, onGateComplete),
  spatial: (_request, candidate, onGateComplete) => verifySpatialCandidate(candidate, onGateComplete),
  brep: (_request, candidate, onGateComplete) => verifyBRepCandidate(candidate, onGateComplete),
}

// ---------------------------------------------------------------------------
// Phase 6: opt-in Best-of-N parallel sampling (ROADMAP.md §2 Layer 3),
// driven through src/layer3/sampler.ts's ParallelCandidateSampler - which
// itself drives the REAL generic VerificationFloor contract
// (src/verification-floor.ts), not a bespoke one-off. Off by default
// (options.bestOfN undefined -> the original sequential single-candidate
// loop, byte-identical to before Phase 6), so every existing caller and
// every ScriptedLlmClient-based test above - which assumes exactly one LLM
// call per attempt - is completely unaffected.
//
// runBestOfNRound wraps VERIFIERS[request.kind] (the SAME per-domain
// verifier the sequential path already uses) in a throwaway single-gate
// VerificationFloor<string, string> just to satisfy evaluateBestOfN's
// signature - the real, granular GateCheckResult[] for the round's chosen
// candidate is cached by candidate text (gatesByCandidate) rather than
// re-derived from that synthetic gate, so callers still see real gate names
// ('static'/'fuzz'/'symbolic', 'exports'/'types'/'reachability', etc.), never
// the synthetic 'combined' label. When no sampled candidate passes, the
// closest-to-passing candidate's REAL failed gate is pushed into `history`
// exactly like the sequential path would - the existing closed-loop
// self-healing (buildPrompt reading `history` on the next round) is what
// actually consumes that feedback; Phase 6 only changes how many diverse
// candidates feed it per round, not the healing mechanism itself.
// ---------------------------------------------------------------------------

export interface BestOfNOptions {
  sampleSize?: number
  baseTemperature?: number
  temperatureStrategy?: TemperatureStrategy
  /** Phase 9: verify candidates across real OS threads (WorkerPoolEvaluator,
   *  src/layer1/worker-pool.ts) instead of in-process - or, since Phase
   *  14.0, across real remote machines (DistributedWorkerPoolEvaluator,
   *  src/layer1/distributed/distributed-worker-pool.ts). Both satisfy the
   *  same WorkerPoolLike interface, so this widened type is the ONLY
   *  change distribution required here - runCeilingAgent's own logic is
   *  untouched. The caller owns the pool's lifecycle (create once, reuse
   *  across many runCeilingAgent calls, shut down when done) -
   *  runCeilingAgent never spawns or closes workers itself. Only routes
   *  'topology'/'claim' to the pool by default (see WORKER_DOMAIN_BY_KIND)
   *  - 'instruction'/'spatial'/'patch' always verify in-process regardless
   *  of whether a pool is supplied. */
  workerPool?: WorkerPoolLike
}

// Phase 9.1: selective per-domain routing, not "offload everything the
// worker CAN run." The live benchmark (scripts/benchmark-sampler.ts)
// measured offloading as a net loss for two of the four candidate domains:
//   - 'instruction': z3-solver's WASM module initializes fresh per worker
//     thread (never shared - see WorkerPoolEvaluator's own doc comment),
//     and that per-worker init cost dwarfs an already-fast in-process Z3
//     check (measured: 30.7ms -> 196ms).
//   - 'spatial': pure-JS SDF math was already so cheap (~1.8ms) that
//     message-passing overhead alone isn't worth paying.
//   - 'topology'/'claim': real ts-morph Project creation IS genuinely
//     CPU-heavy enough that real OS-thread parallelism pays for itself
//     (measured: 782ms -> 425ms, 3482ms -> 1470ms) - only these two route
//     through the pool. 'patch' is absent entirely: it has no dedicated
//     floor module for a worker to import.
const WORKER_DOMAIN_BY_KIND: Partial<Record<CeilingRequestKind, WorkerDomain>> = {
  topology: 'topology',
  claim: 'claim',
}

async function runSingleCandidateRound(
  request: CeilingRequest,
  llm: LlmClient,
  history: CeilingAttempt[],
  onGateComplete?: GateCompleteHook
): Promise<{ candidate: string; gates: GateCheckResult[] }> {
  const candidate = await llm.complete(buildPrompt(request, history))
  const gates = await VERIFIERS[request.kind](request, candidate, onGateComplete)
  return { candidate, gates }
}

async function runBestOfNRound(
  request: CeilingRequest,
  llm: LlmClient,
  history: CeilingAttempt[],
  bestOfN: BestOfNOptions,
  tracer?: EngineTracer
): Promise<{ candidate: string; gates: GateCheckResult[] }> {
  const gatesByCandidate = new Map<string, GateCheckResult[]>()

  const floor: VerificationFloor<string, string> = {
    domain: request.kind,
    gates: [
      {
        name: 'combined',
        check: async (candidateText) => {
          let gates = gatesByCandidate.get(candidateText)
          if (!gates) {
            gates = await VERIFIERS[request.kind](request, candidateText)
            gatesByCandidate.set(candidateText, gates)
          }
          const failed = gates.find((g) => !g.ok)
          return failed
            ? { gate: failed.gate, ok: false, details: failed.details }
            : { gate: 'combined', ok: true, details: `all ${gates.length} gate(s) passed` }
        },
      },
    ],
  }

  // When workerPool is provided, candidates for the four offloadable domains
  // are verified on a worker thread - which computes gates via the REAL
  // per-domain floor directly, so `report.gates` there is already the full
  // granular array (not the synthetic 'combined' gate above). gatesByCandidate
  // only gets populated when the worker path itself falls back to this
  // synthetic floor (pool unavailable, task unsupported, timeout, crash) -
  // so the final lookup below prefers the cache, then falls back to
  // whatever the sampler actually reports, correctly covering both paths.
  const workerOffload: WorkerOffload<string> | undefined = bestOfN.workerPool
    ? {
        pool: bestOfN.workerPool,
        toTask: (candidateText) => {
          const domain = WORKER_DOMAIN_BY_KIND[request.kind]
          if (!domain) return null
          return domain === 'instruction' ? { domain, candidateText, x86Instruction: request.description } : { domain, candidateText }
        },
      }
    : undefined

  const sampler = new ParallelCandidateSampler<string>(
    {
      sampleSize: bestOfN.sampleSize ?? 4,
      baseTemperature: bestOfN.baseTemperature ?? 0.2,
      temperatureStrategy: bestOfN.temperatureStrategy ?? 'stepped',
      earlyExitOnSuccess: true,
    },
    workerOffload,
    tracer
  )

  const prompt = buildPrompt(request, history)
  const result = await sampler.evaluateBestOfN((temperature) => llm.complete(prompt, temperature), floor)

  const winner = result.selected
  if (!winner) {
    throw new Error(`runBestOfNRound: sampler produced no candidates (sampleSize=${bestOfN.sampleSize ?? 4})`)
  }

  const candidate = winner.candidate.payload
  const gates = gatesByCandidate.get(candidate) ?? winner.report.gates
  return { candidate, gates }
}

// Phase 10: Layer 5 Meta-Kernel (src/layer5/meta-kernel.ts) - checked before
// each round AFTER the first (there is nothing to match on attempt 1, since
// no failure has occurred yet). If the current failure's pattern has a
// learned rule AND applying it produces a candidate that genuinely passes
// real floor verification, the round resolves with zero additional LLM
// calls. A matching rule that produces a still-failing candidate is not
// trusted blindly - it just falls through to the normal LLM-driven round,
// exactly as if no rule had matched; the meta-kernel can only ever save
// work, never fabricate a false success (verification always has the final
// say). Learning happens symmetrically: whenever a round succeeds via the
// normal LLM path after at least one real failure, the fix that resolved it
// is recorded so a future, different-but-same-shape failure can be
// bypassed next time.
async function tryMetaKernelBypass(
  request: CeilingRequest,
  history: CeilingAttempt[],
  metaKernel: MetaKernelCompiler,
  tracer?: EngineTracer
): Promise<{ candidate: string; gates: GateCheckResult[] } | null> {
  if (history.length === 0) return null

  const lastFailure = history[history.length - 1]
  const pattern = classifyFailurePattern(request.kind, lastFailure.failedGate, lastFailure.candidate)
  const patched = metaKernel.tryMatchRule(pattern, { failingCandidate: lastFailure.candidate, failedGate: lastFailure.failedGate })
  // "hit" means a compiled rule was found for this pattern - independent of
  // whether the resulting candidate goes on to actually pass verification
  // below, which is tracked separately via the gate spans that follow.
  tracer?.recordMetaKernelCheck(patched !== null, patched !== null ? pattern : undefined)
  if (patched === null) return null

  const onGateComplete: GateCompleteHook | undefined = tracer
    ? (gate, elapsedMs) => tracer.recordFloorGate(gate.gate, gate.ok, elapsedMs, gate.ok ? undefined : gate.details)
    : undefined
  const gates = await VERIFIERS[request.kind](request, patched, onGateComplete)
  return gates.some((g) => !g.ok) ? null : { candidate: patched, gates }
}

export async function runCeilingAgent(
  request: CeilingRequest,
  llm: LlmClient,
  options: {
    maxRetries?: number
    bestOfN?: BestOfNOptions
    metaKernel?: MetaKernelCompiler
    tracer?: EngineTracer
    /** Phase 11.4: attach a CLI/JSON/Markdown-renderable FormattedEngineResponse
     *  (src/telemetry/output-formatter.ts) to the result as `formatted`. Off by
     *  default - every existing caller's CeilingSuccess/CeilingAgentExhaustedError
     *  shape is unchanged. */
    formatResponse?: boolean
  } = {}
): Promise<CeilingSuccess> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES_DEFAULT
  const history: CeilingAttempt[] = []

  if (options.tracer) {
    options.tracer.startTrace(randomUUID(), request.kind)
  }
  const onGateComplete: GateCompleteHook | undefined = options.tracer
    ? (gate, elapsedMs) => options.tracer!.recordFloorGate(gate.gate, gate.ok, elapsedMs, gate.ok ? undefined : gate.details)
    : undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const bypass = options.metaKernel ? await tryMetaKernelBypass(request, history, options.metaKernel, options.tracer) : null

    const { candidate, gates } = bypass
      ? bypass
      : options.bestOfN
        ? await runBestOfNRound(request, llm, history, options.bestOfN, options.tracer)
        : await runSingleCandidateRound(request, llm, history, onGateComplete)

    const failedGate = gates.find((g) => !g.ok)
    if (!failedGate) {
      if (!bypass && options.metaKernel && history.length > 0) {
        const lastFailure = history[history.length - 1]
        const pattern = classifyFailurePattern(request.kind, lastFailure.failedGate, lastFailure.candidate)
        options.metaKernel.recordFix(pattern, derivePatch(pattern, lastFailure.candidate, candidate))
      }
      const success: CeilingSuccess = { ok: true, result: candidate, attempts: attempt, gates, history: [...history] }
      if (options.formatResponse) {
        // Ground-truth resolvedLayer from this loop's own control flow -
        // never inferred from the trace after the fact (see
        // output-formatter.ts's header comment for why that's ambiguous).
        const resolvedLayer: ResolvedLayer = bypass
          ? 'layer5-meta-kernel'
          : options.bestOfN
            ? 'layer3-sampler'
            : attempt > 1
              ? 'layer4-healing'
              : 'layer1-floor'
        success.formatted = formatEngineResponse({ ok: true, success, resolvedLayer }, options.tracer)
      }
      return success
    }
    history.push({ attempt, candidate, failedGate })
  }

  const failure: CeilingFailureReport = { request, attempts: maxRetries, history }
  if (options.formatResponse) {
    failure.formatted = formatEngineResponse({ ok: false, failure }, options.tracer)
  }
  throw new CeilingAgentExhaustedError(failure)
}
