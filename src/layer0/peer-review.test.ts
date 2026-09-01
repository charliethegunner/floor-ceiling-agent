import { describe, test, expect } from 'vitest'
import { reviewQa, reviewSecurity, reviewArchitect, runPeerReview } from './peer-review'
import type { CeilingRequest, CeilingSuccess, LlmClient } from '../CeilingAgent'
import type { ClaimCandidate } from '../claim-floor'

function claimSuccess(claims: ClaimCandidate['claims']): CeilingSuccess {
  return { ok: true, result: JSON.stringify({ claims }), attempts: 1, gates: [], history: [] }
}

function patchSuccess(source: string): CeilingSuccess {
  return { ok: true, result: source, attempts: 1, gates: [], history: [] }
}

const CLAIM_REQUEST: CeilingRequest = { kind: 'claim', description: 'a claim about translateInstruction' }
const PATCH_REQUEST: CeilingRequest = { kind: 'patch', description: 'a patch' }

// ---------------------------------------------------------------------------
// QA: real dynamic import + real empirical execution against
// lib/translator.ts#translateInstruction (an already-committed, trusted
// function - the exact same one claim-floor.ts's own tests exercise).
// ---------------------------------------------------------------------------

describe('reviewQa: real empirical re-check + adversarial counterexamples, claim candidates only', () => {
  test('not applicable to non-claim kinds - reports ok with zero checks, never fabricates a check', async () => {
    const review = await reviewQa(PATCH_REQUEST, patchSuccess('export function f() { return 1 }'))
    expect(review).toEqual({ role: 'qa', ok: true, checkedClaims: 0, findings: [] })
  })

  test('a genuinely stable, well-behaved claim about a real function passes both checks', async () => {
    const success = claimSuccess([
      {
        statement: 'translateInstruction translates MOV RAX, RBX to MOV X0, X1',
        subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
        assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X0, X1' } },
      },
    ])
    const review = await reviewQa(CLAIM_REQUEST, success)
    expect(review.ok).toBe(true)
    expect(review.checkedClaims).toBe(1)
    expect(review.findings).toEqual([])
  })

  test('a claim whose subject module/export does not exist is silently skipped (already caught by the primary floor, not re-reported here)', async () => {
    const success = claimSuccess([
      {
        statement: 'a hallucinated claim',
        subject: { modulePath: 'lib/does-not-exist.ts', exportName: 'nope' },
        assertion: { args: [], expected: null },
      },
    ])
    const review = await reviewQa(CLAIM_REQUEST, success)
    expect(review.ok).toBe(true)
    expect(review.findings).toEqual([])
  })

  test('a genuinely non-deterministic subject function is caught by the real repeat-call check', async () => {
    const success = claimSuccess([
      {
        statement: 'a flaky claim',
        subject: { modulePath: 'src/layer0/__fixtures__/flaky-subject.ts', exportName: 'flakyDouble' },
        assertion: { args: [2], expected: 4 },
      },
    ])
    const review = await reviewQa(CLAIM_REQUEST, success)
    expect(review.ok).toBe(false)
    expect(review.findings).toHaveLength(1)
    expect(review.findings[0].description).toMatch(/non-deterministic/)
  })

  test('a subject function that crashes on a boundary-mutated argument is caught by the real adversarial check, without needing any fabricated expected value', async () => {
    const success = claimSuccess([
      {
        statement: 'a claim about a function that only works for non-empty strings',
        subject: { modulePath: 'src/layer0/__fixtures__/flaky-subject.ts', exportName: 'firstCharCode' },
        assertion: { args: ['A'], expected: 65 },
      },
    ])
    const review = await reviewQa(CLAIM_REQUEST, success)
    expect(review.ok).toBe(false)
    expect(review.findings.some((f) => /boundary variant/.test(f.description))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Security: mechanical AST scan, patch candidates only.
// ---------------------------------------------------------------------------

describe('reviewSecurity: real ts-morph AST scan for dangerous patterns, patch candidates only', () => {
  test('not applicable to non-patch kinds', () => {
    const review = reviewSecurity(CLAIM_REQUEST, claimSuccess([]))
    expect(review).toEqual({ role: 'security', ok: true, findings: [] })
  })

  test('a clean patch candidate passes with zero findings', () => {
    const review = reviewSecurity(PATCH_REQUEST, patchSuccess('export function add(a: number, b: number): number { return a + b }'))
    expect(review.ok).toBe(true)
    expect(review.findings).toEqual([])
  })

  test.each([
    ['eval()', `export function f(): number { return eval('1+1') }`],
    ['Function() constructor call', `export function f(): unknown { const g = Function('return 1'); return g() }`],
    ['new Function()', `export function f(): unknown { const g = new Function('return 1'); return g() }`],
    ['child_process import', `import { exec } from 'child_process'\nexport function f(): void { exec('ls') }`],
    ['node:child_process import', `import { exec } from 'node:child_process'\nexport function f(): void { exec('ls') }`],
    ['require("child_process")', `export function f(): void { const cp = require('child_process'); cp.exec('ls') }`],
    ['fs.writeFileSync', `import * as fs from 'fs'\nexport function f(): void { fs.writeFileSync('x', 'y') }`],
    ['fs.unlinkSync', `import * as fs from 'fs'\nexport function f(): void { fs.unlinkSync('x') }`],
  ])('flags a real, concrete finding for %s', (_label, source) => {
    const review = reviewSecurity(PATCH_REQUEST, patchSuccess(source))
    expect(review.ok).toBe(false)
    expect(review.findings.length).toBeGreaterThan(0)
  })

  test('never false-positives on an identifier or string that merely contains a dangerous word', () => {
    const source = `
      export function evaluate(x: number): number { return x * 2 }
      export function describe(s: string): string { return s.includes('eval') ? 'yes' : 'no' }
    `
    const review = reviewSecurity(PATCH_REQUEST, patchSuccess(source))
    expect(review.ok).toBe(true)
    expect(review.findings).toEqual([])
  })

  test('unparseable candidate text is not re-reported here - already caught by the primary floor\'s static gate', () => {
    const review = reviewSecurity(PATCH_REQUEST, patchSuccess('this is not { valid typescript ('))
    expect(review.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Architect: advisory only, structurally cannot flip anything.
// ---------------------------------------------------------------------------

class OpinionatedLlmClient implements LlmClient {
  constructor(private readonly opinion: string) {}
  async complete(): Promise<string> {
    return this.opinion
  }
}

describe('reviewArchitect: LLM-generated advisory commentary, structurally non-blocking', () => {
  test('returns the raw commentary text, trimmed', async () => {
    const llm = new OpinionatedLlmClient('  Consider renaming this for clarity.  ')
    const review = await reviewArchitect(PATCH_REQUEST, patchSuccess('export function f(){return 1}'), llm)
    expect(review).toEqual({ role: 'architect', advisory: true, commentary: 'Consider renaming this for clarity.' })
  })

  test('ArchitectReviewResult has no ok field - there is nothing a caller could even read to gate on', async () => {
    const llm = new OpinionatedLlmClient('FAIL: this is terrible and should be rejected')
    const review = await reviewArchitect(PATCH_REQUEST, patchSuccess('export function f(){return 1}'), llm)
    expect('ok' in review).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Aggregate: proves the actual invariant end-to-end - even a maximally
// negative-sounding Architect opinion cannot flip PeerReviewResult.ok.
// ---------------------------------------------------------------------------

describe('runPeerReview: deterministic QA + Security gate ok, Architect never does', () => {
  test('a clean patch candidate: all three reviewers run, ok is true regardless of Architect wording', async () => {
    const llm = new OpinionatedLlmClient('REJECTED. This code is completely unacceptable and must be blocked.')
    const review = await runPeerReview(PATCH_REQUEST, patchSuccess('export function add(a: number, b: number): number { return a + b }'), { llm })

    expect(review.qa.ok).toBe(true)
    expect(review.security.ok).toBe(true)
    expect(review.architect?.commentary).toMatch(/REJECTED/)
    expect(review.ok).toBe(true) // Architect's hostile wording changed nothing
  })

  test('a genuine Security finding flips ok to false, independent of Architect', async () => {
    const llm = new OpinionatedLlmClient('Looks great, nicely done!')
    const review = await runPeerReview(PATCH_REQUEST, patchSuccess(`export function f(): number { return eval('1') }`), { llm })

    expect(review.security.ok).toBe(false)
    expect(review.ok).toBe(false) // a real deterministic finding gates, even though Architect was glowing
  })

  test('includeArchitect: false skips the LLM call entirely', async () => {
    let called = false
    const llm: LlmClient = {
      async complete() {
        called = true
        return 'should never be reached'
      },
    }
    const review = await runPeerReview(PATCH_REQUEST, patchSuccess('export function f(): number { return 1 }'), { llm, includeArchitect: false })
    expect(called).toBe(false)
    expect(review.architect).toBeUndefined()
    expect(review.ok).toBe(true)
  })
})
