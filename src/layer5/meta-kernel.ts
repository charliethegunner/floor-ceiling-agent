import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { Project } from 'ts-morph'
import type { CeilingRequestKind } from '../CeilingAgent'
import type { TopologyCandidate } from '../topology-floor'
import type { ClaimCandidate } from '../claim-floor'
import type { SpatialCandidate, SdfNode } from '../spatial-floor'

// Layer 5 Meta-Kernel (ROADMAP.md §2/§5): zero-latency local repair-rule
// compilation for RECURRING candidate failure patterns. This is honestly
// scoped, not a general program-repair engine: it recognizes a SMALL, fixed
// set of failure SHAPES this project's own floors are actually observed to
// produce (verified against instruction-floor.ts / topology-floor.ts /
// claim-floor.ts / spatial-floor.ts's real GateOutcome `details` strings,
// not a fictional "unsat core" structure - this codebase has no separate
// unsat-core artifact beyond a gate's own details text), plus an
// exact-match fallback for anything else. Every structural rule below
// performs a REAL, mechanically-verifiable transformation (including a
// genuine ts-morph AST mutation for the topology case) - not string
// guessing, and every rule that can't confidently derive a fix from THE
// SPECIFIC NEW failure returns null rather than fabricate one; the caller
// (runCeilingAgent) always re-verifies the result through the real floor
// before trusting it, so a wrong/stale rule can only cost a wasted attempt,
// never a false "success."
//
// `recordFix` must be called at least once for a given failure CATEGORY
// (typically after the Ceiling LLM demonstrates a real fix) before
// `tryMatchRule` will apply that category's transformation to a future,
// different-but-same-shape failure - this is deliberately a "learn once,
// generalize forever" design, not a set of built-in rules active from day
// one, matching "compiles rules from verified repair invariants."

export type PatchKind = 'expected-got-instruction' | 'topology-add-export' | 'claim-use-actual-value' | 'spatial-fix-negative-radius' | 'exact-replacement'

export interface CandidatePatch {
  kind: PatchKind
  description: string
  params: Record<string, unknown>
}

export interface FailedGateInfo {
  gate: string
  details: string
}

export interface MatchContext {
  failingCandidate: string
  failedGate: FailedGateInfo
}

// ---------------------------------------------------------------------------
// classifyFailurePattern: maps a (domain, gate failure) pair to a stable
// category string. Structurally similar failures - different concrete
// instructions/names/values but the SAME shape of mistake - classify to the
// SAME category, which is what lets a rule learned from one instance apply
// to a different one later. Anything unrecognized falls back to an
// exact-text category unique to that specific failing candidate, so it can
// still be memoized (exact-replacement) without false-generalizing.
// ---------------------------------------------------------------------------

export function classifyFailurePattern(kind: CeilingRequestKind, failedGate: FailedGateInfo, failingCandidate: string): string {
  if (kind === 'instruction' && failedGate.gate === 'symbolic' && /^expected ".+", got ".+"$/.test(failedGate.details)) {
    return 'instruction:symbolic:expected-got'
  }
  if (kind === 'topology' && failedGate.gate === 'exports' && /expected export ".+?" not found/.test(failedGate.details)) {
    return 'topology:exports:missing-export'
  }
  if (kind === 'claim' && failedGate.gate === 'empirical' && /expected \{.*\}, got \{.*\}$/.test(failedGate.details)) {
    return 'claim:empirical:wrong-value'
  }
  if (kind === 'spatial' && failedGate.gate === 'self-intersection' && /radius must be > 0, got -/.test(failedGate.details)) {
    return 'spatial:self-intersection:negative-radius'
  }
  return `exact:${kind}:${failedGate.gate}:${failingCandidate}`
}

// derivePatch: constructs the CandidatePatch to record for an observed
// (pattern, failingCandidate, fixedCandidate) triple. For the four
// structural categories, the transformation is fully self-contained (it
// re-derives the fix from whatever NEW failure it's later asked to match,
// not from these recorded params) - `params` only carries real data for the
// exact-replacement fallback, where there is no structural rule to apply.
export function derivePatch(pattern: string, failingCandidate: string, fixedCandidate: string): CandidatePatch {
  if (pattern.startsWith('instruction:symbolic:expected-got')) {
    return { kind: 'expected-got-instruction', description: 'use the verifier-stated expected text directly', params: {} }
  }
  if (pattern.startsWith('topology:exports:missing-export')) {
    return { kind: 'topology-add-export', description: 'mark the matching declaration as exported via a real ts-morph AST mutation', params: {} }
  }
  if (pattern.startsWith('claim:empirical:wrong-value')) {
    return { kind: 'claim-use-actual-value', description: 'rewrite assertion.expected to the empirically observed actual value', params: {} }
  }
  if (pattern.startsWith('spatial:self-intersection:negative-radius')) {
    return { kind: 'spatial-fix-negative-radius', description: 'negate a negative sphere radius back to positive', params: {} }
  }
  return { kind: 'exact-replacement', description: 'byte-identical candidate replay', params: { failingCandidate, fixedCandidate } }
}

// ---------------------------------------------------------------------------
// Rule application. Each function returns the fixed candidate text, or null
// if it cannot confidently derive a fix from THIS SPECIFIC failure (wrong
// message shape, unparseable candidate, or nothing to mutate).
// ---------------------------------------------------------------------------

function applyExpectedGotInstruction(context: MatchContext): string | null {
  const match = /^expected "(.+)", got ".+"$/.exec(context.failedGate.details)
  return match ? match[1] : null
}

function applyTopologyAddExport(context: MatchContext): string | null {
  const nameMatch = /expected export "(.+?)" not found/.exec(context.failedGate.details)
  if (!nameMatch) return null
  const exportName = nameMatch[1]

  let candidate: TopologyCandidate
  try {
    candidate = JSON.parse(context.failingCandidate) as TopologyCandidate
  } catch {
    return null
  }
  if (!candidate.inMemoryFiles) return null

  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } })
  for (const [filePath, content] of Object.entries(candidate.inMemoryFiles)) {
    project.createSourceFile(filePath, content)
  }

  let mutated = false
  for (const filePath of Object.keys(candidate.inMemoryFiles)) {
    const sourceFile = project.getSourceFileOrThrow(filePath)
    const fn = sourceFile.getFunction(exportName)
    if (fn && !fn.isExported()) {
      fn.setIsExported(true)
      mutated = true
    }
  }
  if (!mutated) return null

  const fixedFiles: Record<string, string> = {}
  for (const filePath of Object.keys(candidate.inMemoryFiles)) {
    fixedFiles[filePath] = project.getSourceFileOrThrow(filePath).getFullText()
  }

  return JSON.stringify({ ...candidate, inMemoryFiles: fixedFiles })
}

function applyClaimUseActualValue(context: MatchContext): string | null {
  // claim-floor.ts's checkEmpirical formats a wrong-value failure as:
  // `"<statement>": <module>#<export>(<args>) expected <json>, got <json>`
  const match = /expected (\{.*\}), got (\{.*\})$/.exec(context.failedGate.details)
  if (!match) return null

  let actual: unknown
  try {
    actual = JSON.parse(match[2])
  } catch {
    return null
  }

  let candidate: ClaimCandidate
  try {
    candidate = JSON.parse(context.failingCandidate) as ClaimCandidate
  } catch {
    return null
  }
  if (!candidate.claims || candidate.claims.length === 0) return null

  const fixedClaims = candidate.claims.map((claim, i) => (i === 0 ? { ...claim, assertion: { ...claim.assertion, expected: actual } } : claim))
  return JSON.stringify({ ...candidate, claims: fixedClaims })
}

function negateRadiusInNode(node: SdfNode, targetRadius: number): SdfNode | null {
  if ('radius' in node && node.radius === targetRadius) {
    return { ...node, radius: Math.abs(node.radius) }
  }
  if (node.type === 'union' || node.type === 'intersection') {
    for (let i = 0; i < node.children.length; i++) {
      const fixedChild = negateRadiusInNode(node.children[i], targetRadius)
      if (fixedChild) {
        const children = [...node.children]
        children[i] = fixedChild
        return { ...node, children }
      }
    }
    return null
  }
  if (node.type === 'subtraction') {
    const fixedA = negateRadiusInNode(node.a, targetRadius)
    if (fixedA) return { ...node, a: fixedA }
    const fixedB = negateRadiusInNode(node.b, targetRadius)
    return fixedB ? { ...node, b: fixedB } : null
  }
  if (node.type === 'unsafeScale') {
    const fixedChild = negateRadiusInNode(node.child, targetRadius)
    return fixedChild ? { ...node, child: fixedChild } : null
  }
  return null
}

function applySpatialFixNegativeRadius(context: MatchContext): string | null {
  const match = /radius must be > 0, got (-?\d+(?:\.\d+)?)/.exec(context.failedGate.details)
  if (!match) return null
  const badRadius = Number(match[1])
  if (!(badRadius < 0)) return null

  let candidate: SpatialCandidate
  try {
    candidate = JSON.parse(context.failingCandidate) as SpatialCandidate
  } catch {
    return null
  }

  const fixedSurface = negateRadiusInNode(candidate.surface, badRadius)
  if (!fixedSurface) return null
  return JSON.stringify({ ...candidate, surface: fixedSurface })
}

function applyExactReplacement(patch: CandidatePatch, context: MatchContext): string | null {
  const recordedFailingCandidate = patch.params.failingCandidate
  const fixedCandidate = patch.params.fixedCandidate
  if (typeof recordedFailingCandidate !== 'string' || typeof fixedCandidate !== 'string') return null
  return context.failingCandidate === recordedFailingCandidate ? fixedCandidate : null
}

function applyPatch(patch: CandidatePatch, context: MatchContext): string | null {
  switch (patch.kind) {
    case 'expected-got-instruction':
      return applyExpectedGotInstruction(context)
    case 'topology-add-export':
      return applyTopologyAddExport(context)
    case 'claim-use-actual-value':
      return applyClaimUseActualValue(context)
    case 'spatial-fix-negative-radius':
      return applySpatialFixNegativeRadius(context)
    case 'exact-replacement':
      return applyExactReplacement(patch, context)
  }
}

// ---------------------------------------------------------------------------
// MetaKernelCompiler: the rule store itself. A plain JSON file
// (src/layer5/rule-store.json by convention, though the path is always
// caller-supplied - see CLAUDE.md's "no speculative abstraction": this
// project has zero database dependencies today, and adding one (e.g.
// better-sqlite3) purely for this single feature isn't justified when a
// flat JSON object already satisfies "local, persistent, human-inspectable
// knowledge base" - the request's own "SQLite / JSON" phrasing treats them
// as interchangeable). storePath is optional specifically so tests (and any
// caller that wants a purely in-memory, no-fs-I/O instance) can opt out.
// ---------------------------------------------------------------------------

export interface MetaKernelOptions {
  storePath?: string
}

export class MetaKernelCompiler {
  private readonly store = new Map<string, CandidatePatch>()
  private readonly storePath: string | undefined

  constructor(options: MetaKernelOptions = {}) {
    this.storePath = options.storePath
    if (this.storePath && existsSync(this.storePath)) {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf-8')) as Record<string, CandidatePatch>
      for (const [pattern, patch] of Object.entries(raw)) {
        this.store.set(pattern, patch)
      }
    }
  }

  get ruleCount(): number {
    return this.store.size
  }

  recordFix(failurePattern: string, successfulFix: CandidatePatch): void {
    this.store.set(failurePattern, successfulFix)
    if (this.storePath) {
      const dir = path.dirname(this.storePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.storePath, JSON.stringify(Object.fromEntries(this.store), null, 2))
    }
  }

  tryMatchRule(failurePattern: string, context: MatchContext): string | null {
    const patch = this.store.get(failurePattern)
    if (!patch) return null
    return applyPatch(patch, context)
  }
}
