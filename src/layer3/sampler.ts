import { runVerificationFloor, type VerificationFloor, type FloorReport, type GateOutcome } from '../verification-floor'
import type { SamplerConfig, Candidate, CandidateEvaluation, BestOfNResult, WorkerOffload } from './types'

const DEFAULT_CONFIG: SamplerConfig = {
  sampleSize: 3,
  baseTemperature: 0.2,
  temperatureStrategy: 'stepped',
  earlyExitOnSuccess: true,
}

// Best-of-N parallel candidate sampling (ROADMAP.md §2 Layer 3), adapted to
// drive src/verification-floor.ts's real gates-array VerificationFloor
// contract - the same one CeilingAgent.ts's self-healing retry loop already
// uses, generalized here from "retry sequentially on failure" to "generate N
// candidates up front and pick the best one." Any VerificationFloor can be
// passed in unchanged.
export class ParallelCandidateSampler<TCandidate, GateName extends string = string> {
  private readonly config: SamplerConfig
  private readonly workerOffload?: WorkerOffload<TCandidate>

  constructor(config: Partial<SamplerConfig> = {}, workerOffload?: WorkerOffload<TCandidate>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.workerOffload = workerOffload
  }

  private computeTemperatures(): number[] {
    const { sampleSize, baseTemperature, temperatureStrategy } = this.config
    const temperatures: number[] = []
    for (let i = 0; i < sampleSize; i++) {
      if (temperatureStrategy === 'fixed') {
        temperatures.push(baseTemperature)
      } else if (temperatureStrategy === 'stepped') {
        temperatures.push(Math.min(1, baseTemperature + i * 0.2))
      } else {
        temperatures.push(Math.random())
      }
    }
    return temperatures
  }

  // Ranks primarily by fraction of gates passed - a fully-passing candidate
  // is always preferred outright via evaluateBestOfN's `.find(ok)`, so this
  // score mainly orders non-passing candidates ("closest to passing" first)
  // and breaks ties among multiple passing candidates by speed.
  private score(report: FloorReport<GateName>, elapsedMs: number): number {
    const passed = report.gates.filter((g) => g.ok).length
    const passRatio = report.gates.length === 0 ? (report.ok ? 1 : 0) : passed / report.gates.length
    return passRatio - elapsedMs / 1_000_000
  }

  private async runEvaluations(
    temperatures: number[],
    evaluate: (temperature: number, index: number) => Promise<CandidateEvaluation<TCandidate, GateName>>
  ): Promise<CandidateEvaluation<TCandidate, GateName>[]> {
    const pending = temperatures.map((temperature, index) => evaluate(temperature, index))
    if (!this.config.earlyExitOnSuccess) return Promise.all(pending)

    // A rejecting candidate (generatorFn or verification itself throwing -
    // e.g. a real LLM network error, not just a failed verification) must
    // still count toward `remaining` reaching 0, or a round where every
    // candidate rejects would never resolve at all. Its rejection is
    // deliberately swallowed here, not re-thrown: under earlyExitOnSuccess
    // its result was always going to be discarded if a sibling candidate
    // succeeded anyway, and an unhandled promise rejection is worse than
    // silently excluding it from `settled`.
    return new Promise((resolve) => {
      const settled: CandidateEvaluation<TCandidate, GateName>[] = []
      let remaining = pending.length
      pending.forEach((promise) => {
        promise
          .then((evalItem) => {
            settled.push(evalItem)
            remaining--
            if (evalItem.report.ok || remaining === 0) resolve(settled)
          })
          .catch(() => {
            remaining--
            if (remaining === 0) resolve(settled)
          })
      })
    })
  }

  // Routes through WorkerPoolEvaluator when workerOffload is configured AND
  // toTask can express this candidate as a worker task; otherwise (no
  // offload configured, toTask returns null, or the pool itself falls back
  // internally - a dead worker, a timeout, pool shutdown) runs the SAME
  // in-process runVerificationFloor path as before Phase 9. Callers that
  // never pass workerOffload get byte-identical behavior to pre-Phase-9.
  private async runFloor(floor: VerificationFloor<TCandidate, GateName>, payload: TCandidate): Promise<FloorReport<GateName>> {
    const fallback = () => runVerificationFloor(floor, payload)

    if (this.workerOffload) {
      const task = this.workerOffload.toTask(payload)
      if (task) {
        const gates = await this.workerOffload.pool.verify(task, async () => (await fallback()).gates)
        return { ok: gates.every((g) => g.ok), domain: floor.domain, gates: gates as GateOutcome<GateName>[] }
      }
    }

    return fallback()
  }

  async evaluateBestOfN(
    generatorFn: (temperature: number, index: number) => Promise<TCandidate>,
    floor: VerificationFloor<TCandidate, GateName>
  ): Promise<BestOfNResult<TCandidate, GateName>> {
    const start = Date.now()
    const temperatures = this.computeTemperatures()

    const evaluate = async (temperature: number, index: number): Promise<CandidateEvaluation<TCandidate, GateName>> => {
      const payload = await generatorFn(temperature, index)
      const candidate: Candidate<TCandidate> = { index, temperature, payload }
      const gateStart = Date.now()
      const report = await this.runFloor(floor, payload)
      const elapsedMs = Date.now() - gateStart
      return { candidate, report, score: this.score(report, elapsedMs), elapsedMs }
    }

    const evaluations = await this.runEvaluations(temperatures, evaluate)
    evaluations.sort((a, b) => b.score - a.score)
    const selected = evaluations.find((e) => e.report.ok) ?? evaluations[0]

    return {
      ok: evaluations.some((e) => e.report.ok),
      selected,
      evaluations,
      totalElapsedMs: Date.now() - start,
    }
  }
}
