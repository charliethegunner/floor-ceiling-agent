import { Project } from 'ts-morph'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { deepStrictEqual } from 'node:assert'
import type { VerificationFloor, GateOutcome } from './verification-floor'

// A concrete VerificationFloor for "claims": structured assertions that a
// SPECIFIC, ALREADY-COMMITTED function in this repository, called with
// specific data arguments, returns a specific result - e.g. "claim:
// lib/translator.ts#translateInstruction('MOV RAX, RBX') returns
// {ok:true, instruction:'MOV X0, X1'}".
//
// A safety scope this floor holds deliberately, matching the rest of this
// codebase: it only ever imports and calls functions that already exist as
// committed source in this repository (trusted, reviewed code), with
// claim-supplied DATA as arguments - never arbitrary or dynamically
// constructed CODE. That's exactly what this project's own test suite
// already does everywhere (e.g. `translateInstruction('MOV RAX, RBX')` -
// the string is data, not code) - it crosses no new execution boundary.
// A "claim" about arbitrary/untrusted code (e.g. an LLM-proposed function
// body) would be a materially different, riskier feature - CeilingAgent.ts's
// verifyPatchCandidate and the Topology floor both deliberately stay
// static-analysis-only for exactly that reason, and this floor does not
// change that posture.

export interface ClaimSubject {
  /** Module path to import, relative to the process working directory, e.g. 'lib/translator.ts'. */
  modulePath: string
  /** The exported function name to call. */
  exportName: string
}

export interface ClaimAssertion {
  args: unknown[]
  expected: unknown
}

export interface Claim {
  statement: string
  subject: ClaimSubject
  assertion: ClaimAssertion
}

export interface ClaimCandidate {
  claims: Claim[]
  tsConfigFilePath?: string
}

export type ClaimGateName = 'structural' | 'cross-reference' | 'empirical'

// ---------------------------------------------------------------------------
// Gate: structural - the claim objects themselves are well-formed. Purely a
// shape check, no I/O, mirroring the "static" gate pattern used by every
// other floor in this codebase.
// ---------------------------------------------------------------------------

function checkStructural(candidate: ClaimCandidate): GateOutcome<'structural'> {
  const problems: string[] = []
  candidate.claims.forEach((claim, i) => {
    if (!claim.statement) problems.push(`claim[${i}]: missing statement`)
    if (!claim.subject?.modulePath) problems.push(`claim[${i}]: missing subject.modulePath`)
    if (!claim.subject?.exportName) problems.push(`claim[${i}]: missing subject.exportName`)
    if (!Array.isArray(claim.assertion?.args)) problems.push(`claim[${i}]: assertion.args must be an array`)
    if (!claim.assertion || !('expected' in claim.assertion)) problems.push(`claim[${i}]: missing assertion.expected`)
  })

  return problems.length === 0
    ? { gate: 'structural', ok: true, details: `${candidate.claims.length} claim(s) well-formed` }
    : { gate: 'structural', ok: false, details: problems.join('; ') }
}

// ---------------------------------------------------------------------------
// Gate: cross-reference - does the claimed module actually export the
// claimed name? Catches the common failure mode of a claim referencing a
// typo'd or hallucinated symbol before ever attempting to run anything -
// static AST analysis via ts-morph, same technique as the Topology floor's
// exports gate.
// ---------------------------------------------------------------------------

function checkCrossReference(candidate: ClaimCandidate): GateOutcome<'cross-reference'> {
  const project = new Project({ tsConfigFilePath: candidate.tsConfigFilePath ?? 'tsconfig.json' })
  const problems: string[] = []

  candidate.claims.forEach((claim, i) => {
    const file = project.addSourceFileAtPathIfExists(claim.subject.modulePath)
    if (!file) {
      problems.push(`claim[${i}]: module "${claim.subject.modulePath}" not found`)
      return
    }
    if (!file.getExportedDeclarations().has(claim.subject.exportName)) {
      problems.push(`claim[${i}]: "${claim.subject.modulePath}" does not export "${claim.subject.exportName}"`)
    }
  })

  return problems.length === 0
    ? { gate: 'cross-reference', ok: true, details: `${candidate.claims.length} claim(s) reference real, existing exports` }
    : { gate: 'cross-reference', ok: false, details: problems.join('; ') }
}

// ---------------------------------------------------------------------------
// Gate: empirical - actually imports and calls the claimed function with the
// claimed arguments, comparing the real result against the claimed expected
// value. `@vite-ignore` tells Vite (which vitest runs on) not to attempt
// static analysis of this runtime-computed import path - confirmed working
// via a standalone smoke test before this was built on top of it.
// ---------------------------------------------------------------------------

export async function importModule(modulePath: string): Promise<Record<string, unknown>> {
  const absolutePath = path.resolve(process.cwd(), modulePath)
  const url = pathToFileURL(absolutePath).href
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>
}

export function valuesEqual(actual: unknown, expected: unknown): boolean {
  try {
    deepStrictEqual(actual, expected)
    return true
  } catch {
    return false
  }
}

// A live benchmark run (scripts/benchmark-live.ts) found models resubmitting
// an identical wrong claim across every retry, because the old "expected X,
// got Y" message only echoed the model's own (possibly inaccurate) prose
// statement - it never showed what was actually called. describeCall makes
// the counterexample self-contained: the exact module#export(args) that was
// really invoked, independent of whatever the statement claims.
function describeCall(claim: Claim): string {
  const args = claim.assertion.args.map((arg) => JSON.stringify(arg)).join(', ')
  return `${claim.subject.modulePath}#${claim.subject.exportName}(${args})`
}

async function checkEmpirical(candidate: ClaimCandidate): Promise<GateOutcome<'empirical'>> {
  const failures: string[] = []

  for (const claim of candidate.claims) {
    try {
      const mod = await importModule(claim.subject.modulePath)
      const fn = mod[claim.subject.exportName]
      if (typeof fn !== 'function') {
        failures.push(`"${claim.statement}": ${describeCall(claim)} is not callable`)
        continue
      }
      const actual: unknown = await fn(...claim.assertion.args)
      if (!valuesEqual(actual, claim.assertion.expected)) {
        failures.push(`"${claim.statement}": ${describeCall(claim)} expected ${JSON.stringify(claim.assertion.expected)}, got ${JSON.stringify(actual)}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stackTrace = error instanceof Error && error.stack ? `\nStack trace:\n${error.stack}` : ''
      failures.push(`"${claim.statement}": ${describeCall(claim)} threw ${message}${stackTrace}`)
    }
  }

  return failures.length === 0
    ? { gate: 'empirical', ok: true, details: `${candidate.claims.length} claim(s) empirically verified by execution` }
    : { gate: 'empirical', ok: false, details: failures.join('; ') }
}

// ---------------------------------------------------------------------------

export const CLAIM_VERIFICATION_FLOOR: VerificationFloor<ClaimCandidate, ClaimGateName> = {
  domain: 'claim-verification',
  gates: [
    { name: 'structural', check: checkStructural },
    { name: 'cross-reference', check: checkCrossReference },
    { name: 'empirical', check: checkEmpirical },
  ],
}
