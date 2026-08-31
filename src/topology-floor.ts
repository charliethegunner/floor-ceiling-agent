import { Project, Node, SyntaxKind, type SourceFile } from 'ts-morph'
import type { VerificationFloor, GateOutcome } from './verification-floor'

// A concrete VerificationFloor (src/verification-floor.ts) for codebase
// structure itself, rather than a translated ARM64 candidate: does a module
// export what it's expected to, do exported functions carry explicit types,
// and can function A actually reach function B through some chain of calls
// - possibly crossing file boundaries via imports. All three are static,
// AST-only checks (ts-morph, already a project dependency; tree-sitter
// would add a second, redundant AST toolchain for no extra capability
// here), never executing anything, matching this project's established
// "static analysis only" posture for untrusted or arbitrary code.

export interface ExportExpectation {
  filePath: string
  exportedNames: string[]
}

export interface FunctionRef {
  filePath: string
  functionName: string
}

export interface ReachabilityExpectation {
  from: FunctionRef
  to: FunctionRef
  /** true: `to` must be reachable from `from`. false: it must NOT be - e.g. asserting a layering boundary (lib/ must never reach into src/). */
  expectReachable: boolean
}

export interface TopologyCandidate {
  /** Directory to load, e.g. 'lib' or 'src'. Ignored if inMemoryFiles is set. */
  projectRoot?: string
  /** Defaults to `${projectRoot}/**\/*.ts`. Accepts multiple globs, e.g. to span two directories for a cross-boundary reachability check. */
  filesGlob?: string | string[]
  tsConfigFilePath?: string
  /**
   * Synthetic candidate: filePath -> source text, loaded via ts-morph's
   * in-memory filesystem, no disk I/O. For verifying arbitrary/proposed
   * code structure (e.g. an LLM-proposed module layout) without writing
   * it to real files first - the same reasoning CeilingAgent.ts's
   * verifyPatchCandidate already applies to a single TS snippet, extended
   * here to a small multi-file project. Takes precedence over projectRoot.
   */
  inMemoryFiles?: Record<string, string>
  expectedExports: ExportExpectation[]
  reachability: ReachabilityExpectation[]
}

export type TopologyGateName = 'exports' | 'types' | 'reachability'

// ---------------------------------------------------------------------------
// Project loading, memoized per candidate object so the three gates below
// (called in sequence by runVerificationFloor with the same candidate
// reference) parse the codebase once, not three times.
// ---------------------------------------------------------------------------

const projectCache = new WeakMap<TopologyCandidate, Project>()

function loadProject(candidate: TopologyCandidate): Project {
  const cached = projectCache.get(candidate)
  if (cached) return cached

  let project: Project
  if (candidate.inMemoryFiles) {
    project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } })
    for (const [filePath, content] of Object.entries(candidate.inMemoryFiles)) {
      project.createSourceFile(filePath, content)
    }
  } else {
    project = new Project({ tsConfigFilePath: candidate.tsConfigFilePath ?? 'tsconfig.json' })
    project.addSourceFilesAtPaths(candidate.filesGlob ?? `${candidate.projectRoot}/**/*.ts`)
  }

  projectCache.set(candidate, project)
  return project
}

// ---------------------------------------------------------------------------
// Gate: exports
// ---------------------------------------------------------------------------

function checkExports(project: Project, candidate: TopologyCandidate): GateOutcome<'exports'> {
  const missing: string[] = []
  let checkedCount = 0

  for (const expectation of candidate.expectedExports) {
    const file = project.getSourceFile(expectation.filePath)
    if (!file) {
      missing.push(`${expectation.filePath}: file not found in project`)
      continue
    }
    const exported = file.getExportedDeclarations()
    for (const name of expectation.exportedNames) {
      checkedCount++
      if (!exported.has(name)) {
        missing.push(`${expectation.filePath}: expected export "${name}" not found`)
      }
    }
  }

  return missing.length === 0
    ? { gate: 'exports', ok: true, details: `${checkedCount} expected export(s) verified` }
    : { gate: 'exports', ok: false, details: missing.join('; ') }
}

// ---------------------------------------------------------------------------
// Gate: types - no explicit `any` anywhere in the loaded project, and every
// expected exported FUNCTION carries an explicit return type. Non-function
// exports (interfaces, consts, types) are skipped, not flagged - there's no
// "return type" for them to be missing.
// ---------------------------------------------------------------------------

function checkTypes(project: Project, candidate: TopologyCandidate): GateOutcome<'types'> {
  const anyUsages = project.getSourceFiles().flatMap((f) => f.getDescendantsOfKind(SyntaxKind.AnyKeyword))
  if (anyUsages.length > 0) {
    const locations = anyUsages.map((n) => `${n.getSourceFile().getBaseName()}:${n.getStartLineNumber()}`).join(', ')
    return { gate: 'types', ok: false, details: `explicit "any" usage found at ${locations}` }
  }

  const missingReturnType: string[] = []
  for (const expectation of candidate.expectedExports) {
    const file = project.getSourceFile(expectation.filePath)
    if (!file) continue
    for (const name of expectation.exportedNames) {
      const fn = file.getFunction(name)
      if (fn && !fn.getReturnTypeNode()) {
        missingReturnType.push(`${expectation.filePath}#${name}`)
      }
    }
  }
  if (missingReturnType.length > 0) {
    return { gate: 'types', ok: false, details: `missing explicit return type annotation: ${missingReturnType.join(', ')}` }
  }

  return { gate: 'types', ok: true, details: '0 "any" usages, all expected exported functions have explicit return types' }
}

// ---------------------------------------------------------------------------
// Gate: reachability - builds a call graph on demand (BFS from `from`,
// stopping early if `to` is found) rather than the whole project's graph
// upfront, since most candidates only ask a handful of questions. Scoped to
// function declarations and arrow/function-expression consts - the two
// patterns this codebase actually uses everywhere; class methods are out of
// scope for this first version (documented, not silently mishandled: a
// method call simply won't resolve to a callable node and the traversal
// stops there, which can only make reachability under-report, never
// over-report - the safe direction for a boundary-enforcing check).
// ---------------------------------------------------------------------------

interface Callable {
  key: string
  body: Node
}

function functionKey(filePath: string, name: string): string {
  return `${filePath}#${name}`
}

function findCallableInFile(file: SourceFile, name: string): Callable | null {
  const fn = file.getFunction(name)
  if (fn) return { key: functionKey(file.getFilePath(), name), body: fn }

  const varDecl = file.getVariableDeclaration(name)
  const initializer = varDecl?.getInitializer()
  if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
    return { key: functionKey(file.getFilePath(), name), body: initializer }
  }
  return null
}

function calleesOf(body: Node): Callable[] {
  const results: Callable[] = []
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression()
    if (!Node.isIdentifier(expr)) continue // bare `foo()` calls only; see the class-methods scoping note above

    // getDefinitionNodes() (not symbol.getDeclarations()) is required here:
    // for an imported call, getDeclarations() resolves to the ImportSpecifier
    // node itself, not the function it imports - getDefinitionNodes() is what
    // actually follows the import through to the real declaration. Found by
    // direct empirical debugging: every cross-file synthetic test failed
    // silently (0 callees found) until this was corrected.
    for (const decl of expr.getDefinitionNodes()) {
      let fnNode: Node | undefined
      let name: string | undefined

      if (Node.isFunctionDeclaration(decl)) {
        fnNode = decl
        name = decl.getName()
      } else if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer()
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          fnNode = init
          name = decl.getName()
        }
      }

      if (fnNode && name) {
        results.push({ key: functionKey(decl.getSourceFile().getFilePath(), name), body: fnNode })
      }
    }
  }
  return results
}

function isReachable(project: Project, from: FunctionRef, to: FunctionRef): boolean {
  const fromFile = project.getSourceFile(from.filePath)
  const toFile = project.getSourceFile(to.filePath)
  if (!fromFile || !toFile) return false

  const start = findCallableInFile(fromFile, from.functionName)
  if (!start) return false

  const targetKey = functionKey(toFile.getFilePath(), to.functionName)
  if (start.key === targetKey) return true

  const visited = new Set<string>([start.key])
  const queue: Callable[] = [start]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    for (const callee of calleesOf(current.body)) {
      if (callee.key === targetKey) return true
      if (!visited.has(callee.key)) {
        visited.add(callee.key)
        queue.push(callee)
      }
    }
  }
  return false
}

function checkReachability(project: Project, candidate: TopologyCandidate): GateOutcome<'reachability'> {
  const failures: string[] = []
  for (const expectation of candidate.reachability) {
    const reachable = isReachable(project, expectation.from, expectation.to)
    if (reachable !== expectation.expectReachable) {
      failures.push(
        `${expectation.from.filePath}#${expectation.from.functionName} -> ${expectation.to.filePath}#${expectation.to.functionName}: ` +
          `expected reachable=${expectation.expectReachable}, got ${reachable}`
      )
    }
  }
  return failures.length === 0
    ? { gate: 'reachability', ok: true, details: `${candidate.reachability.length} reachability expectation(s) verified` }
    : { gate: 'reachability', ok: false, details: failures.join('; ') }
}

// ---------------------------------------------------------------------------

export const TOPOLOGY_FLOOR: VerificationFloor<TopologyCandidate, TopologyGateName> = {
  domain: 'codebase-topology',
  gates: [
    { name: 'exports', check: (candidate) => checkExports(loadProject(candidate), candidate) },
    { name: 'types', check: (candidate) => checkTypes(loadProject(candidate), candidate) },
    { name: 'reachability', check: (candidate) => checkReachability(loadProject(candidate), candidate) },
  ],
}
