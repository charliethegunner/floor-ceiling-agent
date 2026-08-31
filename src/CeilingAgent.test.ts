import { describe, expect, test } from 'vitest'
import { runCeilingAgent, CeilingAgentExhaustedError, OpenAiCompatibleLlmClient, verifyInstructionCandidate, type LlmClient } from './CeilingAgent'

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

describe('verifyInstructionCandidate: extended ground truth (Phase 3)', () => {
  test('regression: 0/1-operand opcodes with no ground-truth model report skipped, not an arity failure', async () => {
    // Found live: the arity check ran before the opcode-lookup, so every
    // control-flow task failed with "expected a 2-operand instruction"
    // instead of the intended "no ground-truth model - skipped".
    for (const [x86, arm64] of [
      ['JMP done', 'B done'],
      ['JE done', 'B.EQ done'],
      ['CALL RCX', 'BLR X2'],
      ['RET', 'RET'],
    ] as const) {
      const gates = await verifyInstructionCandidate(x86, arm64)
      const symbolic = gates.find((g) => g.gate === 'symbolic')
      expect(symbolic?.ok, `expected "${x86}" to report skipped, got: ${symbolic?.details}`).toBe(true)
      expect(symbolic?.details).toContain('no ground-truth semantic model')
    }
  })

  test('PUSH is verified via FloorEngine ground truth (reused, not re-derived)', async () => {
    const gates = await verifyInstructionCandidate('PUSH RAX', 'STR X0, [SP, #-8]!')
    expect(gates.find((g) => g.gate === 'symbolic')?.ok).toBe(true)
  })

  test('PUSH with the wrong stack offset is caught', async () => {
    const gates = await verifyInstructionCandidate('PUSH RAX', 'STR X0, [SP, #-4]!')
    expect(gates.find((g) => g.gate === 'symbolic')?.ok).toBe(false)
  })

  test('POP is verified via FloorEngine ground truth', async () => {
    const gates = await verifyInstructionCandidate('POP RBX', 'LDR X1, [SP], #8')
    expect(gates.find((g) => g.gate === 'symbolic')?.ok).toBe(true)
  })

  test('a SIB memory load is verified via FloorEngine ground truth, including the scale-to-shift mapping', async () => {
    const gates = await verifyInstructionCandidate('MOV RAX, [RBX + RCX*4]', 'LDR X0, [X1, X2, LSL #2]')
    expect(gates.find((g) => g.gate === 'symbolic')?.ok).toBe(true)
  })

  test('a SIB memory load with the wrong shift is caught', async () => {
    const gates = await verifyInstructionCandidate('MOV RAX, [RBX + RCX*4]', 'LDR X0, [X1, X2, LSL #1]')
    expect(gates.find((g) => g.gate === 'symbolic')?.ok).toBe(false)
  })

  test('SHL is proven equivalent to ARM64 LSL', async () => {
    const gates = await verifyInstructionCandidate('SHL RCX, RAX', 'LSL X2, X2, X0')
    const symbolic = gates.find((g) => g.gate === 'symbolic')
    expect(symbolic?.ok).toBe(true)
    expect(symbolic?.details).toContain('Z3 proved')
  })

  test('SHR is proven equivalent to ARM64 LSR (logical, not arithmetic, shift)', async () => {
    const gates = await verifyInstructionCandidate('SHR RCX, RAX', 'LSR X2, X2, X0')
    expect(gates.find((g) => g.gate === 'symbolic')?.ok).toBe(true)
  })

  test('a candidate using the x86 mnemonic SHR instead of ARM64 LSR is rejected', async () => {
    const gates = await verifyInstructionCandidate('SHR RCX, RAX', 'SHR X2, X2, X0')
    expect(gates.find((g) => g.gate === 'symbolic')?.ok).toBe(false)
  })
})

describe('verifyInstructionCandidate: Gate 1 enforces dot-notation on conditional branches (Phase 3.1)', () => {
  test('the correctly dotted form is accepted', async () => {
    const gates = await verifyInstructionCandidate('JE done', 'B.EQ done')
    expect(gates.find((g) => g.gate === 'static')?.ok).toBe(true)
  })

  test('a missing dot ("BEQ" instead of "B.EQ") is rejected by the static gate', async () => {
    const gates = await verifyInstructionCandidate('JE done', 'BEQ done')
    const staticGate = gates.find((g) => g.gate === 'static')
    expect(staticGate?.ok).toBe(false)
    expect(staticGate?.details).toContain('B.EQ')
  })

  test('a missing dot is rejected for every condition code this translator generates', async () => {
    const cases: Array<[string, string]> = [
      ['JNE done', 'BNE done'],
      ['JG done', 'BGT done'],
      ['JL done', 'BLT done'],
      ['JGE done', 'BGE done'],
      ['JLE done', 'BLE done'],
    ]
    for (const [x86, badCandidate] of cases) {
      const gates = await verifyInstructionCandidate(x86, badCandidate)
      const staticGate = gates.find((g) => g.gate === 'static')
      expect(staticGate?.ok, `expected "${badCandidate}" to be rejected`).toBe(false)
    }
  })

  test('unconditional B and BL/BLR are never mistaken for a malformed conditional branch', async () => {
    const jmp = await verifyInstructionCandidate('JMP done', 'B done')
    expect(jmp.find((g) => g.gate === 'static')?.ok).toBe(true)

    const call = await verifyInstructionCandidate('CALL RCX', 'BL X2')
    expect(call.find((g) => g.gate === 'static')?.ok).toBe(true)

    const callr = await verifyInstructionCandidate('CALL RAX', 'BLR X0')
    expect(callr.find((g) => g.gate === 'static')?.ok).toBe(true)
  })
})

describe('verifyInstructionCandidate: case-folding normalization (Phase 3.1)', () => {
  test('a lowercase register-register candidate is still proven symbolically equivalent', async () => {
    const gates = await verifyInstructionCandidate('MOV RAX, RBX', 'mov x0, x1')
    expect(gates.find((g) => g.gate === 'symbolic')?.ok).toBe(true)
  })

  test('a lowercase candidate still passes register-token validity', async () => {
    const gates = await verifyInstructionCandidate('ADD RCX, RAX', 'add x2, x2, x0')
    expect(gates.find((g) => g.gate === 'fuzz')?.ok).toBe(true)
  })

  test('a lowercase conditional branch with the dot present is still accepted (not flagged as malformed)', async () => {
    const gates = await verifyInstructionCandidate('JE done', 'b.eq done')
    expect(gates.find((g) => g.gate === 'static')?.ok).toBe(true)
  })

  test('the returned/history candidate text preserves the model\'s original casing (case-folding is verification-only)', async () => {
    const llm = new ScriptedLlmClient(['mov x0, x1'])
    const result = await runCeilingAgent({ kind: 'instruction', description: 'MOV RAX, RBX' }, llm)
    expect(result.result).toBe('mov x0, x1')
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
