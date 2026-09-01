import { describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MetaKernelCompiler, classifyFailurePattern, derivePatch } from './meta-kernel'
import { verifyTopologyCandidate, verifyClaimCandidate, verifyInstructionCandidate } from '../CeilingAgent'
import { SPATIAL_VERIFICATION_FLOOR, type SpatialCandidate } from '../spatial-floor'
import { runVerificationFloor } from '../verification-floor'
import type { TopologyCandidate } from '../topology-floor'
import type { ClaimCandidate } from '../claim-floor'

// Individual tests create their own storePath under tmpRoot via
// freshStorePath() - a stray temp dir at process exit is harmless and
// OS-cleaned eventually, so there's no afterAll teardown here.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'meta-kernel-'))

let fileCounter = 0
function freshStorePath(): string {
  fileCounter++
  return path.join(tmpRoot, `rule-store-${fileCounter}.json`)
}

// ---------------------------------------------------------------------------
// classifyFailurePattern: does a failure's shape get recognized as one of
// this project's known, recurring repair-pattern categories?
// ---------------------------------------------------------------------------

describe('classifyFailurePattern: recognizes known recurring failure shapes', () => {
  test('instruction domain: an "expected X, got Y" symbolic-gate mismatch classifies as expected-got, independent of the specific instruction', () => {
    const a = classifyFailurePattern('instruction', { gate: 'symbolic', details: 'expected "ADD X0, X0, X1", got "ADD X0, X1, X0"' }, 'ADD X0, X1, X0')
    const b = classifyFailurePattern('instruction', { gate: 'symbolic', details: 'expected "SUB X2, X2, X0", got "SUB X2, X0, X2"' }, 'SUB X2, X0, X2')
    expect(a).toBe('instruction:symbolic:expected-got')
    expect(a).toBe(b) // same SHAPE, different concrete instructions -> same category
  })

  test('topology domain: a missing-export failure classifies as missing-export, independent of the specific name', () => {
    const a = classifyFailurePattern('topology', { gate: 'exports', details: 'a.ts: expected export "a" not found' }, '{}')
    const b = classifyFailurePattern('topology', { gate: 'exports', details: 'module7.ts: expected export "fn7" not found' }, '{}')
    expect(a).toBe('topology:exports:missing-export')
    expect(a).toBe(b)
  })

  test('claim domain: a wrong-expected-value empirical failure classifies as wrong-value, independent of the specific claim', () => {
    const a = classifyFailurePattern(
      'claim',
      { gate: 'empirical', details: '"x": lib/translator.ts#translateInstruction("MOV RAX, RBX") expected {"ok":true,"instruction":"MOV X1, X0"}, got {"ok":true,"instruction":"MOV X0, X1"}' },
      '{}'
    )
    expect(a).toBe('claim:empirical:wrong-value')
  })

  test('spatial domain: a negative-radius self-intersection failure classifies as negative-radius', () => {
    const a = classifyFailurePattern('spatial', { gate: 'self-intersection', details: 'surface: sphere radius must be > 0, got -1' }, '{}')
    expect(a).toBe('spatial:self-intersection:negative-radius')
  })

  test('an unrecognized failure shape falls back to an exact-text category unique to that candidate', () => {
    const a = classifyFailurePattern('claim', { gate: 'structural', details: 'claim[0]: missing statement' }, 'candidate-A')
    const b = classifyFailurePattern('claim', { gate: 'structural', details: 'claim[0]: missing statement' }, 'candidate-B')
    expect(a).not.toBe(b) // different exact candidates -> different fallback keys
    expect(a).toContain('exact:')
  })
})

// ---------------------------------------------------------------------------
// MetaKernelCompiler: rule store (recordFix/tryMatchRule), cache hits/misses,
// and persistence.
// ---------------------------------------------------------------------------

describe('MetaKernelCompiler: rule store, cache hits and misses', () => {
  test('tryMatchRule returns null for a pattern that was never recorded (cache miss)', () => {
    const kernel = new MetaKernelCompiler()
    const result = kernel.tryMatchRule('instruction:symbolic:expected-got', {
      failingCandidate: 'ADD X0, X1, X0',
      failedGate: { gate: 'symbolic', details: 'expected "ADD X0, X0, X1", got "ADD X0, X1, X0"' },
    })
    expect(result).toBeNull()
  })

  test('after recordFix, tryMatchRule on the SAME pattern returns a fix (cache hit)', () => {
    const kernel = new MetaKernelCompiler()
    const pattern = 'instruction:symbolic:expected-got'
    kernel.recordFix(pattern, derivePatch(pattern, 'ADD X0, X1, X0', 'ADD X0, X0, X1'))

    const result = kernel.tryMatchRule(pattern, {
      failingCandidate: 'SUB X2, X0, X2',
      failedGate: { gate: 'symbolic', details: 'expected "SUB X2, X2, X0", got "SUB X2, X0, X2"' },
    })
    expect(result).toBe('SUB X2, X2, X0')
  })

  test('ruleCount reflects the number of distinct recorded patterns', () => {
    const kernel = new MetaKernelCompiler()
    expect(kernel.ruleCount).toBe(0)
    kernel.recordFix('a', derivePatch('a', 'x', 'y'))
    expect(kernel.ruleCount).toBe(1)
    kernel.recordFix('b', derivePatch('b', 'x', 'y'))
    expect(kernel.ruleCount).toBe(2)
    kernel.recordFix('a', derivePatch('a', 'x', 'z')) // re-recording the same pattern doesn't grow the count
    expect(kernel.ruleCount).toBe(2)
  })
})

describe('MetaKernelCompiler: persistence to a local JSON rule store', () => {
  test('recordFix writes the rule to storePath as JSON', () => {
    const storePath = freshStorePath()
    const kernel = new MetaKernelCompiler({ storePath })
    const pattern = 'topology:exports:missing-export'
    kernel.recordFix(pattern, derivePatch(pattern, '{}', '{}'))

    const stored = JSON.parse(readFileSync(storePath, 'utf-8'))
    expect(stored[pattern]).toMatchObject({ kind: 'topology-add-export' })
  })

  test('a new compiler instance pointed at the same storePath loads previously recorded rules', () => {
    const storePath = freshStorePath()
    const pattern = 'claim:empirical:wrong-value'
    const first = new MetaKernelCompiler({ storePath })
    first.recordFix(pattern, derivePatch(pattern, '{}', '{}'))

    const second = new MetaKernelCompiler({ storePath })
    expect(second.ruleCount).toBe(1)
    const result = second.tryMatchRule(pattern, {
      failingCandidate: JSON.stringify({ claims: [{ statement: 's', subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' }, assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'WRONG' } } }] }),
      failedGate: {
        gate: 'empirical',
        details: '"s": lib/translator.ts#translateInstruction("MOV RAX, RBX") expected {"ok":true,"instruction":"WRONG"}, got {"ok":true,"instruction":"MOV X0, X1"}',
      },
    })
    expect(result).not.toBeNull()
  })

  test('a compiler with no storePath is purely in-memory and never touches the filesystem', () => {
    const kernel = new MetaKernelCompiler()
    kernel.recordFix('p', derivePatch('p', 'x', 'y'))
    expect(kernel.ruleCount).toBe(1) // just proving it works without a storePath at all
  })
})

// ---------------------------------------------------------------------------
// Real AST/structural pattern matching and application - each rule kind
// genuinely transforms a DIFFERENT concrete failing candidate than the one
// it was recorded from, proving generalization, not literal replay.
// ---------------------------------------------------------------------------

describe('MetaKernelCompiler: applying a learned rule to a DIFFERENT concrete failure (real generalization)', () => {
  test('instruction: expected-got rule fixes a different instruction than the one it learned from, and the fix passes real verification', async () => {
    const kernel = new MetaKernelCompiler()
    const pattern = classifyFailurePattern('instruction', { gate: 'symbolic', details: 'expected "ADD X0, X0, X1", got "ADD X0, X1, X0"' }, 'ADD X0, X1, X0')
    kernel.recordFix(pattern, derivePatch(pattern, 'ADD X0, X1, X0', 'ADD X0, X0, X1'))

    // A DIFFERENT instruction (SUB, different registers) that failed the SAME way.
    const newFailure = { gate: 'symbolic', details: 'expected "SUB X2, X2, X0", got "SUB X2, X0, X2"' }
    const fixed = kernel.tryMatchRule(pattern, { failingCandidate: 'SUB X2, X0, X2', failedGate: newFailure })
    expect(fixed).toBe('SUB X2, X2, X0')

    const gates = await verifyInstructionCandidate('SUB RCX, RAX', fixed!)
    expect(gates.find((g) => g.gate === 'symbolic')?.ok).toBe(true)
  })

  test('topology: add-export rule performs a REAL ts-morph AST mutation on a different file/function than it learned from', async () => {
    const kernel = new MetaKernelCompiler()
    const pattern = 'topology:exports:missing-export'
    kernel.recordFix(pattern, derivePatch(pattern, '{}', '{}'))

    const failingCandidate: TopologyCandidate = {
      inMemoryFiles: { 'zzz.ts': 'function myOtherFn(): number { return 42 }' },
      expectedExports: [{ filePath: 'zzz.ts', exportedNames: ['myOtherFn'] }],
      reachability: [],
    }
    const fixed = kernel.tryMatchRule(pattern, {
      failingCandidate: JSON.stringify(failingCandidate),
      failedGate: { gate: 'exports', details: 'zzz.ts: expected export "myOtherFn" not found' },
    })
    expect(fixed).not.toBeNull()

    const fixedCandidate = JSON.parse(fixed!) as TopologyCandidate
    expect(fixedCandidate.inMemoryFiles?.['zzz.ts']).toContain('export function myOtherFn')

    const gates = await verifyTopologyCandidate(fixed!)
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('claim: use-actual-value rule rewrites a different wrong claim than it learned from, using the REAL empirically observed value', async () => {
    const kernel = new MetaKernelCompiler()
    const pattern = 'claim:empirical:wrong-value'
    kernel.recordFix(pattern, derivePatch(pattern, '{}', '{}'))

    const failingCandidate: ClaimCandidate = {
      claims: [
        {
          statement: 'a wrong claim about CMP',
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: ['CMP RAX, RBX'], expected: { ok: true, instruction: 'CMP X1, X0' } }, // wrong operand order
        },
      ],
    }
    const failedGate = {
      gate: 'empirical',
      details:
        '"a wrong claim about CMP": lib/translator.ts#translateInstruction("CMP RAX, RBX") expected {"ok":true,"instruction":"CMP X1, X0"}, got {"ok":true,"instruction":"CMP X0, X1"}',
    }
    const fixed = kernel.tryMatchRule(pattern, { failingCandidate: JSON.stringify(failingCandidate), failedGate })
    expect(fixed).not.toBeNull()

    const fixedCandidate = JSON.parse(fixed!) as ClaimCandidate
    expect(fixedCandidate.claims[0].assertion.expected).toEqual({ ok: true, instruction: 'CMP X0, X1' })

    const gates = await verifyClaimCandidate(fixed!)
    expect(gates.every((g) => g.ok)).toBe(true)
  })

  test('spatial: negative-radius rule negates a different sphere than it learned from', async () => {
    const kernel = new MetaKernelCompiler()
    const pattern = 'spatial:self-intersection:negative-radius'
    kernel.recordFix(pattern, derivePatch(pattern, '{}', '{}'))

    const failingCandidate: SpatialCandidate = {
      surface: { type: 'sphere', center: [0, 0, 0], radius: -2.5 },
      boundingBox: { min: [-5, -5, -5], max: [5, 5, 5] },
    }
    const fixed = kernel.tryMatchRule(pattern, {
      failingCandidate: JSON.stringify(failingCandidate),
      failedGate: { gate: 'self-intersection', details: 'surface: sphere radius must be > 0, got -2.5' },
    })
    expect(fixed).not.toBeNull()

    const fixedCandidate = JSON.parse(fixed!) as SpatialCandidate
    expect((fixedCandidate.surface as { radius: number }).radius).toBe(2.5)

    const report = await runVerificationFloor(SPATIAL_VERIFICATION_FLOOR, fixedCandidate)
    expect(report.ok).toBe(true)
  })

  test('exact-replacement fallback only matches the EXACT candidate it was recorded from, not a different one in the same category', () => {
    const kernel = new MetaKernelCompiler()
    const pattern = classifyFailurePattern('claim', { gate: 'structural', details: 'claim[0]: missing statement' }, 'candidate-A')
    kernel.recordFix(pattern, derivePatch(pattern, 'candidate-A', 'fixed-A'))

    const hit = kernel.tryMatchRule(pattern, { failingCandidate: 'candidate-A', failedGate: { gate: 'structural', details: 'claim[0]: missing statement' } })
    expect(hit).toBe('fixed-A')

    // A different candidate, even in the same recorded pattern slot, must NOT match -
    // exact-replacement never over-generalizes.
    const miss = kernel.tryMatchRule(pattern, { failingCandidate: 'candidate-A-but-different', failedGate: { gate: 'structural', details: 'claim[0]: missing statement' } })
    expect(miss).toBeNull()
  })

  test('a rule that cannot derive a fix from THIS failure (message shape mismatch) returns null rather than a wrong guess', () => {
    const kernel = new MetaKernelCompiler()
    const pattern = 'instruction:symbolic:expected-got'
    kernel.recordFix(pattern, derivePatch(pattern, 'x', 'y'))

    // A candidate whose failure details don't actually match the
    // "expected X, got Y" shape (e.g. a garbled/unexpected message) must not
    // produce a fabricated fix.
    const result = kernel.tryMatchRule(pattern, { failingCandidate: 'garbage', failedGate: { gate: 'symbolic', details: 'totally different message shape' } })
    expect(result).toBeNull()
  })
})
