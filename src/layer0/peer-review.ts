import { Project, SyntaxKind } from 'ts-morph'
import type { CeilingRequest, CeilingSuccess, LlmClient } from '../CeilingAgent'
import { stripJsonFences } from '../CeilingAgent'
import { importModule, valuesEqual, type ClaimCandidate } from '../claim-floor'

// Phase 14.5.3: multi-agent peer review, scoped deliberately to keep the
// project's zero-hallucination gate intact - see the design discussion this
// module implements: QA and Security are both real, deterministic,
// empirically-grounded checks that CAN report a genuine finding; Architect
// is LLM-generated commentary that is structurally incapable of doing so
// (ArchitectReviewResult carries no `ok` field at all, and runPeerReview's
// aggregate `ok` never reads it). A naive "three LLM personas vote" design
// would be exactly the kind of unverified-opinion-gates-correctness pattern
// this codebase has refused everywhere else (see verifyPatchCandidate's own
// refusal to execute untrusted code, and CLAIM_VERIFICATION_FLOOR's
// empirical-not-vibes gate) - this module does not relax that.

// ---------------------------------------------------------------------------
// QA: applies only to 'claim' candidates - the one domain where empirical
// execution of already-committed, trusted code is already this project's
// established practice (claim-floor.ts). Two real, ground-truth-free checks
// per claim, both reusing the exact same importModule/valuesEqual claim-floor
// already verifies candidates with:
//
// 1. Empirical re-check: the SAME call, repeated, must be stable. A claim
//    that only happened to pass once (hidden non-determinism, mutable
//    module state) is caught here even though it passed the primary floor.
// 2. Adversarial counterexample: a boundary-mutated variant of each argument
//    must not throw where the original, verified call didn't. No fabricated
//    expected value is needed - this only checks for a crash, not for a
//    specific output.
// ---------------------------------------------------------------------------

export interface QaFinding {
  claim: string
  description: string
}

export interface QaReviewResult {
  role: 'qa'
  ok: boolean
  checkedClaims: number
  findings: QaFinding[]
}

function mutateArg(arg: unknown): unknown {
  if (typeof arg === 'string') return ''
  if (typeof arg === 'number') return Number.isInteger(arg) ? 0 : arg
  if (Array.isArray(arg)) return []
  if (typeof arg === 'boolean') return !arg
  return arg
}

export async function reviewQa(request: CeilingRequest, success: CeilingSuccess): Promise<QaReviewResult> {
  if (request.kind !== 'claim') {
    return { role: 'qa', ok: true, checkedClaims: 0, findings: [] }
  }

  let candidate: ClaimCandidate
  try {
    candidate = JSON.parse(stripJsonFences(success.result)) as ClaimCandidate
  } catch {
    return { role: 'qa', ok: true, checkedClaims: 0, findings: [] } // malformed JSON is already caught by the primary floor
  }

  const findings: QaFinding[] = []

  for (const claim of candidate.claims) {
    let fn: unknown
    try {
      const mod = await importModule(claim.subject.modulePath)
      fn = mod[claim.subject.exportName]
    } catch {
      continue // module resolution failure is already caught by the primary floor
    }
    if (typeof fn !== 'function') continue // already caught by the primary floor

    try {
      const first = await fn(...claim.assertion.args)
      const repeat = await fn(...claim.assertion.args)
      if (!valuesEqual(repeat, first)) {
        findings.push({
          claim: claim.statement,
          description: `repeated call to ${claim.subject.exportName}(...) is non-deterministic: got ${JSON.stringify(first)} then ${JSON.stringify(repeat)} for the same arguments`,
        })
      }
    } catch {
      continue // the primary floor's own empirical gate already reports a throwing original call
    }

    for (let i = 0; i < claim.assertion.args.length; i++) {
      const original = claim.assertion.args[i]
      const mutated = mutateArg(original)
      if (valuesEqual(mutated, original)) continue // no real mutation available for this argument's type

      const mutatedArgs = [...claim.assertion.args]
      mutatedArgs[i] = mutated
      try {
        await fn(...mutatedArgs)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        findings.push({
          claim: claim.statement,
          description: `${claim.subject.exportName}(...) throws on a boundary variant of argument ${i} (${JSON.stringify(original)} -> ${JSON.stringify(mutated)}): ${message}`,
        })
      }
    }
  }

  return { role: 'qa', ok: findings.length === 0, checkedClaims: candidate.claims.length, findings }
}

// ---------------------------------------------------------------------------
// Security: mechanical, deterministic static analysis over 'patch'
// candidates (the only domain whose candidate text IS TypeScript source -
// see verifyPatchCandidate). AST-based via ts-morph (already a project
// dependency, same in-memory-only technique verifyPatchCandidate itself
// uses) rather than naive text/regex matching, so a string literal or
// identifier that merely CONTAINS "eval" (e.g. `evaluate`, `"eval mode"`)
// is never a false positive - confirmed in a spike before this was written.
// ---------------------------------------------------------------------------

export interface SecurityReviewResult {
  role: 'security'
  ok: boolean
  findings: string[]
}

const DANGEROUS_CALLEE_NAMES = new Set(['eval', 'Function'])
const UNSAFE_FS_METHOD_PATTERN = /\.(writeFileSync|writeFile|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|chmod|chmodSync|appendFile|appendFileSync)\b/

function scanForDangerousPatterns(source: string): string[] {
  const project = new Project({ useInMemoryFileSystem: true })
  let file
  try {
    file = project.createSourceFile('candidate.ts', source)
  } catch {
    return [] // unparseable source is already caught by the primary floor's static gate
  }

  const findings: string[] = []

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const exprText = call.getExpression().getText()
    if (DANGEROUS_CALLEE_NAMES.has(exprText)) {
      findings.push(`line ${call.getStartLineNumber()}: call to ${exprText}() is not permitted`)
    }
    if (exprText === 'require') {
      const arg = call.getArguments()[0]?.getText().replace(/^['"]|['"]$/g, '')
      if (arg === 'child_process' || arg === 'node:child_process') {
        findings.push(`line ${call.getStartLineNumber()}: require("${arg}") is not permitted`)
      }
    }
    if (call.getExpression().getKind() === SyntaxKind.PropertyAccessExpression && UNSAFE_FS_METHOD_PATTERN.test(exprText)) {
      findings.push(`line ${call.getStartLineNumber()}: call to ${exprText}() is not permitted`)
    }
  }

  for (const newExpr of file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    if (newExpr.getExpression().getText() === 'Function') {
      findings.push(`line ${newExpr.getStartLineNumber()}: "new Function()" is not permitted`)
    }
  }

  for (const importDecl of file.getImportDeclarations()) {
    const spec = importDecl.getModuleSpecifierValue()
    if (spec === 'child_process' || spec === 'node:child_process') {
      findings.push(`line ${importDecl.getStartLineNumber()}: import of "${spec}" is not permitted`)
    }
  }

  return findings
}

export function reviewSecurity(request: CeilingRequest, success: CeilingSuccess): SecurityReviewResult {
  if (request.kind !== 'patch') {
    return { role: 'security', ok: true, findings: [] }
  }
  const findings = scanForDangerousPatterns(success.result)
  return { role: 'security', ok: findings.length === 0, findings }
}

// ---------------------------------------------------------------------------
// Architect: LLM-generated advisory commentary. Deliberately carries no
// `ok` field - there is nothing for a caller to read that could gate
// anything on it, by construction, not by convention.
// ---------------------------------------------------------------------------

export interface ArchitectReviewResult {
  role: 'architect'
  advisory: true
  commentary: string
}

function buildArchitectPrompt(request: CeilingRequest, success: CeilingSuccess): string {
  return [
    `A candidate has already passed real, mechanical verification for a "${request.kind}" request: "${request.description}".`,
    `The verified result:`,
    success.result,
    ``,
    `Give brief, advisory commentary only (style, clarity, possible improvements). This is non-blocking - it cannot change the verified pass/fail outcome, so do not phrase it as a verdict.`,
  ].join('\n')
}

export async function reviewArchitect(request: CeilingRequest, success: CeilingSuccess, llm: LlmClient): Promise<ArchitectReviewResult> {
  const commentary = await llm.complete(buildArchitectPrompt(request, success))
  return { role: 'architect', advisory: true, commentary: commentary.trim() }
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export interface PeerReviewOptions {
  llm: LlmClient
  /** Default true - set false to skip the Architect commentary call entirely (no LLM/network cost). */
  includeArchitect?: boolean
}

export interface PeerReviewResult {
  qa: QaReviewResult
  security: SecurityReviewResult
  architect?: ArchitectReviewResult
  /** True only when every deterministic reviewer (qa, security) passed.
   *  Architect's commentary is never read here - see reviewArchitect. */
  ok: boolean
}

export async function runPeerReview(request: CeilingRequest, success: CeilingSuccess, options: PeerReviewOptions): Promise<PeerReviewResult> {
  const [qa, security, architect] = await Promise.all([
    reviewQa(request, success),
    Promise.resolve(reviewSecurity(request, success)),
    options.includeArchitect === false ? Promise.resolve(undefined) : reviewArchitect(request, success, options.llm),
  ])

  return { qa, security, architect, ok: qa.ok && security.ok }
}
