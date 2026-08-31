import { describe, expect, test } from 'vitest'
import {
  runStaticGate,
  runFuzzGate,
  runSymbolicGate,
  runFloorEngine,
  checkPushEquivalence,
  checkPopEquivalence,
  checkPushPopRoundTrip,
  checkMemoryEquivalence,
} from './FloorEngine'

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
    expect(result.details).toContain('SIB/displacement memory load-store cases')
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

  describe('Phase 1b: SIB addressing and memory displacements', () => {
    test('valid: a plain memory load with no displacement is proven equivalent', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX]')

      expect(result.ok).toBe(true)
      expect(result.details).toContain('same effective address and loaded value')
    })

    test('valid: a plain memory store is proven equivalent', async () => {
      const result = await checkMemoryEquivalence('MOV [RBX], RAX')

      expect(result.ok).toBe(true)
      expect(result.details).toContain('same effective address and resulting memory state')
    })

    test('valid: a plain memory load with a displacement is proven equivalent', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX + 16]')

      expect(result.ok).toBe(true)
    })

    test('valid: a SIB load with no displacement is proven equivalent, including the scale-to-shift mapping', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX + RCX*4]')

      expect(result.ok).toBe(true)
    })

    test('valid: a SIB store with a displacement (the two-instruction scratch-register form) is proven equivalent', async () => {
      const result = await checkMemoryEquivalence('MOV [RBX + RCX*4 + 32], RAX')

      expect(result.ok).toBe(true)
    })

    test('valid: a SIB load with a displacement is proven equivalent', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX + RCX*4 + 32]')

      expect(result.ok).toBe(true)
    })

    test('invalid: a plain load with the wrong displacement is rejected with a Z3 disagreement', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX + 16]', 'LDR X0, [X1, #8]')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('Z3 disproved memory load equivalence')
    })

    test('invalid: a SIB load with the wrong shift (scale 4 mapped to LSL #1 instead of #2) is rejected', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX + RCX*4]', 'LDR X0, [X1, X2, LSL #1]')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('Z3 disproved memory load equivalence')
    })

    test('invalid: a candidate referencing the wrong base register is rejected', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX]', 'LDR X0, [X2]')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('expected base register X1, got X2')
    })

    test('invalid: a candidate referencing the wrong index register is rejected', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX + RCX*4]', 'LDR X0, [X1, X3, LSL #2]')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('expected index register X2, got X3')
    })

    test('invalid: a SIB+displacement load candidate missing its displacement disagrees on the computed address', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX + RCX*4 + 32]', 'LDR X0, [X1, X2, LSL #2]')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('Z3 disproved memory load equivalence')
    })

    test('invalid: a two-instruction candidate using the wrong scratch register is rejected as malformed', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX + RCX*4 + 32]', 'ADD X5, X1, #32\nLDR X0, [X5, X2, LSL #2]')

      expect(result.ok).toBe(false)
      expect(result.details).toContain('expected the scratch register to be X9')
    })
  })

  describe('Phase 3.1: case-folding normalization', () => {
    test('a lowercase PUSH candidate is still proven equivalent', async () => {
      const result = await checkPushEquivalence('PUSH RAX', 'str x0, [sp, #-8]!')
      expect(result.ok).toBe(true)
    })

    test('a lowercase POP candidate is still proven equivalent', async () => {
      const result = await checkPopEquivalence('POP RBX', 'ldr x1, [sp], #8')
      expect(result.ok).toBe(true)
    })

    test('a lowercase PUSH+POP round trip is still proven equivalent', async () => {
      const result = await checkPushPopRoundTrip('RAX', 'str x0, [sp, #-8]!\nldr x0, [sp], #8')
      expect(result.ok).toBe(true)
    })

    test('a lowercase SIB memory candidate is still proven equivalent', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX + RCX*4]', 'ldr x0, [x1, x2, lsl #2]')
      expect(result.ok).toBe(true)
    })

    test('a mixed-case memory candidate is still proven equivalent', async () => {
      const result = await checkMemoryEquivalence('MOV RAX, [RBX + 16]', 'Ldr X0, [x1, #16]')
      expect(result.ok).toBe(true)
    })

    test('case-folding does not mask a genuine wrong-offset bug (still lowercase)', async () => {
      const result = await checkPushEquivalence('PUSH RAX', 'str x0, [sp, #-4]!')
      expect(result.ok).toBe(false)
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
