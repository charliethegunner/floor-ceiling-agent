import { describe, expect, test } from 'vitest'
import { runCeilingAgent, CeilingAgentExhaustedError, OpenAiCompatibleLlmClient, type LlmClient } from './CeilingAgent'

class ScriptedLlmClient implements LlmClient {
  private index = 0
  constructor(private readonly responses: string[]) {}
  async complete(): Promise<string> {
    const response = this.responses[this.index]
    if (response === undefined) throw new Error('ScriptedLlmClient ran out of scripted responses')
    this.index++
    return response
  }
}

describe('runCeilingAgent: instruction mode', () => {
  test('accepts a correct candidate on the first attempt', async () => {
    const llm = new ScriptedLlmClient(['MOV X0, X1'])
    const result = await runCeilingAgent({ kind: 'instruction', description: 'MOV RAX, RBX' }, llm)

    expect(result.ok).toBe(true)
    expect(result.result).toBe('MOV X0, X1')
    expect(result.attempts).toBe(1)
    expect(result.gates.every((g) => g.ok)).toBe(true)
  }, 15000)

  test('self-corrects after a symbolically-wrong candidate and succeeds on retry', async () => {
    const llm = new ScriptedLlmClient(['SUB X2, X0, X2', 'SUB X2, X2, X0'])
    const result = await runCeilingAgent({ kind: 'instruction', description: 'SUB RCX, RAX' }, llm)

    expect(result.ok).toBe(true)
    expect(result.result).toBe('SUB X2, X2, X0')
    expect(result.attempts).toBe(2)
  }, 15000)

  test('proves equivalence for an opcode translateInstruction does not support (SUB)', async () => {
    const llm = new ScriptedLlmClient(['SUB X1, X1, X3'])
    const result = await runCeilingAgent({ kind: 'instruction', description: 'SUB RBX, RDX' }, llm)

    expect(result.ok).toBe(true)
    const symbolic = result.gates.find((g) => g.gate === 'symbolic')
    expect(symbolic?.details).toContain('Z3 proved')
  }, 15000)

  test('throws CeilingAgentExhaustedError after exhausting retries on a consistently wrong candidate', async () => {
    const llm = new ScriptedLlmClient(['XOR X0, X0, X0', 'XOR X0, X0, X0', 'XOR X0, X0, X0'])

    await expect(runCeilingAgent({ kind: 'instruction', description: 'MOV RAX, RBX' }, llm, { maxRetries: 3 })).rejects.toThrow(
      CeilingAgentExhaustedError
    )
  }, 15000)

  test('the exhausted error carries the full attempt history with each failed gate', async () => {
    const llm = new ScriptedLlmClient(['garbage', 'garbage'])

    try {
      await runCeilingAgent({ kind: 'instruction', description: 'MOV RAX, RBX' }, llm, { maxRetries: 2 })
      expect.unreachable('expected runCeilingAgent to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CeilingAgentExhaustedError)
      const exhausted = error as CeilingAgentExhaustedError
      expect(exhausted.report.attempts).toBe(2)
      expect(exhausted.report.history).toHaveLength(2)
      expect(exhausted.report.history[0].candidate).toBe('garbage')
      expect(exhausted.report.history[0].failedGate.gate).toBe('symbolic')
    }
  }, 15000)
})

describe('runCeilingAgent: patch mode', () => {
  test('accepts a valid exported TypeScript function on the first attempt', async () => {
    const llm = new ScriptedLlmClient(['export function double(x: number): number { return x * 2 }'])
    const result = await runCeilingAgent({ kind: 'patch', description: 'double a number' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.gates.find((g) => g.gate === 'fuzz')?.details).toContain('not applicable')
  })

  test('rejects a candidate using "any" and succeeds after self-correction', async () => {
    const llm = new ScriptedLlmClient([
      'export function double(x: any) { return x * 2 }',
      'export function double(x: number): number { return x * 2 }',
    ])
    const result = await runCeilingAgent({ kind: 'patch', description: 'double a number' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
  })

  test('rejects a candidate with no exported function and exhausts retries', async () => {
    const llm = new ScriptedLlmClient(['const x = 1', 'const y = 2'])

    await expect(runCeilingAgent({ kind: 'patch', description: 'do nothing useful' }, llm, { maxRetries: 2 })).rejects.toThrow(
      CeilingAgentExhaustedError
    )
  })
})

describe('OpenAiCompatibleLlmClient', () => {
  test('posts an OpenAI-compatible chat-completions request and parses the response', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init?.body as string) })
      return new Response(JSON.stringify({ choices: [{ message: { content: '  MOV X0, X1  ' } }] }), { status: 200 })
    }) as typeof fetch

    try {
      const client = new OpenAiCompatibleLlmClient({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder' })
      const result = await client.complete('translate MOV RAX, RBX')

      expect(result).toBe('MOV X0, X1')
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions')
      expect(calls[0].body).toMatchObject({
        model: 'qwen2.5-coder',
        messages: [{ role: 'user', content: 'translate MOV RAX, RBX' }],
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('throws a descriptive error when the endpoint responds with a non-2xx status', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('model not found', { status: 404 })) as typeof fetch

    try {
      const client = new OpenAiCompatibleLlmClient({ baseUrl: 'http://localhost:11434/v1', model: 'missing-model' })
      await expect(client.complete('anything')).rejects.toThrow(/404/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
