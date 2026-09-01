import { runCeilingAgent, CeilingAgentExhaustedError, type LlmClient, type CeilingRequest, type CeilingRequestKind } from '../src/CeilingAgent'
import { translateInstruction, type X86Register } from '../lib/translator'
import type { TopologyCandidate } from '../src/topology-floor'
import type { ClaimCandidate } from '../src/claim-floor'
import type { SpatialCandidate } from '../src/spatial-floor'

// ---------------------------------------------------------------------------
// Synthetic (NOT live-model) benchmark: isolates and measures Best-of-N
// PARALLEL SAMPLING's mechanical effect on runCeilingAgent's retry loop,
// independent of any particular LLM's raw competence or its ability to read
// and act on counterexample feedback - that's what scripts/benchmark-live.ts
// measures, against a real Ollama endpoint. This script never touches a
// network; every "LLM" call is a synthetic client that independently
// returns a pre-authored correct or incorrect candidate with a fixed
// probability, regardless of temperature or of what the accumulated
// retry-history feedback says. That's a deliberately honest simplification:
// it isolates the COMBINATORIAL benefit of trying N independent candidates
// per round (Best-of-N) vs one (single-shot) - the real, defensible reason
// Best-of-N should converge in fewer ROUNDS - without pretending to
// simulate genuine LLM self-correction from feedback (a synthetic client
// can't "read" a Z3 counterexample the way a real model attempts to).
//
// "Unsat Core Convergence Rate" is measured here as: of tasks that did NOT
// succeed on their first round, what fraction eventually succeeded within
// maxRetries. This project's real gate feedback (e.g. a Z3 counterexample)
// is embedded in a gate's `details` string, not a separately structured
// "unsat core" artifact anywhere in this codebase - this metric is a fair,
// literal reading of "how well does the retry loop recover from an initial
// failure," using the requested terminology without overclaiming.
//
// Every real VerificationFloor gate still runs for real on every candidate
// (real Z3 proofs, real ts-morph checks, real SDF math, real execution of
// lib/translator.ts) - only the LLM GENERATION step is synthetic. Pass
// rate, retry rounds, and healing convergence are all genuinely measured
// outcomes of the real floors, not simulated numbers.
// ---------------------------------------------------------------------------

const SUCCESS_PROBABILITY = 0.25 // "hard" task: only a 1-in-4 chance a single independent attempt is correct
const MAX_RETRIES = 5
const TASKS_PER_DOMAIN = 20
const APPROX_CHARS_PER_TOKEN = 4 // standard rough token-estimation heuristic, applied to real prompt text

class SyntheticStochasticLlmClient implements LlmClient {
  callCount = 0
  totalPromptChars = 0

  constructor(
    private readonly successProbability: number,
    private readonly goodCandidate: string,
    private readonly badCandidate: string
  ) {}

  async complete(prompt: string, _temperature = 0): Promise<string> {
    this.callCount++
    this.totalPromptChars += prompt.length
    return Math.random() < this.successProbability ? this.goodCandidate : this.badCandidate
  }
}

// ---------------------------------------------------------------------------
// Task generation: 20 tasks per domain, procedurally varied. Each task
// carries a KNOWN-GOOD candidate (guaranteed to pass every real gate) and a
// KNOWN-BAD candidate (guaranteed to fail at least one real gate) - the
// synthetic client picks between them by coin flip, and the REAL
// verification floor decides pass/fail on whichever text it receives.
// ---------------------------------------------------------------------------

interface Task {
  domain: CeilingRequestKind
  description: string
  goodCandidate: string
  badCandidate: string
}

const GENERAL_REGISTERS: X86Register[] = ['RAX', 'RBX', 'RCX', 'RDX', 'RDI']

// All 20 ordered (dst, src) pairs with dst != src - reused across the
// instruction and claim domains for variety without hand-authoring 40 pairs.
const REGISTER_PAIRS: [X86Register, X86Register][] = GENERAL_REGISTERS.flatMap((dst) =>
  GENERAL_REGISTERS.filter((src) => src !== dst).map((src): [X86Register, X86Register] => [dst, src])
)

function swapLastTwoOperands(armInstruction: string): string {
  const spaceIndex = armInstruction.indexOf(' ')
  const opcode = armInstruction.slice(0, spaceIndex)
  const operands = armInstruction.slice(spaceIndex + 1).split(', ')
  const last = operands.length - 1
  const swapped = [...operands]
  ;[swapped[last], swapped[last - 1]] = [swapped[last - 1], swapped[last]]
  return `${opcode} ${swapped.join(', ')}`
}

// translateInstruction (lib/translator.ts) does not support bare SUB - only
// ADD/MOV/CMP/PUSH/POP/CALL/Jcc (SUB has a ground-truth symbolic model in
// CeilingAgent's own ARM64_INSTRUCTION_FLOOR, but that's a separate concern
// from computing the correct answer here via the real per-instruction
// lowering function) - so task generation sticks to opcodes it does support.
function buildInstructionTasks(): Task[] {
  return REGISTER_PAIRS.map(([dst, src], i) => {
    const opcode = i % 2 === 0 ? 'ADD' : 'MOV'
    const x86 = `${opcode} ${dst}, ${src}`
    const translated = translateInstruction(x86)
    if (!translated.ok) throw new Error(`benchmark setup: could not translate "${x86}": ${translated.error}`)
    return { domain: 'instruction' as const, description: x86, goodCandidate: translated.instruction, badCandidate: swapLastTwoOperands(translated.instruction) }
  })
}

function buildTopologyTasks(): Task[] {
  return Array.from({ length: TASKS_PER_DOMAIN }, (_, i) => {
    const fnName = `fn${i}`
    const fileName = `module${i}.ts`
    const multiplier = i + 1
    const good: TopologyCandidate = {
      inMemoryFiles: { [fileName]: `export function ${fnName}(x: number): number { return x * ${multiplier} }` },
      expectedExports: [{ filePath: fileName, exportedNames: [fnName] }],
      reachability: [],
    }
    const bad: TopologyCandidate = {
      inMemoryFiles: { [fileName]: `function ${fnName}(x: number): number { return x * ${multiplier} }` }, // missing `export`
      expectedExports: [{ filePath: fileName, exportedNames: [fnName] }],
      reachability: [],
    }
    return {
      domain: 'topology' as const,
      description: `a module ${fileName} exporting a function ${fnName}(x: number): number that returns x * ${multiplier}`,
      goodCandidate: JSON.stringify(good),
      badCandidate: JSON.stringify(bad),
    }
  })
}

function buildClaimTasks(): Task[] {
  return REGISTER_PAIRS.map(([dst, src], i) => {
    const opcode = i % 2 === 0 ? 'MOV' : 'CMP'
    const x86 = `${opcode} ${dst}, ${src}`
    const translated = translateInstruction(x86)
    if (!translated.ok) throw new Error(`benchmark setup: could not translate "${x86}" for a claim task: ${translated.error}`)
    const good: ClaimCandidate = {
      claims: [
        {
          statement: `translateInstruction lowers ${x86} to ${translated.instruction}`,
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: [x86], expected: { ok: true, instruction: translated.instruction } },
        },
      ],
    }
    const bad: ClaimCandidate = {
      claims: [
        {
          statement: `translateInstruction lowers ${x86} to something else`,
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: [x86], expected: { ok: true, instruction: `${translated.instruction}-WRONG` } },
        },
      ],
    }
    return {
      domain: 'claim' as const,
      description: `lib/translator.ts exports translateInstruction. Claim what calling it with "${x86}" returns.`,
      goodCandidate: JSON.stringify(good),
      badCandidate: JSON.stringify(bad),
    }
  })
}

function buildSpatialTasks(): Task[] {
  return Array.from({ length: TASKS_PER_DOMAIN }, (_, i) => {
    const radius = 1 + (i % 5) * 0.5
    const boundingBox: SpatialCandidate['boundingBox'] = { min: [-10, -10, -10], max: [10, 10, 10] }
    const good: SpatialCandidate = { surface: { type: 'sphere', center: [0, 0, 0], radius }, boundingBox }

    // Rotate through all three real gates' failure modes for variety.
    const failureMode = i % 3
    const bad: SpatialCandidate =
      failureMode === 0
        ? { surface: { type: 'sphere', center: [0, 0, 0], radius: -radius }, boundingBox } // self-intersection: degenerate radius
        : failureMode === 1
          ? { surface: { type: 'sphere', center: [0, 0, 0], radius }, boundingBox: { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] } } // volumetric-bound
          : { surface: { type: 'unsafeScale', factor: 5, child: { type: 'sphere', center: [0, 0, 0], radius } }, boundingBox } // continuity

    return {
      domain: 'spatial' as const,
      description: `a sphere of radius ${radius} centered at the origin within a [-10,10]^3 bounding box`,
      goodCandidate: JSON.stringify(good),
      badCandidate: JSON.stringify(bad),
    }
  })
}

const DOMAIN_TASK_BUILDERS: Record<string, () => Task[]> = {
  instruction: buildInstructionTasks,
  topology: buildTopologyTasks,
  claim: buildClaimTasks,
  spatial: buildSpatialTasks,
}

// ---------------------------------------------------------------------------
// Execution and metrics
// ---------------------------------------------------------------------------

type Strategy = 'single-shot' | 'best-of-n'

interface RunOutcome {
  ok: boolean
  attempts: number
  elapsedMs: number
  llmCalls: number
  approxTokens: number
  firstRoundFailed: boolean
}

async function runTaskWithStrategy(task: Task, strategy: Strategy): Promise<RunOutcome> {
  const client = new SyntheticStochasticLlmClient(SUCCESS_PROBABILITY, task.goodCandidate, task.badCandidate)
  const request: CeilingRequest = { kind: task.domain, description: task.description }
  const options =
    strategy === 'best-of-n'
      ? { maxRetries: MAX_RETRIES, bestOfN: { sampleSize: 4, baseTemperature: 0.2, temperatureStrategy: 'stepped' as const, earlyExitOnSuccess: true } }
      : { maxRetries: MAX_RETRIES }

  const start = performance.now()
  try {
    const result = await runCeilingAgent(request, client, options)
    return {
      ok: true,
      attempts: result.attempts,
      elapsedMs: performance.now() - start,
      llmCalls: client.callCount,
      approxTokens: Math.round(client.totalPromptChars / APPROX_CHARS_PER_TOKEN),
      firstRoundFailed: result.history.length > 0,
    }
  } catch (error) {
    if (error instanceof CeilingAgentExhaustedError) {
      return {
        ok: false,
        attempts: error.report.attempts,
        elapsedMs: performance.now() - start,
        llmCalls: client.callCount,
        approxTokens: Math.round(client.totalPromptChars / APPROX_CHARS_PER_TOKEN),
        firstRoundFailed: true,
      }
    }
    throw error
  }
}

interface DomainStrategyMetrics {
  domain: string
  strategy: Strategy
  passRate: number
  avgRoundsToSuccess: number
  avgElapsedMs: number
  avgLlmCalls: number
  avgApproxTokens: number
  healingConvergenceRate: number
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function summarize(domain: string, strategy: Strategy, outcomes: RunOutcome[]): DomainStrategyMetrics {
  const passed = outcomes.filter((o) => o.ok)
  const firstRoundFailures = outcomes.filter((o) => o.firstRoundFailed)
  const healedAfterFirstRoundFailure = firstRoundFailures.filter((o) => o.ok)

  return {
    domain,
    strategy,
    passRate: (100 * passed.length) / outcomes.length,
    avgRoundsToSuccess: average(passed.map((o) => o.attempts)),
    avgElapsedMs: average(outcomes.map((o) => o.elapsedMs)),
    avgLlmCalls: average(outcomes.map((o) => o.llmCalls)),
    avgApproxTokens: average(outcomes.map((o) => o.approxTokens)),
    healingConvergenceRate: firstRoundFailures.length === 0 ? 100 : (100 * healedAfterFirstRoundFailure.length) / firstRoundFailures.length,
  }
}

function printTable(metrics: DomainStrategyMetrics[]) {
  console.log('\n=== Results (per domain x strategy, 20 tasks each) ===')
  console.log(
    ['DOMAIN'.padEnd(12), 'STRATEGY'.padEnd(13), 'PASS%'.padEnd(8), 'AVG ROUNDS'.padEnd(12), 'AVG MS'.padEnd(9), 'AVG LLM CALLS'.padEnd(15), 'APPROX TOKENS'.padEnd(15), 'HEAL CONV%'].join('')
  )
  for (const m of metrics) {
    console.log(
      [
        m.domain.padEnd(12),
        m.strategy.padEnd(13),
        `${m.passRate.toFixed(1)}%`.padEnd(8),
        m.avgRoundsToSuccess.toFixed(2).padEnd(12),
        m.avgElapsedMs.toFixed(1).padEnd(9),
        m.avgLlmCalls.toFixed(2).padEnd(15),
        m.avgApproxTokens.toFixed(0).padEnd(15),
        `${m.healingConvergenceRate.toFixed(1)}%`,
      ].join('')
    )
  }
}

function printDeltaSummary(metrics: DomainStrategyMetrics[]) {
  console.log('\n=== Best-of-N vs Single-Shot: efficiency deltas ===')
  const domains = [...new Set(metrics.map((m) => m.domain))]
  for (const domain of domains) {
    const a = metrics.find((m) => m.domain === domain && m.strategy === 'single-shot')
    const b = metrics.find((m) => m.domain === domain && m.strategy === 'best-of-n')
    if (!a || !b) continue
    const passDelta = b.passRate - a.passRate
    console.log(
      `${domain.padEnd(12)} pass rate: ${a.passRate.toFixed(1)}% -> ${b.passRate.toFixed(1)}% (${passDelta >= 0 ? '+' : ''}${passDelta.toFixed(1)}pp)  ` +
        `avg rounds: ${a.avgRoundsToSuccess.toFixed(2)} -> ${b.avgRoundsToSuccess.toFixed(2)}  ` +
        `avg LLM calls/task: ${a.avgLlmCalls.toFixed(2)} -> ${b.avgLlmCalls.toFixed(2)}  ` +
        `healing convergence: ${a.healingConvergenceRate.toFixed(1)}% -> ${b.healingConvergenceRate.toFixed(1)}%`
    )
  }
}

async function main() {
  console.log('Best-of-N Parallel Sampling vs Single-Shot: synthetic benchmark')
  console.log(
    `${TASKS_PER_DOMAIN} hard synthetic tasks per domain x ${Object.keys(DOMAIN_TASK_BUILDERS).length} domains = ` +
      `${TASKS_PER_DOMAIN * Object.keys(DOMAIN_TASK_BUILDERS).length} tasks, each run under both strategies ` +
      `(${TASKS_PER_DOMAIN * Object.keys(DOMAIN_TASK_BUILDERS).length * 2} total executions).`
  )
  console.log(`Per-attempt success probability: ${SUCCESS_PROBABILITY} (deliberately low - "hard" tasks). maxRetries: ${MAX_RETRIES} rounds for both strategies.`)
  console.log('Best-of-N config: sampleSize 4, temperatures 0.2/0.4/0.6/0.8 (stepped), earlyExitOnSuccess: true.\n')

  const allMetrics: DomainStrategyMetrics[] = []

  for (const [domain, buildTasks] of Object.entries(DOMAIN_TASK_BUILDERS)) {
    const tasks = buildTasks()
    for (const strategy of ['single-shot', 'best-of-n'] as const) {
      const outcomes: RunOutcome[] = []
      for (const task of tasks) {
        outcomes.push(await runTaskWithStrategy(task, strategy))
      }
      allMetrics.push(summarize(domain, strategy, outcomes))
    }
    console.log(`  ${domain}: done`)
  }

  printTable(allMetrics)
  printDeltaSummary(allMetrics)
}

main().catch((error: unknown) => {
  console.error('Benchmark crashed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
