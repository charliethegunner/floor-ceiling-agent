import { runVerificationFloor, type VerificationFloor, type FloorReport } from '../verification-floor'
import type { SamplerConfig, Candidate, CandidateEvaluation, BestOfNResult } from './types'

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

  constructor(config: Partial<SamplerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
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

    return new Promise((resolve) => {
      const settled: CandidateEvaluation<TCandidate, GateName>[] = []
      let remaining = pending.length
      pending.forEach((promise) => {
        promise.then((evalItem) => {
          settled.push(evalItem)
          remaining--
          if (evalItem.report.ok || remaining === 0) resolve(settled)
        })
      })
    })
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
      const report = await runVerificationFloor(floor, payload)
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
