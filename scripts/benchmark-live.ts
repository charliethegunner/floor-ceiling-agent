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
 * by swapping its last two operands - a realistic "which operand goes where"
 * mistake - so Gate 3 is guaranteed to reject attempt 1 and produce a real
 * Z3 counterexample, regardless of whether the underlying model would have
 * gotten it right unassisted. Every later call for the same task passes the
 * real model's response through unmodified, so the actual self-correction
 * is genuinely driven by the model reading the Z3 feedback, not scripted.
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

const BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1'
// Neither model the spec suggested (qwen2.5-coder:latest, llama3:latest) was
// installed on the machine this was built against - defaults to a model
// that actually was (`ollama list`). Override with OLLAMA_MODEL for yours.
const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5vl:7b'

const TASKS: CeilingRequest[] = [
  { kind: 'instruction', description: 'SUB RCX, RAX' },
  { kind: 'instruction', description: 'XOR RBX, RDX' },
  { kind: 'instruction', description: 'AND RDI, RCX' },
]

interface TaskOutcome {
  task: string
  ok: boolean
  attempts: number
  elapsedMs: number
}

function logHistory(history: Array<{ attempt: number; candidate: string; failedGate: { gate: string; ok: boolean; details: string } }>) {
  for (const rejected of history) {
    console.log(`    attempt ${rejected.attempt}: "${rejected.candidate}"`)
    console.log(`      rejected by gate "${rejected.failedGate.gate}": ${rejected.failedGate.details}`)
  }
}

async function runTask(task: CeilingRequest): Promise<TaskOutcome> {
  console.log(`--- Task: ${task.description} ---`)
  const tracker = new InstrumentedOllamaClient(BASE_URL, MODEL)
  const llm = new FaultInjectingLlmClient(tracker)
  const start = performance.now()

  try {
    const result = await runCeilingAgent(task, llm)
    const elapsedMs = performance.now() - start

    console.log(`  verified result: ${result.result}`)
    console.log(`  attempts: ${result.attempts}`)
    if (result.history.length > 0) {
      console.log('  rejected attempts (fault injection + real model self-correction):')
      logHistory(result.history)
    }
    console.log(`  final gates: ${result.gates.map((g) => `${g.gate}=${g.ok ? 'PASS' : 'FAIL'}`).join(', ')}`)
    console.log(`  token usage per call: ${JSON.stringify(tracker.usage)}`)
    console.log(`  elapsed: ${elapsedMs.toFixed(0)}ms\n`)

    return { task: task.description, ok: true, attempts: result.attempts, elapsedMs }
  } catch (error) {
    const elapsedMs = performance.now() - start
    if (error instanceof CeilingAgentExhaustedError) {
      console.log(`  EXHAUSTED after ${error.report.attempts} attempt(s)`)
      logHistory(error.report.history)
      console.log(`  token usage per call: ${JSON.stringify(tracker.usage)}`)
      console.log(`  elapsed: ${elapsedMs.toFixed(0)}ms\n`)
      return { task: task.description, ok: false, attempts: error.report.attempts, elapsedMs }
    }
    // Not a modeled CeilingAgent outcome (e.g. Ollama unreachable) - a real
    // infrastructure problem, not a benchmark result. Surface it, don't
    // silently record it as a failed task.
    throw error
  }
}

async function main() {
  console.log(`Live CeilingAgent benchmark against ${BASE_URL} (model: ${MODEL})`)
  console.log('Attempt 1 of each task has a deliberately injected operand-swap fault.\n')

  const outcomes: TaskOutcome[] = []
  for (const task of TASKS) {
    outcomes.push(await runTask(task))
  }

  console.log('=== Summary ===')
  for (const outcome of outcomes) {
    console.log(`${outcome.ok ? 'PASS' : 'FAIL'}  ${outcome.task}  attempts=${outcome.attempts}  ${outcome.elapsedMs.toFixed(0)}ms`)
  }

  process.exitCode = outcomes.every((o) => o.ok) ? 0 : 1
}

main().catch((error: unknown) => {
  console.error('Benchmark crashed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
