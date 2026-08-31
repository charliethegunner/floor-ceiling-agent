import { runCeilingAgent, CeilingAgentExhaustedError, type LlmClient, type CeilingRequest } from '../src/CeilingAgent'

// Live end-to-end benchmark against a real local Ollama (or any
// OpenAI-compatible /v1/chat/completions) endpoint. Not part of the test
// suite: it makes real network calls, its outcome depends on which model is
// installed, and LLM output is inherently non-deterministic. Run with
// `npm run benchmark`.

interface UsageRecord {
  attempt: number
  promptTokens: number | undefined
  completionTokens: number | undefined
  totalTokens: number | undefined
}

interface OllamaChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

class InstrumentedOllamaClient implements LlmClient {
  readonly usage: UsageRecord[] = []

  constructor(
    private readonly baseUrl: string,
    private readonly model: string
  ) {}

  async complete(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
    })

    if (!response.ok) {
      throw new Error(`Ollama endpoint ${this.baseUrl} returned ${response.status}: ${await response.text()}`)
    }

    const data = (await response.json()) as OllamaChatResponse
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Ollama response missing choices[0].message.content')
    }

    this.usage.push({
      attempt: this.usage.length + 1,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    })

    return content.trim()
  }
}

/**
 * Deterministically corrupts the LAST line of the FIRST response for a task
 * by swapping its last two comma-separated fields - a realistic "which
 * operand goes where" mistake for simple register-register forms - so Gate 3
 * is guaranteed to reject attempt 1 and produce a real Z3 counterexample,
 * regardless of whether the underlying model would have gotten it right
 * unassisted. Every later call for the same task passes the real model's
 * response through unmodified, so the actual self-correction is genuinely
 * driven by the model reading the Z3 feedback, not scripted.
 *
 * Two honest limitations, not fixed here: (1) single-operand forms (RET,
 * `JMP label`, `CALL Xn`, and the x86 source side of PUSH/POP) have nothing
 * to swap, so injection is a no-op for most control-flow tasks - that's
 * fine, since those opcodes have no symbolic ground truth to self-correct
 * against anyway. (2) this splits on every comma, so a bracketed memory
 * operand (`[X1, X2, LSL #2]`) gets split on its INTERNAL comma too, not
 * just the operand-separating one - the result is a malformed line rather
 * than a clean semantic swap, but it still reliably forces attempt 1 to be
 * rejected, which is the only thing this needs to guarantee.
 */
class FaultInjectingLlmClient implements LlmClient {
  private callCount = 0

  constructor(private readonly inner: LlmClient) {}

  async complete(prompt: string): Promise<string> {
    const response = await this.inner.complete(prompt)
    this.callCount++
    return this.callCount === 1 ? injectOperandSwapFault(response) : response
  }
}

function injectOperandSwapFault(candidate: string): string {
  const lines = candidate.split('\n')
  let targetIndex = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      targetIndex = i
      break
    }
  }
  if (targetIndex === -1) return candidate

  const line = lines[targetIndex]
  const spaceIndex = line.indexOf(' ')
  if (spaceIndex === -1) return candidate

  const opcode = line.slice(0, spaceIndex)
  const operands = line
    .slice(spaceIndex + 1)
    .split(',')
    .map((o) => o.trim())
  if (operands.length < 2) return candidate

  const last = operands.length - 1
  const swapped = [...operands]
  ;[swapped[last], swapped[last - 1]] = [swapped[last - 1], swapped[last]]
  lines[targetIndex] = `${opcode} ${swapped.join(', ')}`
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Model configuration and discovery
// ---------------------------------------------------------------------------

const BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1'
const OLLAMA_ROOT = BASE_URL.replace(/\/v1\/?$/, '')

interface OllamaTagsResponse {
  models?: Array<{ name?: unknown }>
}

async function discoverModels(): Promise<string[]> {
  const override = process.env.OLLAMA_MODELS
  if (override) {
    return override
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0)
  }

  try {
    const response = await fetch(`${OLLAMA_ROOT}/api/tags`)
    if (!response.ok) throw new Error(`status ${response.status}`)
    const data = (await response.json()) as OllamaTagsResponse
    const names = (data.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string')
    if (names.length === 0) throw new Error('no models returned')
    return names
  } catch (error) {
    console.error(`Could not discover installed models from ${OLLAMA_ROOT}/api/tags (${error instanceof Error ? error.message : error}).`)
    console.error('Set OLLAMA_MODELS (comma-separated) to specify models explicitly. Falling back to a single default.')
    return ['qwen2.5-coder:7b']
  }
}

// ---------------------------------------------------------------------------
// Task suite: 20 tasks across 5 categories. Arithmetic/stack/shifts/memory
// all have real Z3 ground truth in CeilingAgent (extended in Phase 3 to
// cover PUSH/POP and SIB memory by reusing FloorEngine's Gate 3 checks, and
// SHL/SHR as new ALU semantics) - those are genuine correctness proofs, not
// just shape checks. Control-flow tasks (JMP/CALL/RET/Jcc) have no register-
// transfer ground truth by design (they don't move register *values*), so
// their symbolic gate legitimately reports "skipped, not a failure" - the
// static and fuzz gates still meaningfully check them.
// ---------------------------------------------------------------------------

type Category = 'arithmetic' | 'stack' | 'shifts' | 'memory' | 'control-flow'

interface Task {
  category: Category
  request: CeilingRequest
}

const TASKS: Task[] = [
  // arithmetic
  { category: 'arithmetic', request: { kind: 'instruction', description: 'ADD RAX, RBX' } },
  { category: 'arithmetic', request: { kind: 'instruction', description: 'SUB RCX, RAX' } },
  { category: 'arithmetic', request: { kind: 'instruction', description: 'ADD RDI, RCX' } },
  { category: 'arithmetic', request: { kind: 'instruction', description: 'SUB RBX, RDX' } },

  // stack ops
  { category: 'stack', request: { kind: 'instruction', description: 'PUSH RAX' } },
  { category: 'stack', request: { kind: 'instruction', description: 'POP RBX' } },
  { category: 'stack', request: { kind: 'instruction', description: 'PUSH RDI' } },
  { category: 'stack', request: { kind: 'instruction', description: 'POP RCX' } },

  // bitwise shifts
  { category: 'shifts', request: { kind: 'instruction', description: 'SHL RCX, RAX' } },
  { category: 'shifts', request: { kind: 'instruction', description: 'SHR RBX, RDX' } },
  { category: 'shifts', request: { kind: 'instruction', description: 'SHL RDI, RCX' } },
  { category: 'shifts', request: { kind: 'instruction', description: 'SHR RAX, RBX' } },

  // SIB memory addressing
  { category: 'memory', request: { kind: 'instruction', description: 'MOV RAX, [RBX + RCX*4]' } },
  { category: 'memory', request: { kind: 'instruction', description: 'MOV [RBX + RCX*4], RAX' } },
  { category: 'memory', request: { kind: 'instruction', description: 'MOV RAX, [RBX + 16]' } },
  { category: 'memory', request: { kind: 'instruction', description: 'MOV RDX, [RDI + RCX*8]' } },

  // control flow
  { category: 'control-flow', request: { kind: 'instruction', description: 'JMP done' } },
  { category: 'control-flow', request: { kind: 'instruction', description: 'JE done' } },
  { category: 'control-flow', request: { kind: 'instruction', description: 'CALL RCX' } },
  { category: 'control-flow', request: { kind: 'instruction', description: 'RET' } },
]

// ---------------------------------------------------------------------------
// Execution and metrics
// ---------------------------------------------------------------------------

interface TaskOutcome {
  category: Category
  task: string
  ok: boolean
  attempts: number
  totalTokens: number
  elapsedMs: number
}

function logHistory(history: Array<{ attempt: number; candidate: string; failedGate: { gate: string; ok: boolean; details: string } }>) {
  for (const rejected of history) {
    console.log(`    attempt ${rejected.attempt}: "${rejected.candidate}"`)
    console.log(`      rejected by gate "${rejected.failedGate.gate}": ${rejected.failedGate.details}`)
  }
}

async function runTask(model: string, task: Task): Promise<TaskOutcome> {
  console.log(`--- [${model}] ${task.category}: ${task.request.description} ---`)
  const tracker = new InstrumentedOllamaClient(BASE_URL, model)
  const llm = new FaultInjectingLlmClient(tracker)
  const start = performance.now()

  const summarizeTokens = () => tracker.usage.reduce((sum, u) => sum + (u.totalTokens ?? 0), 0)

  try {
    const result = await runCeilingAgent(task.request, llm)
    const elapsedMs = performance.now() - start

    console.log(`  verified result: ${result.result}`)
    console.log(`  attempts: ${result.attempts}`)
    if (result.history.length > 0) {
      console.log('  rejected attempts:')
      logHistory(result.history)
    }
    console.log(`  final gates: ${result.gates.map((g) => `${g.gate}=${g.ok ? 'PASS' : 'FAIL'}`).join(', ')}`)
    console.log(`  elapsed: ${elapsedMs.toFixed(0)}ms\n`)

    return { category: task.category, task: task.request.description, ok: true, attempts: result.attempts, totalTokens: summarizeTokens(), elapsedMs }
  } catch (error) {
    const elapsedMs = performance.now() - start
    if (error instanceof CeilingAgentExhaustedError) {
      console.log(`  EXHAUSTED after ${error.report.attempts} attempt(s)`)
      logHistory(error.report.history)
      console.log(`  elapsed: ${elapsedMs.toFixed(0)}ms\n`)
      return {
        category: task.category,
        task: task.request.description,
        ok: false,
        attempts: error.report.attempts,
        totalTokens: summarizeTokens(),
        elapsedMs,
      }
    }
    // Not a modeled CeilingAgent outcome (e.g. Ollama unreachable) - a real
    // infrastructure problem, not a benchmark result. Surface it, don't
    // silently record it as a failed task.
    throw error
  }
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function printModelSummary(model: string, outcomes: TaskOutcome[]) {
  const passed = outcomes.filter((o) => o.ok).length
  const passRate = (100 * passed) / outcomes.length
  console.log(`\n=== ${model}: summary ===`)
  console.log(
    `  ${passed}/${outcomes.length} passed (${passRate.toFixed(1)}%), ` +
      `avg attempts ${average(outcomes.map((o) => o.attempts)).toFixed(2)}, ` +
      `avg tokens ${average(outcomes.map((o) => o.totalTokens)).toFixed(0)}, ` +
      `avg elapsed ${average(outcomes.map((o) => o.elapsedMs)).toFixed(0)}ms`
  )

  const categories = [...new Set(outcomes.map((o) => o.category))]
  for (const category of categories) {
    const inCategory = outcomes.filter((o) => o.category === category)
    const categoryPassed = inCategory.filter((o) => o.ok).length
    console.log(`    ${category.padEnd(14)} ${categoryPassed}/${inCategory.length} passed`)
  }
}

function printComparisonTable(byModel: Map<string, TaskOutcome[]>) {
  console.log('\n=== Model comparison ===')
  console.log(['MODEL'.padEnd(22), 'PASS/TOTAL'.padEnd(11), 'PASS%'.padEnd(8), 'AVG ATTEMPTS'.padEnd(13), 'AVG TOKENS'.padEnd(11), 'AVG MS'].join(''))
  for (const [model, outcomes] of byModel) {
    const passed = outcomes.filter((o) => o.ok).length
    const passRate = `${((100 * passed) / outcomes.length).toFixed(1)}%`
    console.log(
      [
        model.padEnd(22),
        `${passed}/${outcomes.length}`.padEnd(11),
        passRate.padEnd(8),
        average(outcomes.map((o) => o.attempts)).toFixed(2).padEnd(13),
        average(outcomes.map((o) => o.totalTokens)).toFixed(0).padEnd(11),
        average(outcomes.map((o) => o.elapsedMs)).toFixed(0),
      ].join('')
    )
  }
}

async function main() {
  const models = await discoverModels()
  console.log(`Live CeilingAgent benchmark against ${BASE_URL}`)
  console.log(`Models under evaluation: ${models.join(', ')}`)
  console.log(`Task suite: ${TASKS.length} tasks across ${new Set(TASKS.map((t) => t.category)).size} categories`)
  console.log('Attempt 1 of each task has a deliberately injected fault where the response has 2+ operands.\n')

  const byModel = new Map<string, TaskOutcome[]>()

  for (const model of models) {
    const outcomes: TaskOutcome[] = []
    for (const task of TASKS) {
      outcomes.push(await runTask(model, task))
    }
    byModel.set(model, outcomes)
    printModelSummary(model, outcomes)
  }

  printComparisonTable(byModel)

  const allPassed = [...byModel.values()].every((outcomes) => outcomes.every((o) => o.ok))
  process.exitCode = allPassed ? 0 : 1
}

main().catch((error: unknown) => {
  console.error('Benchmark crashed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
