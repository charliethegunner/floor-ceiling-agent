import { describe, expect, test } from 'vitest'
import { CLAIM_VERIFICATION_FLOOR, type ClaimCandidate } from './claim-floor'
import { runVerificationFloor } from './verification-floor'

function runGate(name: 'structural' | 'cross-reference' | 'empirical', candidate: ClaimCandidate) {
  const gate = CLAIM_VERIFICATION_FLOOR.gates.find((g) => g.name === name)
  if (!gate) throw new Error(`no such gate: ${name}`)
  return gate.check(candidate)
}

describe('CLAIM_VERIFICATION_FLOOR: structural gate', () => {
  test('a well-formed claim passes', async () => {
    const result = await runGate('structural', {
      claims: [
        {
          statement: 'translateInstruction lowers MOV RAX, RBX to MOV X0, X1',
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X0, X1' } },
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.details).toContain('1 claim(s) well-formed')
  })

  test('a claim missing required fields is caught', async () => {
    const result = await runGate('structural', {
      claims: [
        // @ts-expect-error deliberately malformed for the test
        { statement: 'incomplete claim', subject: { modulePath: 'lib/translator.ts' } },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('missing subject.exportName')
    expect(result.details).toContain('assertion.args must be an array')
  })
})

describe('CLAIM_VERIFICATION_FLOOR: cross-reference gate', () => {
  test('a claim referencing a real export passes', async () => {
    const result = await runGate('cross-reference', {
      claims: [
        {
          statement: 'translateInstruction exists',
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: [], expected: null },
        },
      ],
    })

    expect(result.ok).toBe(true)
  })

  test('a claim referencing a nonexistent module is caught', async () => {
    const result = await runGate('cross-reference', {
      claims: [
        {
          statement: 'nonsense claim',
          subject: { modulePath: 'lib/does-not-exist.ts', exportName: 'anything' },
          assertion: { args: [], expected: null },
        },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('module "lib/does-not-exist.ts" not found')
  })

  test('a claim referencing a hallucinated export name on a real module is caught', async () => {
    const result = await runGate('cross-reference', {
      claims: [
        {
          statement: 'nonsense export claim',
          subject: { modulePath: 'lib/translator.ts', exportName: 'thisFunctionDoesNotExist' },
          assertion: { args: [], expected: null },
        },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('does not export "thisFunctionDoesNotExist"')
  })
})

describe('CLAIM_VERIFICATION_FLOOR: empirical gate (real execution against this repo\'s own functions)', () => {
  test('a true claim about translateInstruction is empirically verified', async () => {
    const result = await runGate('empirical', {
      claims: [
        {
          statement: 'translateInstruction lowers MOV RAX, RBX to MOV X0, X1',
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X0, X1' } },
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.details).toContain('empirically verified by execution')
  })

  test('a true claim about the full pipeline (translateX86ToArm64) is empirically verified', async () => {
    const result = await runGate('empirical', {
      claims: [
        {
          statement: 'translateX86ToArm64 lowers ADD RAX, RBX to ADD X0, X0, X1',
          subject: { modulePath: 'lib/index.ts', exportName: 'translateX86ToArm64' },
          assertion: { args: ['ADD RAX, RBX'], expected: { ok: true, instruction: 'ADD X0, X0, X1' } },
        },
      ],
    })

    expect(result.ok).toBe(true)
  })

  test('a false claim (wrong expected value) is caught by actually running the function', async () => {
    const result = await runGate('empirical', {
      claims: [
        {
          statement: 'a deliberately wrong claim',
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X1, X0' } },
        },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('expected')
    expect(result.details).toContain('got')
  })

  test('a claim whose function throws is reported as a failure, not an uncaught exception', async () => {
    const result = await runGate('empirical', {
      claims: [
        {
          statement: 'a claim that will throw',
          subject: { modulePath: 'lib/cfg.ts', exportName: 'buildControlFlowGraph' },
          assertion: { args: ['dup:\nMOV RAX, RBX\ndup:\nMOV RCX, RDX'], expected: { ok: true, blocks: [], successors: {}, predecessors: {} } },
        },
      ],
    })

    // buildControlFlowGraph doesn't throw for a duplicate label - it returns
    // a CfgError - so this exercises the "wrong value" path, not the "threw"
    // path, and is a useful assertion in its own right: it's a real,
    // deterministic disagreement the gate must catch.
    expect(result.ok).toBe(false)
  })

  test('a claim whose call genuinely throws (missing argument) is caught, not left as an uncaught exception', async () => {
    const result = await runGate('empirical', {
      claims: [
        {
          statement: 'calling translateInstruction with no argument',
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: [], expected: { ok: false, error: 'anything' } },
        },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('threw')
  })

  test('a claim naming a non-callable export is caught', async () => {
    const result = await runGate('empirical', {
      claims: [
        {
          statement: 'registerMap is not a function',
          subject: { modulePath: 'lib/translator.ts', exportName: 'registerMap' },
          assertion: { args: [], expected: null },
        },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('is not callable')
  })
})

describe('CLAIM_VERIFICATION_FLOOR: full floor via runVerificationFloor', () => {
  test('all three gates pass together for a genuinely true, well-formed claim', async () => {
    const candidate: ClaimCandidate = {
      claims: [
        {
          statement: 'translateInstruction lowers CMP RAX, RBX to CMP X0, X1',
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: ['CMP RAX, RBX'], expected: { ok: true, instruction: 'CMP X0, X1' } },
        },
      ],
    }

    const report = await runVerificationFloor(CLAIM_VERIFICATION_FLOOR, candidate)

    expect(report.domain).toBe('claim-verification')
    expect(report.gates.map((g) => g.gate)).toEqual(['structural', 'cross-reference', 'empirical'])
    expect(report.ok).toBe(true)
  })
})
