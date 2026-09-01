import type { FloorReport } from '../verification-floor'

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
