import { describe, expect, test } from 'vitest'
import {
  runCeilingAgent,
  CeilingAgentExhaustedError,
  OpenAiCompatibleLlmClient,
  verifyInstructionCandidate,
  verifyTopologyCandidate,
  verifyClaimCandidate,
  verifySpatialCandidate,
  buildPrompt,
  type LlmClient,
  type CeilingRequest,
  type CeilingAttempt,
} from './CeilingAgent'
import type { TopologyCandidate } from './topology-floor'
import type { ClaimCandidate } from './claim-floor'
import type { SpatialCandidate } from './spatial-floor'

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

// For Best-of-N tests: real Best-of-N sampling fires several parallel
// completions at different temperatures per round, so a client keyed by
// call ORDER (like ScriptedLlmClient) can't express "this specific
// temperature returns the correct candidate." Rounds to 1 decimal place to
// sidestep floating-point drift in stepped temperature computation
// (e.g. 0.2 + 3*0.2 !== 0.8 exactly in IEEE 754).
class TemperatureRoutedLlmClient implements LlmClient {
  callCount = 0
  constructor(private readonly byTemperature: (roundedTemperature: number) => string) {}
  async complete(_prompt: string, temperature = 0): Promise<string> {
    this.callCount++
    return this.byTemperature(Number(temperature.toFixed(1)))
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

  // Phase 6: complete() gained an optional temperature parameter so
  // ParallelCandidateSampler's stepped-temperature Best-of-N sampling can
  // actually produce diverse candidates from a real endpoint, not just
  // decorative numbers nothing reads.
  test('threads an explicit temperature through to the request body', async () => {
    const calls: Array<{ body: unknown }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init?.body as string) })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'X' } }] }), { status: 200 })
    }) as typeof fetch

    try {
      const client = new OpenAiCompatibleLlmClient({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder' })
      await client.complete('prompt', 0.7)
      expect(calls[0].body).toMatchObject({ temperature: 0.7 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('defaults temperature to 0 when omitted, preserving prior deterministic behavior', async () => {
    const calls: Array<{ body: unknown }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init?.body as string) })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'X' } }] }), { status: 200 })
    }) as typeof fetch

    try {
      const client = new OpenAiCompatibleLlmClient({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder' })
      await client.complete('prompt')
      expect(calls[0].body).toMatchObject({ temperature: 0 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('buildPrompt: deterministic correction prompts (Phase 4)', () => {
  test('is deterministic: identical request and history produce byte-identical prompts', () => {
    const request: CeilingRequest = { kind: 'instruction', description: 'SUB RCX, RAX' }
    const history: CeilingAttempt[] = [
      {
        attempt: 1,
        candidate: 'SUB X0, X2',
        failedGate: {
          gate: 'symbolic',
          ok: false,
          details: 'Z3 found a disagreeing case (SAT model): dst=#x0000000000000001, src=#x0000000000000000',
        },
      },
    ]

    expect(buildPrompt(request, history)).toBe(buildPrompt(request, history))
  })

  test('a Z3 counterexample surfaces verbatim in the correction prompt, clearly labeled', () => {
    const request: CeilingRequest = { kind: 'instruction', description: 'SUB RCX, RAX' }
    const counterexample = 'Z3 found a disagreeing case (SAT model): dst=#x0000000000000001, src=#x0000000000000000'
    const history: CeilingAttempt[] = [{ attempt: 1, candidate: 'SUB X0, X2', failedGate: { gate: 'symbolic', ok: false, details: counterexample } }]

    const prompt = buildPrompt(request, history)

    expect(prompt).toContain('Attempt 1 was rejected - gate "symbolic"')
    expect(prompt).toContain(`Counterexample/details: ${counterexample}`)
    expect(prompt).toContain('Rejected candidate:\nSUB X0, X2')
  })

  test('a fast-check-style counterexample surfaces verbatim too - buildPrompt does not care which gate produced it', () => {
    const request: CeilingRequest = { kind: 'instruction', description: 'MOV RAX, [RBX]' }
    const counterexample = 'unexpected ARM64 register token "X9" in output for: "MOV RAX, [RBX]"'
    const history: CeilingAttempt[] = [{ attempt: 1, candidate: 'LDR X9, [X1]', failedGate: { gate: 'fuzz', ok: false, details: counterexample } }]

    const prompt = buildPrompt(request, history)

    expect(prompt).toContain(`Counterexample/details: ${counterexample}`)
  })

  test('multiple rejected attempts accumulate in order', () => {
    const request: CeilingRequest = { kind: 'instruction', description: 'ADD RAX, RBX' }
    const history: CeilingAttempt[] = [
      { attempt: 1, candidate: 'ADD X1, X0', failedGate: { gate: 'symbolic', ok: false, details: 'first failure' } },
      { attempt: 2, candidate: 'ADD X0, X1', failedGate: { gate: 'symbolic', ok: false, details: 'second failure' } },
    ]

    const prompt = buildPrompt(request, history)
    const firstIndex = prompt.indexOf('Attempt 1')
    const secondIndex = prompt.indexOf('Attempt 2')

    expect(firstIndex).toBeGreaterThan(-1)
    expect(secondIndex).toBeGreaterThan(firstIndex)
  })

  test('a first attempt (no history) omits the feedback section entirely', () => {
    const request: CeilingRequest = { kind: 'instruction', description: 'MOV RAX, RBX' }

    const prompt = buildPrompt(request, [])

    expect(prompt).not.toContain('Previous attempts were rejected')
    expect(prompt).toContain('x86 instruction: MOV RAX, RBX')
  })
})

describe('verifyInstructionCandidate: expressed via the generic VerificationFloor contract (Phase 4)', () => {
  test('still returns exactly the static/fuzz/symbolic gates, in order, after the floor-based refactor', async () => {
    const gates = await verifyInstructionCandidate('MOV RAX, RBX', 'MOV X0, X1')
    expect(gates.map((g) => g.gate)).toEqual(['static', 'fuzz', 'symbolic'])
  })
})

// ---------------------------------------------------------------------------
// Phase 5: dynamic multi-domain routing. CeilingRequest.kind now also
// routes 'topology' candidates through TOPOLOGY_FLOOR and 'claim' candidates
// through CLAIM_VERIFICATION_FLOOR (src/topology-floor.ts, src/claim-floor.ts)
// - the same self-healing retry loop that already drives the ARM64
// instruction floor, generalized to any VerificationFloor. The LLM's raw
// completion is JSON text parsed into that floor's Candidate shape.
// ---------------------------------------------------------------------------

const GOOD_TOPOLOGY_CANDIDATE: TopologyCandidate = {
  inMemoryFiles: {
    'a.ts': "import { b } from './b'\nexport function a(): number { return b() }",
    'b.ts': 'export function b(): number { return 42 }',
  },
  expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
  reachability: [{ from: { filePath: 'a.ts', functionName: 'a' }, to: { filePath: 'b.ts', functionName: 'b' }, expectReachable: true }],
}

const TOPOLOGY_CANDIDATE_WITH_MISSING_EXPORT: TopologyCandidate = {
  inMemoryFiles: {
    'a.ts': "import { b } from './b'\nfunction a(): number { return b() }",
    'b.ts': 'export function b(): number { return 42 }',
  },
  expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
  reachability: [],
}

describe('verifyTopologyCandidate: routes through TOPOLOGY_FLOOR (Phase 5)', () => {
  test('a well-formed candidate satisfying every expectation passes all three gates in order', async () => {
    const gates = await verifyTopologyCandidate(JSON.stringify(GOOD_TOPOLOGY_CANDIDATE))
    expect(gates.map((g) => g.gate)).toEqual(['exports', 'types', 'reachability'])
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('a candidate missing an expected export is caught by the exports gate', async () => {
    const gates = await verifyTopologyCandidate(JSON.stringify(TOPOLOGY_CANDIDATE_WITH_MISSING_EXPORT))
    const exportsGate = gates.find((g) => g.gate === 'exports')
    expect(exportsGate?.ok).toBe(false)
    expect(exportsGate?.details).toContain('expected export "a" not found')
  })

  test('malformed JSON is reported as a gate failure, not an uncaught exception', async () => {
    const gates = await verifyTopologyCandidate('not valid json {{{')
    expect(gates).toHaveLength(1)
    expect(gates[0].ok).toBe(false)
    expect(gates[0].gate).toBe('exports')
  })

  test('JSON that parses but omits required array fields does not throw', async () => {
    const gates = await verifyTopologyCandidate(JSON.stringify({ inMemoryFiles: { 'a.ts': 'export const x = 1' } }))
    expect(gates.some((g) => !g.ok)).toBe(true)
  })
})

describe('runCeilingAgent: topology domain routing (Phase 5)', () => {
  test('accepts a correct topology candidate on the first attempt', async () => {
    const llm = new ScriptedLlmClient([JSON.stringify(GOOD_TOPOLOGY_CANDIDATE)])
    const result = await runCeilingAgent({ kind: 'topology', description: 'a module a.ts that calls b.ts#b' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.gates.map((g) => g.gate)).toEqual(['exports', 'types', 'reachability'])
  })

  test('self-corrects after a candidate missing the expected export and succeeds on retry', async () => {
    const llm = new ScriptedLlmClient([JSON.stringify(TOPOLOGY_CANDIDATE_WITH_MISSING_EXPORT), JSON.stringify(GOOD_TOPOLOGY_CANDIDATE)])
    const result = await runCeilingAgent({ kind: 'topology', description: 'a module a.ts that calls b.ts#b' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.history[0].failedGate.gate).toBe('exports')
  })

  test('recovers from a malformed-JSON attempt and succeeds on retry', async () => {
    const llm = new ScriptedLlmClient(['not valid json {{{', JSON.stringify(GOOD_TOPOLOGY_CANDIDATE)])
    const result = await runCeilingAgent({ kind: 'topology', description: 'a module a.ts that calls b.ts#b' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.history[0].candidate).toBe('not valid json {{{')
  })

  test('throws CeilingAgentExhaustedError after exhausting retries on a candidate that never satisfies exports', async () => {
    const llm = new ScriptedLlmClient([
      JSON.stringify(TOPOLOGY_CANDIDATE_WITH_MISSING_EXPORT),
      JSON.stringify(TOPOLOGY_CANDIDATE_WITH_MISSING_EXPORT),
    ])

    await expect(runCeilingAgent({ kind: 'topology', description: 'a module a.ts that calls b.ts#b' }, llm, { maxRetries: 2 })).rejects.toThrow(
      CeilingAgentExhaustedError
    )
  })
})

const GOOD_CLAIM_CANDIDATE: ClaimCandidate = {
  claims: [
    {
      statement: 'translateInstruction lowers MOV RAX, RBX to MOV X0, X1',
      subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
      assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X0, X1' } },
    },
  ],
}

const FALSE_CLAIM_CANDIDATE: ClaimCandidate = {
  claims: [
    {
      statement: 'translateInstruction lowers MOV RAX, RBX to MOV X1, X0',
      subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
      assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X1, X0' } },
    },
  ],
}

const HALLUCINATED_EXPORT_CLAIM_CANDIDATE: ClaimCandidate = {
  claims: [
    {
      statement: 'a claim about a function that does not exist',
      subject: { modulePath: 'lib/translator.ts', exportName: 'thisFunctionDoesNotExist' },
      assertion: { args: [], expected: null },
    },
  ],
}

describe('verifyClaimCandidate: routes through CLAIM_VERIFICATION_FLOOR (Phase 5)', () => {
  test('a true claim about a real, committed function passes all three gates in order', async () => {
    const gates = await verifyClaimCandidate(JSON.stringify(GOOD_CLAIM_CANDIDATE))
    expect(gates.map((g) => g.gate)).toEqual(['structural', 'cross-reference', 'empirical'])
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('a false claim is caught by the empirical gate, by actually running the function', async () => {
    const gates = await verifyClaimCandidate(JSON.stringify(FALSE_CLAIM_CANDIDATE))
    const empirical = gates.find((g) => g.gate === 'empirical')
    expect(empirical?.ok).toBe(false)
    expect(empirical?.details).toContain('expected')
  })

  test('a hallucinated export name is caught by the cross-reference gate', async () => {
    const gates = await verifyClaimCandidate(JSON.stringify(HALLUCINATED_EXPORT_CLAIM_CANDIDATE))
    const crossReference = gates.find((g) => g.gate === 'cross-reference')
    expect(crossReference?.ok).toBe(false)
    expect(crossReference?.details).toContain('does not export')
  })

  test('malformed JSON is reported as a gate failure, not an uncaught exception', async () => {
    const gates = await verifyClaimCandidate('not valid json {{{')
    expect(gates).toHaveLength(1)
    expect(gates[0].ok).toBe(false)
    expect(gates[0].gate).toBe('structural')
  })
})

describe('runCeilingAgent: claim domain routing (Phase 5)', () => {
  test('accepts a true claim on the first attempt', async () => {
    const llm = new ScriptedLlmClient([JSON.stringify(GOOD_CLAIM_CANDIDATE)])
    const result = await runCeilingAgent({ kind: 'claim', description: 'MOV RAX, RBX lowers to MOV X0, X1' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.gates.map((g) => g.gate)).toEqual(['structural', 'cross-reference', 'empirical'])
  })

  test('self-corrects after a false claim and succeeds on retry', async () => {
    const llm = new ScriptedLlmClient([JSON.stringify(FALSE_CLAIM_CANDIDATE), JSON.stringify(GOOD_CLAIM_CANDIDATE)])
    const result = await runCeilingAgent({ kind: 'claim', description: 'MOV RAX, RBX lowers to MOV X0, X1' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.history[0].failedGate.gate).toBe('empirical')
  })

  test('throws CeilingAgentExhaustedError after exhausting retries on a hallucinated export', async () => {
    const llm = new ScriptedLlmClient([JSON.stringify(HALLUCINATED_EXPORT_CLAIM_CANDIDATE), JSON.stringify(HALLUCINATED_EXPORT_CLAIM_CANDIDATE)])

    await expect(
      runCeilingAgent({ kind: 'claim', description: 'a claim about a function that does not exist' }, llm, { maxRetries: 2 })
    ).rejects.toThrow(CeilingAgentExhaustedError)
  })

  test('the exhausted error history records the raw JSON candidate text verbatim', async () => {
    const llm = new ScriptedLlmClient([JSON.stringify(HALLUCINATED_EXPORT_CLAIM_CANDIDATE)])

    try {
      await runCeilingAgent({ kind: 'claim', description: 'a claim about a function that does not exist' }, llm, { maxRetries: 1 })
      expect.unreachable('expected runCeilingAgent to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CeilingAgentExhaustedError)
      const exhausted = error as CeilingAgentExhaustedError
      expect(exhausted.report.history[0].candidate).toBe(JSON.stringify(HALLUCINATED_EXPORT_CLAIM_CANDIDATE))
      expect(exhausted.report.history[0].failedGate.gate).toBe('cross-reference')
    }
  })
})

// ---------------------------------------------------------------------------
// Markdown-fenced JSON handling: a live benchmark run (scripts/benchmark-live.ts)
// found real local models wrapping their JSON candidate in ```json ... ```
// fences despite the prompt explicitly saying "no markdown fences" - every
// fenced attempt failed JSON.parse identically, and since the model kept
// resubmitting the same fenced text, self-correction never happened across
// all 5 retries. verifyTopologyCandidate/verifyClaimCandidate now strip a
// wrapping fence before parsing, so a fenced-but-otherwise-valid candidate
// is accepted rather than burning the entire retry budget on formatting.
// ---------------------------------------------------------------------------

function fenced(json: string, lang = 'json'): string {
  return '```' + lang + '\n' + json + '\n```'
}

describe('verifyTopologyCandidate: strips a wrapping markdown code fence before parsing', () => {
  test('a ```json-fenced candidate is parsed and verified normally', async () => {
    const gates = await verifyTopologyCandidate(fenced(JSON.stringify(GOOD_TOPOLOGY_CANDIDATE)))
    expect(gates.map((g) => g.gate)).toEqual(['exports', 'types', 'reachability'])
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('a bare ```-fenced candidate (no "json" language tag) is parsed and verified normally', async () => {
    const gates = await verifyTopologyCandidate(fenced(JSON.stringify(GOOD_TOPOLOGY_CANDIDATE), ''))
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('surrounding whitespace around the fence is tolerated', async () => {
    const gates = await verifyTopologyCandidate(`\n\n  ${fenced(JSON.stringify(GOOD_TOPOLOGY_CANDIDATE))}  \n\n`)
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('a fenced candidate that fails a real gate still reports that gate failure, not a parse error', async () => {
    const gates = await verifyTopologyCandidate(fenced(JSON.stringify(TOPOLOGY_CANDIDATE_WITH_MISSING_EXPORT)))
    const exportsGate = gates.find((g) => g.gate === 'exports')
    expect(exportsGate?.ok).toBe(false)
    expect(exportsGate?.details).toContain('expected export "a" not found')
  })

  test('a fence wrapping genuinely invalid JSON is still reported as a gate failure, not an uncaught exception', async () => {
    const gates = await verifyTopologyCandidate(fenced('not valid json {{{'))
    expect(gates).toHaveLength(1)
    expect(gates[0].ok).toBe(false)
    expect(gates[0].gate).toBe('exports')
  })
})

describe('verifyClaimCandidate: strips a wrapping markdown code fence before parsing', () => {
  test('a ```json-fenced candidate is parsed and verified normally', async () => {
    const gates = await verifyClaimCandidate(fenced(JSON.stringify(GOOD_CLAIM_CANDIDATE)))
    expect(gates.map((g) => g.gate)).toEqual(['structural', 'cross-reference', 'empirical'])
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('a bare ```-fenced candidate (no "json" language tag) is parsed and verified normally', async () => {
    const gates = await verifyClaimCandidate(fenced(JSON.stringify(GOOD_CLAIM_CANDIDATE), ''))
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('a fenced false claim still reports the empirical failure, not a parse error', async () => {
    const gates = await verifyClaimCandidate(fenced(JSON.stringify(FALSE_CLAIM_CANDIDATE)))
    const empirical = gates.find((g) => g.gate === 'empirical')
    expect(empirical?.ok).toBe(false)
  })
})

describe('runCeilingAgent: a markdown-fenced JSON response no longer wastes a retry (Phase 5 fix)', () => {
  test('a fenced topology candidate is accepted on the very first attempt', async () => {
    const llm = new ScriptedLlmClient([fenced(JSON.stringify(GOOD_TOPOLOGY_CANDIDATE))])
    const result = await runCeilingAgent({ kind: 'topology', description: 'a module a.ts that calls b.ts#b' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
  })

  test('a fenced claim candidate is accepted on the very first attempt', async () => {
    const llm = new ScriptedLlmClient([fenced(JSON.stringify(GOOD_CLAIM_CANDIDATE))])
    const result = await runCeilingAgent({ kind: 'claim', description: 'MOV RAX, RBX lowers to MOV X0, X1' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Phase 5.1: hardening the JSON sanitizer beyond an exact "the whole
// response is one fence" match. Real models sometimes wrap the fence in
// their own surrounding prose ("Here's the JSON:\n```json\n{...}\n```\nLet
// me know!"), which the Phase 5 fence-stripper (anchored to the start/end
// of the trimmed response) did not handle - it fell through to a raw
// JSON.parse of the whole prose-plus-fence blob and failed. The sanitizer
// now extracts the first fenced block from anywhere in the response.
// ---------------------------------------------------------------------------

describe('verifyTopologyCandidate / verifyClaimCandidate: fence extraction tolerates surrounding prose (Phase 5.1)', () => {
  test('topology: explanatory prose before and after the fence is ignored', async () => {
    const withProse = `Sure, here's the module:\n${fenced(JSON.stringify(GOOD_TOPOLOGY_CANDIDATE))}\nLet me know if you need changes!`
    const gates = await verifyTopologyCandidate(withProse)
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('claim: explanatory prose before and after the fence is ignored', async () => {
    const withProse = `Here is the claim:\n${fenced(JSON.stringify(GOOD_CLAIM_CANDIDATE))}\nHope that helps!`
    const gates = await verifyClaimCandidate(withProse)
    expect(gates.every((g) => g.ok)).toBe(true)
  })
})

describe('verifyClaimCandidate: empirical failures carry a runtime stack trace (Phase 5.1)', () => {
  test('a claim whose call genuinely throws includes a real V8 stack trace alongside the message', async () => {
    const throwingClaim: ClaimCandidate = {
      claims: [
        {
          statement: 'calling translateInstruction with no argument',
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: [], expected: { ok: false, error: 'anything' } },
        },
      ],
    }

    const gates = await verifyClaimCandidate(JSON.stringify(throwingClaim))
    const empirical = gates.find((g) => g.gate === 'empirical')

    expect(empirical?.ok).toBe(false)
    expect(empirical?.details).toContain('lib/translator.ts#translateInstruction()')
    expect(empirical?.details).toContain('threw')
    expect(empirical?.details).toContain('Stack trace:')
    expect(empirical?.details).toMatch(/\n\s*at /)
  })

  test('a wrong-value (non-throwing) empirical failure has no stack trace section - there is no exception to report', async () => {
    const gates = await verifyClaimCandidate(JSON.stringify(FALSE_CLAIM_CANDIDATE))
    const empirical = gates.find((g) => g.gate === 'empirical')

    expect(empirical?.ok).toBe(false)
    expect(empirical?.details).not.toContain('Stack trace:')
  })
})

describe('buildPrompt: routes domain-specific instructions for topology and claim kinds (Phase 5)', () => {
  test('a topology request asks for JSON, not ARM64 or plain TypeScript instructions', () => {
    const prompt = buildPrompt({ kind: 'topology', description: 'a module a.ts that calls b.ts#b' }, [])
    expect(prompt).toContain('a module a.ts that calls b.ts#b')
    expect(prompt).toContain('JSON')
    expect(prompt).not.toContain('ARM64 instruction text')
  })

  test('a claim request asks for JSON, not ARM64 or plain TypeScript instructions', () => {
    const prompt = buildPrompt({ kind: 'claim', description: 'MOV RAX, RBX lowers to MOV X0, X1' }, [])
    expect(prompt).toContain('MOV RAX, RBX lowers to MOV X0, X1')
    expect(prompt).toContain('JSON')
    expect(prompt).not.toContain('ARM64 instruction text')
  })
})

// ---------------------------------------------------------------------------
// Phase 6: opt-in Best-of-N parallel sampling, via src/layer3/sampler.ts's
// ParallelCandidateSampler, genuinely driving the real per-kind verifiers
// (not a fictional standalone floor). Opt-in via options.bestOfN so every
// EXISTING sequential-retry test above (which assumes exactly one LLM call
// per attempt via ScriptedLlmClient's ordered response queue) is completely
// unaffected - Best-of-N only activates when a caller explicitly asks.
// ---------------------------------------------------------------------------

describe('runCeilingAgent: opt-in Best-of-N parallel sampling (Phase 6)', () => {
  test('with no bestOfN option, behavior is byte-identical to the sequential path (regression guard)', async () => {
    const llm = new ScriptedLlmClient(['MOV X0, X1'])
    const result = await runCeilingAgent({ kind: 'instruction', description: 'MOV RAX, RBX' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
  })

  test('samples several candidates at stepped temperatures in parallel and succeeds via whichever one passes', async () => {
    // Default bestOfN config: sampleSize 4, temperatures 0.2/0.4/0.6/0.8.
    // Only the 0.8 candidate is symbolically correct.
    const llm = new TemperatureRoutedLlmClient((t) => (t === 0.8 ? 'MOV X0, X1' : 'MOV X1, X0'))

    const result = await runCeilingAgent({ kind: 'instruction', description: 'MOV RAX, RBX' }, llm, { bestOfN: {} })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.result).toBe('MOV X0, X1')
    expect(llm.callCount).toBe(4)
  })

  test('a custom sampleSize/baseTemperature/temperatureStrategy is honored', async () => {
    const llm = new TemperatureRoutedLlmClient(() => 'MOV X0, X1')

    const result = await runCeilingAgent({ kind: 'instruction', description: 'MOV RAX, RBX' }, llm, {
      bestOfN: { sampleSize: 2, baseTemperature: 0.5, temperatureStrategy: 'fixed' },
    })

    expect(result.ok).toBe(true)
    expect(llm.callCount).toBe(2)
  })

  test('when no sampled candidate passes, the round exhausts after maxRetries with real per-round failure feedback in history', async () => {
    const llm = new TemperatureRoutedLlmClient(() => 'garbage')

    await expect(
      runCeilingAgent({ kind: 'instruction', description: 'MOV RAX, RBX' }, llm, { maxRetries: 1, bestOfN: {} })
    ).rejects.toThrow(CeilingAgentExhaustedError)
  })

  test('the exhausted report carries one history entry per round, with a real gate name/details from the round', async () => {
    const llm = new TemperatureRoutedLlmClient(() => 'garbage')

    try {
      await runCeilingAgent({ kind: 'instruction', description: 'MOV RAX, RBX' }, llm, { maxRetries: 1, bestOfN: {} })
      expect.unreachable('expected runCeilingAgent to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CeilingAgentExhaustedError)
      const exhausted = error as CeilingAgentExhaustedError
      expect(exhausted.report.history).toHaveLength(1)
      expect(exhausted.report.history[0].failedGate.ok).toBe(false)
      expect(exhausted.report.history[0].failedGate.gate).not.toBe('combined')
    }
  })

  test('self-corrects across bestOfN rounds: round 1 fails, round 2 finds a passing candidate', async () => {
    let round = 0
    // Every temperature within a round returns the same thing per round, so
    // the test only depends on ROUND number, not on which of the 4 parallel
    // calls happens to be observed first.
    const llm = new TemperatureRoutedLlmClient(() => {
      round++
      return round <= 4 ? 'MOV X1, X0' : 'MOV X0, X1'
    })

    const result = await runCeilingAgent({ kind: 'instruction', description: 'MOV RAX, RBX' }, llm, { bestOfN: {} })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.history).toHaveLength(1)
  })

  test('Best-of-N also drives the topology and claim domains through the real TOPOLOGY_FLOOR/CLAIM_VERIFICATION_FLOOR', async () => {
    const llm = new TemperatureRoutedLlmClient((t) => (t === 0.8 ? JSON.stringify(GOOD_CLAIM_CANDIDATE) : 'garbage'))

    const result = await runCeilingAgent({ kind: 'claim', description: 'MOV RAX, RBX lowers to MOV X0, X1' }, llm, { bestOfN: {} })

    expect(result.ok).toBe(true)
    expect(result.gates.map((g) => g.gate)).toEqual(['structural', 'cross-reference', 'empirical'])
  })
})

// ---------------------------------------------------------------------------
// Phase 7: routing to the real SPATIAL_VERIFICATION_FLOOR (src/spatial-floor.ts,
// 'continuity'/'volumetric-bound'/'self-intersection'), through the SAME JSON
// + fence-stripping pattern verifyTopologyCandidate/verifyClaimCandidate
// already use (Phase 5/5.1) - a new domain means one new VERIFIERS/
// PROMPT_HEADERS entry, not a new branch in the retry loop itself.
// ---------------------------------------------------------------------------

const GOOD_SPATIAL_CANDIDATE: SpatialCandidate = {
  surface: { type: 'sphere', center: [0, 0, 0], radius: 1 },
  boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
}

// Fails the self-intersection gate: a negative radius is a structurally
// degenerate primitive (see spatial-floor.ts's validatePrimitiveManifold).
const DEGENERATE_SPATIAL_CANDIDATE: SpatialCandidate = {
  surface: { type: 'sphere', center: [0, 0, 0], radius: -1 },
  boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
}

describe('verifySpatialCandidate: routes through SPATIAL_VERIFICATION_FLOOR (Phase 7)', () => {
  test('a well-formed sphere strictly within its bounding box passes all three gates in order', async () => {
    const gates = await verifySpatialCandidate(JSON.stringify(GOOD_SPATIAL_CANDIDATE))
    expect(gates.map((g) => g.gate)).toEqual(['continuity', 'volumetric-bound', 'self-intersection'])
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('a degenerate (negative-radius) candidate is caught by the self-intersection gate', async () => {
    const gates = await verifySpatialCandidate(JSON.stringify(DEGENERATE_SPATIAL_CANDIDATE))
    const selfIntersection = gates.find((g) => g.gate === 'self-intersection')
    expect(selfIntersection?.ok).toBe(false)
    expect(selfIntersection?.details).toContain('radius')
  })

  test('malformed JSON is reported as a gate failure, not an uncaught exception', async () => {
    const gates = await verifySpatialCandidate('not valid json {{{')
    expect(gates).toHaveLength(1)
    expect(gates[0].ok).toBe(false)
    expect(gates[0].gate).toBe('continuity')
  })

  test('a markdown-fenced candidate is parsed and verified normally (Phase 5.1 fence-stripping applies here too)', async () => {
    const gates = await verifySpatialCandidate('```json\n' + JSON.stringify(GOOD_SPATIAL_CANDIDATE) + '\n```')
    expect(gates.every((g) => g.ok)).toBe(true)
  })
})

describe('buildPrompt: routes a spatial request to JSON instructions (Phase 7)', () => {
  test('a spatial request asks for JSON, not ARM64 or plain TypeScript instructions', () => {
    const prompt = buildPrompt({ kind: 'spatial', description: 'a sphere of radius 1 at the origin' }, [])
    expect(prompt).toContain('a sphere of radius 1 at the origin')
    expect(prompt).toContain('JSON')
    expect(prompt).not.toContain('ARM64 instruction text')
  })
})

describe('runCeilingAgent: spatial domain routing, including Best-of-N (Phase 7)', () => {
  test('accepts a well-formed spatial candidate on the first attempt (sequential path)', async () => {
    const llm = new ScriptedLlmClient([JSON.stringify(GOOD_SPATIAL_CANDIDATE)])
    const result = await runCeilingAgent({ kind: 'spatial', description: 'a sphere of radius 1 at the origin' }, llm)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.gates.map((g) => g.gate)).toEqual(['continuity', 'volumetric-bound', 'self-intersection'])
  })

  test('Best-of-N sampling generates several candidate CSG surfaces in parallel and selects the one that passes SPATIAL_VERIFICATION_FLOOR', async () => {
    // Default bestOfN config: sampleSize 4, temperatures 0.2/0.4/0.6/0.8.
    // Only the 0.8 candidate is a valid, non-degenerate, in-bounds surface.
    const llm = new TemperatureRoutedLlmClient((t) => JSON.stringify(t === 0.8 ? GOOD_SPATIAL_CANDIDATE : DEGENERATE_SPATIAL_CANDIDATE))

    const result = await runCeilingAgent(
      { kind: 'spatial', description: 'a sphere of radius 1 centered at the origin, within a [-2,2]^3 bounding box' },
      llm,
      { bestOfN: {} }
    )

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(llm.callCount).toBe(4)
    expect(result.gates.map((g) => g.gate)).toEqual(['continuity', 'volumetric-bound', 'self-intersection'])
    expect(JSON.parse(result.result)).toEqual(GOOD_SPATIAL_CANDIDATE)
  })
})
