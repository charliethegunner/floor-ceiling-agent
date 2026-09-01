import type { FloorReport } from '../verification-floor'
import type { WorkerVerifyTask } from '../layer1/worker-pool'
import type { WorkerPoolLike } from '../layer1/worker-pool-like'

// Layer 3 (ROADMAP.md §2/§5): Best-of-N parallel candidate sampling. These
// types drive src/verification-floor.ts's REAL generic VerificationFloor
// contract (gates array + GateOutcome, src/verification-floor.ts) - not the
// single-verify()/autoformalize() shape sketched in ROADMAP.md §4, which has
// no implementation anywhere in this codebase. Any existing floor
// (TOPOLOGY_FLOOR, CLAIM_VERIFICATION_FLOOR, or the ARM64 instruction floor)
// can drive a ParallelCandidateSampler as-is.

export type TemperatureStrategy = 'fixed' | 'stepped' | 'random'

export interface SamplerConfig {
  sampleSize: number
  baseTemperature: number
  temperatureStrategy: TemperatureStrategy
  /** Stop waiting once any candidate's floor fully passes - the results of
   *  still-in-flight candidates are discarded, not awaited. */
  earlyExitOnSuccess: boolean
}

export interface Candidate<TCandidate> {
  index: number
  temperature: number
  payload: TCandidate
}

export interface CandidateEvaluation<TCandidate, GateName extends string = string> {
  candidate: Candidate<TCandidate>
  report: FloorReport<GateName>
  score: number
  elapsedMs: number
}

export interface BestOfNResult<TCandidate, GateName extends string = string> {
  ok: boolean
  selected?: CandidateEvaluation<TCandidate, GateName>
  evaluations: CandidateEvaluation<TCandidate, GateName>[]
  totalElapsedMs: number
}

// Optional Phase 9 CPU-parallel offload: when supplied, evaluateBestOfN
// tries to run each candidate's floor check on a WorkerPoolEvaluator
// (src/layer1/worker-pool.ts) instead of in-process. `toTask` maps a
// candidate to the worker's {domain, candidateText} request shape - return
// null for a candidate/floor combination the worker pool doesn't support
// (e.g. a domain the pool has no registry entry for), and the sampler
// transparently falls back to the existing in-process runVerificationFloor
// path, exactly as if no workerOffload had been configured at all.
export interface WorkerOffload<TCandidate> {
  pool: WorkerPoolLike
  toTask: (candidate: TCandidate) => WorkerVerifyTask | null
}
