import { describe, expect, test } from 'vitest'
import { runStaticGate, runFuzzGate, runSymbolicGate, runFloorEngine, checkPushEquivalence, checkPopEquivalence, checkPushPopRoundTrip } from './FloorEngine'

describe('Gate 1 (Static): ts-morph', () => {
  test('lib/ compiles with zero diagnostics and a verified entrypoint signature', () => {
    const result = runStaticGate()

    expect(result.gate).toBe('static')
    expect(result.ok).toBe(true)
    expect(result.details).toContain('0 diagnostics')
    expect(result.details).toContain('0 "any" usages')
  })
})

describe('Gate 2 (Fuzzing): fast-check, 1000 runs', () => {
  test('the real pipeline output satisfies determinism, register-token, and label-integrity invariants', () => {
    const result = runFuzzGate(1000)

    expect(result.gate).toBe('fuzz')
    expect(result.ok).toBe(true)
    expect(result.details).toContain('1000 property runs passed')
  }, 30000)
})

describe('Gate 3 (Symbolic): z3-solver', () => {
  test('MOV/ADD/CMP translations are proven register-file-equivalent to their x86 source', async () => {
    const result = await runSymbolicGate()

    expect(result.gate).toBe('symbolic')
    expect(result.ok).toBe(true)
    expect(result.details).toContain('Z3 proved register-file equivalence')
    expect(result.details).toContain('PUSH/POP stack transitions')
    expect(result.details).toContain('PUSH/POP round trips')
  }, 30000)

  describe('Phase 1: PUSH/POP and RSP tracking', () => {
    test('valid: the real PUSH translation is proven to decrement RSP by 8 and store at the new top of stack', async () => {
      const result = await checkPushEquivalence('PUSH RAX')

      expect(result.ok).toBe(true)
      expect(result.details).toContain('correctly decrements RSP by 8')
    })

    test('valid: the real POP translation is proven to load from the top of stack and increment RSP by 8', async () => {
      const result = await checkPopEquivalence('POP RBX')

      expect(result.ok).toBe(true)
      expect(result.details).toContain('correctly loads from the top of stack')
    })

    test('valid: a PUSH followed by a POP of the same register is proven to restore both the register and RSP', async () => {
      const result = await checkPushPopRoundTrip('RDI')

      expect(result.ok).toBe(true)
      expect(result.details).toContain('restores both X4 and RSP')
    })

    test('invalid: a PUSH candidate with the wrong stack offset is rejected with a Z3 disagreement', async () => {
      const result = await checkPushEquivalence('PUSH RAX', 'STR X0, [SP, #-4]!')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('Z3 disproved PUSH equivalence')
    })

    test('invalid: a PUSH candidate referencing the wrong register is rejected', async () => {
      const result = await checkPushEquivalence('PUSH RAX', 'STR X2, [SP, #-8]!')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('expected destination register X0')
    })

    test('invalid: a PUSH candidate using post-indexed (POP-shaped) addressing is rejected by shape', async () => {
      const result = await checkPushEquivalence('PUSH RAX', 'STR X0, [SP], #-8')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('expected "STR X0, [SP, #-8]!" shape')
    })

    test('invalid: a POP candidate with the wrong stack offset is rejected with a Z3 disagreement', async () => {
      const result = await checkPopEquivalence('POP RBX', 'LDR X1, [SP], #4')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('Z3 disproved POP equivalence')
    })

    test('invalid: a POP candidate referencing the wrong register is rejected', async () => {
      const result = await checkPopEquivalence('POP RBX', 'LDR X3, [SP], #8')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('expected destination register X1')
    })

    test('invalid: mismatched PUSH/POP offsets in a round trip fail to restore RSP, caught by Z3', async () => {
      const result = await checkPushPopRoundTrip('RAX', 'STR X0, [SP, #-8]!\nLDR X0, [SP], #4')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('Z3 disproved the PUSH/POP round trip')
    })

    test('invalid: a round trip missing its POP line is rejected as malformed rather than silently passing', async () => {
      const result = await checkPushPopRoundTrip('RAX', 'STR X0, [SP, #-8]!')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('expected a 2-line PUSH+POP program')
    })
  })
})

describe('runFloorEngine', () => {
  test('all three gates pass together and the aggregate report is ok', async () => {
    const report = await runFloorEngine()

    expect(report.gates.map((g) => g.gate)).toEqual(['static', 'fuzz', 'symbolic'])
    expect(report.gates.every((g) => g.ok)).toBe(true)
    expect(report.ok).toBe(true)
  }, 30000)
})
