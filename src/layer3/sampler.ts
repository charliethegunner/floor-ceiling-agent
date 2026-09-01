import { runVerificationFloor, type VerificationFloor, type FloorReport, type GateOutcome } from '../verification-floor'
import type { SamplerConfig, Candidate, CandidateEvaluation, BestOfNResult, WorkerOffload } from './types'
import type { EngineTracer } from '../telemetry/tracer'

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
  private readonly tracer?: EngineTracer

  constructor(config: Partial<SamplerConfig> = {}, workerOffload?: WorkerOffload<TCandidate>, tracer?: EngineTracer) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.workerOffload = workerOffload
    this.tracer = tracer
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
  //
  // onGateComplete (Phase 11.1) is forwarded from BOTH branches with real
  // measured latency - the worker branch's timing comes from
  // WorkerGateOutcome.elapsedMs, genuinely measured inside the worker
  // thread by worker-pool-worker.ts's own runVerificationFloor call, not
  // approximated after the fact from the round-trip time.
  private async runFloor(
    floor: VerificationFloor<TCandidate, GateName>,
    payload: TCandidate,
    onGateComplete?: (gate: GateOutcome<GateName>, elapsedMs: number) => void
  ): Promise<FloorReport<GateName>> {
    const runLocally = async (): Promise<GateOutcome<GateName>[]> => {
      const timings: Array<{ gate: GateOutcome<GateName>; elapsedMs: number }> = []
      await runVerificationFloor(floor, payload, (gate, elapsedMs) => timings.push({ gate, elapsedMs }))
      timings.forEach(({ gate, elapsedMs }) => onGateComplete?.(gate, elapsedMs))
      return timings.map(({ gate }) => gate)
    }

    if (this.workerOffload) {
      const task = this.workerOffload.toTask(payload)
      if (task) {
        const gates = await this.workerOffload.pool.verify(task, runLocally)
        for (const gate of gates) {
          onGateComplete?.(gate as GateOutcome<GateName>, (gate as { elapsedMs?: number }).elapsedMs ?? 0)
        }
        return { ok: gates.every((g) => g.ok), domain: floor.domain, gates: gates as GateOutcome<GateName>[] }
      }
    }

    const gates = await runLocally()
    return { ok: gates.every((g) => g.ok), domain: floor.domain, gates }
  }

  async evaluateBestOfN(
    generatorFn: (temperature: number, index: number) => Promise<TCandidate>,
    floor: VerificationFloor<TCandidate, GateName>
  ): Promise<BestOfNResult<TCandidate, GateName>> {
    const start = Date.now()
    const temperatures = this.computeTemperatures()

    // Buffers each candidate's real per-gate timing by index, so that
    // AFTER the winner is chosen, only ITS gates get replayed into the
    // tracer as real floor_gate spans - not every rejected sample's, which
    // would make Best-of-N traces N times noisier than the single-shot path
    // for no benefit (only the winner's gates actually decided the result).
    const gateTimingsByIndex = this.tracer ? new Map<number, Array<{ gate: GateOutcome<GateName>; elapsedMs: number }>>() : undefined

    const evaluate = async (temperature: number, index: number): Promise<CandidateEvaluation<TCandidate, GateName>> => {
      const payload = await generatorFn(temperature, index)
      const candidate: Candidate<TCandidate> = { index, temperature, payload }
      const onGateComplete = gateTimingsByIndex
        ? (gate: GateOutcome<GateName>, elapsedMs: number) => {
            const timings = gateTimingsByIndex.get(index) ?? []
            timings.push({ gate, elapsedMs })
            gateTimingsByIndex.set(index, timings)
          }
        : undefined
      const gateStart = Date.now()
      const report = await this.runFloor(floor, payload, onGateComplete)
      const elapsedMs = Date.now() - gateStart
      return { candidate, report, score: this.score(report, elapsedMs), elapsedMs }
    }

    const evaluations = await this.runEvaluations(temperatures, evaluate)
    evaluations.sort((a, b) => b.score - a.score)
    const selected = evaluations.find((e) => e.report.ok) ?? evaluations[0]

    // "Short-circuited" means early exit actually saved work this round -
    // it resolved before every sampled candidate settled, not merely that
    // the option was enabled.
    const shortCircuited = this.config.earlyExitOnSuccess && evaluations.length < temperatures.length
    this.tracer?.recordSamplerRun(evaluations.length, selected?.candidate.temperature, shortCircuited)

    if (this.tracer && selected && gateTimingsByIndex) {
      const timings = gateTimingsByIndex.get(selected.candidate.index) ?? []
      for (const { gate, elapsedMs } of timings) {
        this.tracer.recordFloorGate(gate.gate, gate.ok, elapsedMs, gate.ok ? undefined : gate.details)
      }
    }

    return {
      ok: evaluations.some((e) => e.report.ok),
      selected,
      evaluations,
      totalElapsedMs: Date.now() - start,
    }
  }
}
