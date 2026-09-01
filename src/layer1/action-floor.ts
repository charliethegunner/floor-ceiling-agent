import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import type { FormattedEngineResponse, DiffLine, VerificationTraceEntry } from '../telemetry/output-formatter'
import { evaluateSdf, type SdfNode, type BoundingBox } from '../spatial-floor'
import { SandboxRunner, type SandboxExecutionOptions, type SandboxExecutionResult } from './sandbox-runner'
import { validateExecutableProgram } from './sandbox-instruction-set'

// Phase 11.7: Autonomous Action Floor - the only module in this project
// permitted to mutate the filesystem or spawn subprocesses on behalf of a
// verified candidate. Every entry point enforces the same invariant: the
// FormattedEngineResponse passed in must have summary.outcome === 'PASS'
// (real verification-floor ground truth computed by formatEngineResponse,
// never re-derived or assumed here - this codebase's actual field is named
// `outcome`, not `status`) before anything touches disk. Every write is
// also confined to targetWorkspace (path-traversal guarded via
// resolveWorkspacePath) - a relative path can't escape it via '..'.
//
// Four execution modes, checked in this order of increasing autonomy:
//   - 'dry-run': report the proposed diff/mesh + verification trace, touch nothing.
//   - 'interactive': the same report, then block on options.confirm before writing.
//   - 'auto': write immediately, no confirmation.
//   - 'auto-commit': write, then git add+commit (optionally on a fresh branch).
//
// executeBinaryPayload (Phase 12.1) delegates to SandboxRunner
// (sandbox-runner.ts) - a real isolated execution context for the CLOSED,
// provably-safe ARM64 register-transfer ALU subset instruction-floor.ts's
// Z3 gate already models, NOT a general machine-code executor. It is
// gated on the SAME verification outcome + execution-mode rules as
// applyCodePatches/exportCADModels above. See sandbox-runner.ts's header
// comment for why this isn't WASM/WASI or seccomp (neither applies here)
// and for what genuinely IS enforced (a real per-isolate memory ceiling,
// real preemptive termination on timeout, zero IO surface by
// construction).

export type ExecutionMode = 'dry-run' | 'interactive' | 'auto' | 'auto-commit'

export interface GitConfig {
  /** 'auto-commit' only - check out a fresh `action-floor/<id>` branch before committing, instead of committing to whatever branch targetWorkspace is already on. */
  autoBranch?: boolean
  /** 'auto-commit' only - prepended to the generated commit message (e.g. '[bot] '). */
  commitMessagePrefix?: string
}

export interface ActionExecutionOptions {
  executionMode: ExecutionMode
  targetWorkspace: string
  gitConfig?: GitConfig
  /** 'interactive' only - asked before any disk write; return true to
   *  proceed. Defaults to a real stdin/readline y/N prompt - tests MUST
   *  inject a fake here, or an 'interactive' test would block forever
   *  waiting on real stdin. */
  confirm?: (message: string) => boolean | Promise<boolean>
}

export type ActionResult =
  | { ok: true; action: string; dryRun: boolean; details: string; writtenPath?: string; proposedDiff?: DiffLine[]; verificationTraces?: VerificationTraceEntry[] }
  | { ok: false; action: string; reason: string }

/** Phase 12.1: an alias, not a redefinition - executeBinaryPayload's result
 *  IS a SandboxExecutionResult. Kept as a distinct exported name for
 *  import-site continuity with Phase 11.7's original stub type. */
export type BinaryExecutionResult = SandboxExecutionResult

// ---------------------------------------------------------------------------
// exportCADModels' mesher: naive surface nets over evaluateSdf (spatial-
// floor.ts's own trusted, hardcoded SDF evaluator - never candidate code).
// A real triangulation of the candidate's actual zero-level-set, not
// fabricated placeholder geometry: each cell vertex is the average of the
// SDF's true linearly-interpolated sign-crossings along that cell's 12
// edges, and each quad is only emitted where the field genuinely changes
// sign across a grid edge.
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number]

interface Triangle {
  v0: Vec3
  v1: Vec3
  v2: Vec3
}

function subVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function crossVec(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function lengthVec(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

function pointAt(box: BoundingBox, resolution: number, i: number, j: number, k: number): Vec3 {
  const t = (n: number) => n / resolution
  return [
    box.min[0] + t(i) * (box.max[0] - box.min[0]),
    box.min[1] + t(j) * (box.max[1] - box.min[1]),
    box.min[2] + t(k) * (box.max[2] - box.min[2]),
  ]
}

const CELL_CORNER_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
]

const CELL_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

export function meshSurfaceNets(surface: SdfNode, box: BoundingBox, resolution: number): Triangle[] {
  const n = resolution + 1
  const field: number[][][] = []
  for (let i = 0; i < n; i++) {
    field.push([])
    for (let j = 0; j < n; j++) {
      field[i].push([])
      for (let k = 0; k < n; k++) {
        field[i][j].push(evaluateSdf(surface, pointAt(box, resolution, i, j, k)))
      }
    }
  }

  const cellVertexCache = new Map<string, Vec3 | null>()

  function computeCellVertex(ci: number, cj: number, ck: number): Vec3 | null {
    const cornerValues = CELL_CORNER_OFFSETS.map(([dx, dy, dz]) => field[ci + dx][cj + dy][ck + dz])
    const cornerPoints = CELL_CORNER_OFFSETS.map(([dx, dy, dz]) => pointAt(box, resolution, ci + dx, cj + dy, ck + dz))

    const crossings: Vec3[] = []
    for (const [a, b] of CELL_EDGES) {
      const va = cornerValues[a]
      const vb = cornerValues[b]
      if ((va < 0) === (vb < 0)) continue // no sign change on this edge
      const t = va / (va - vb)
      const pa = cornerPoints[a]
      const pb = cornerPoints[b]
      crossings.push([pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1]), pa[2] + t * (pb[2] - pa[2])])
    }
    if (crossings.length === 0) return null

    const avg: Vec3 = [0, 0, 0]
    for (const c of crossings) {
      avg[0] += c[0]
      avg[1] += c[1]
      avg[2] += c[2]
    }
    return [avg[0] / crossings.length, avg[1] / crossings.length, avg[2] / crossings.length]
  }

  function vertexAt(i: number, j: number, k: number): Vec3 | null {
    if (i < 0 || j < 0 || k < 0 || i >= resolution || j >= resolution || k >= resolution) return null
    const key = `${i},${j},${k}`
    if (cellVertexCache.has(key)) return cellVertexCache.get(key) ?? null
    const computed = computeCellVertex(i, j, k)
    cellVertexCache.set(key, computed)
    return computed
  }

  const triangles: Triangle[] = []

  function emitQuad(v00: Vec3 | null, v10: Vec3 | null, v11: Vec3 | null, v01: Vec3 | null, flip: boolean): void {
    if (!v00 || !v10 || !v11 || !v01) return
    if (flip) {
      triangles.push({ v0: v00, v1: v11, v2: v10 })
      triangles.push({ v0: v00, v1: v01, v2: v11 })
    } else {
      triangles.push({ v0: v00, v1: v10, v2: v11 })
      triangles.push({ v0: v00, v1: v11, v2: v01 })
    }
  }

  // A quad is emitted per grid edge that crosses the surface, connecting
  // the (up to 4) neighboring cells' vertices - the standard naive surface
  // nets face rule.
  for (let i = 0; i < resolution; i++) {
    for (let j = 1; j < resolution; j++) {
      for (let k = 1; k < resolution; k++) {
        const va = field[i][j][k]
        const vb = field[i + 1][j][k]
        if ((va < 0) === (vb < 0)) continue
        emitQuad(vertexAt(i, j - 1, k - 1), vertexAt(i, j, k - 1), vertexAt(i, j, k), vertexAt(i, j - 1, k), va < 0)
      }
    }
  }
  for (let j = 0; j < resolution; j++) {
    for (let i = 1; i < resolution; i++) {
      for (let k = 1; k < resolution; k++) {
        const va = field[i][j][k]
        const vb = field[i][j + 1][k]
        if ((va < 0) === (vb < 0)) continue
        emitQuad(vertexAt(i - 1, j, k - 1), vertexAt(i, j, k - 1), vertexAt(i, j, k), vertexAt(i - 1, j, k), va >= 0)
      }
    }
  }
  for (let k = 0; k < resolution; k++) {
    for (let i = 1; i < resolution; i++) {
      for (let j = 1; j < resolution; j++) {
        const va = field[i][j][k]
        const vb = field[i][j][k + 1]
        if ((va < 0) === (vb < 0)) continue
        emitQuad(vertexAt(i - 1, j - 1, k), vertexAt(i, j - 1, k), vertexAt(i, j, k), vertexAt(i - 1, j, k), va < 0)
      }
    }
  }

  return triangles.filter((t) => lengthVec(crossVec(subVec(t.v1, t.v0), subVec(t.v2, t.v0))) > 1e-12)
}

export function toAsciiStl(triangles: Triangle[]): string {
  const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(6) : '0.000000')
  const lines: string[] = ['solid candidate']
  for (const t of triangles) {
    const normal = crossVec(subVec(t.v1, t.v0), subVec(t.v2, t.v0))
    const len = lengthVec(normal)
    const n: Vec3 = len === 0 ? [0, 0, 0] : [normal[0] / len, normal[1] / len, normal[2] / len]
    lines.push(`facet normal ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])}`)
    lines.push('  outer loop')
    lines.push(`    vertex ${fmt(t.v0[0])} ${fmt(t.v0[1])} ${fmt(t.v0[2])}`)
    lines.push(`    vertex ${fmt(t.v1[0])} ${fmt(t.v1[1])} ${fmt(t.v1[2])}`)
    lines.push(`    vertex ${fmt(t.v2[0])} ${fmt(t.v2[1])} ${fmt(t.v2[2])}`)
    lines.push('  endloop')
    lines.push('endfacet')
  }
  lines.push('endsolid candidate')
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// ActionExecutor
// ---------------------------------------------------------------------------

const DEFAULT_MESH_RESOLUTION = 24

async function defaultConfirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${message} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

export class ActionExecutor {
  private readonly sandbox = new SandboxRunner()

  constructor(private readonly options: ActionExecutionOptions) {}

  private resolveWorkspacePath(relativePath: string): string {
    const root = resolve(this.options.targetWorkspace)
    const target = resolve(root, relativePath)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`refusing to write outside targetWorkspace "${root}": resolved path "${target}"`)
    }
    return target
  }

  private assertVerified(response: FormattedEngineResponse, action: string): ActionResult | null {
    if (response.summary.outcome !== 'PASS') {
      return { ok: false, action, reason: `refusing to ${action}: verification outcome was "${response.summary.outcome}", not PASS` }
    }
    return null
  }

  // Real 'git add' + 'git commit' (argv arrays, never a shell string - no
  // injection surface from relativeFilePath/message). The commit message
  // carries the response's REAL verificationTraces, not a placeholder -
  // this is the "verification trace metadata" the commit is meant to audit.
  private gitCommit(relativeFilePath: string, headline: string, response: FormattedEngineResponse): void {
    const cwd = this.options.targetWorkspace
    if (this.options.gitConfig?.autoBranch) {
      execFileSync('git', ['checkout', '-b', `action-floor/${randomUUID().slice(0, 8)}`], { cwd })
    }
    const prefix = this.options.gitConfig?.commitMessagePrefix ?? ''
    const traceLines = response.verificationTraces.map((t) => `- [${t.passed ? 'PASS' : 'FAIL'}] ${t.gate}: ${t.diagnostics}`)
    const message = [`${prefix}${headline}`, '', ...traceLines].join('\n')
    execFileSync('git', ['add', relativeFilePath], { cwd })
    execFileSync('git', ['commit', '-m', message], { cwd })
  }

  private async confirmOrReject(action: string, relativeFilePath: string, message: string): Promise<ActionResult | null> {
    const approved = await (this.options.confirm ?? defaultConfirm)(message)
    if (approved) return null
    return { ok: false, action, reason: `user declined the interactive prompt for ${relativeFilePath}` }
  }

  async applyCodePatches(response: FormattedEngineResponse, relativeFilePath: string): Promise<ActionResult> {
    const rejected = this.assertVerified(response, 'applyCodePatches')
    if (rejected) return rejected

    const content = response.structuralDiff
      .filter((line) => line.type !== 'remove')
      .map((line) => line.text)
      .join('\n')
    const target = this.resolveWorkspacePath(relativeFilePath)

    if (this.options.executionMode === 'dry-run') {
      return {
        ok: true,
        action: 'applyCodePatches',
        dryRun: true,
        details: `would write ${content.length} byte(s) to ${target}`,
        writtenPath: target,
        proposedDiff: response.structuralDiff,
        verificationTraces: response.verificationTraces,
      }
    }

    if (this.options.executionMode === 'interactive') {
      const declined = await this.confirmOrReject('applyCodePatches', relativeFilePath, `Apply verified patch to ${relativeFilePath}? (${response.verificationTraces.length} gate(s) passed)`)
      if (declined) return declined
    }

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')

    if (this.options.executionMode === 'auto-commit') {
      this.gitCommit(relativeFilePath, `Apply verified patch: ${relativeFilePath}`, response)
    }

    return { ok: true, action: 'applyCodePatches', dryRun: false, details: `wrote ${content.length} byte(s) to ${target}`, writtenPath: target }
  }

  async exportCADModels(response: FormattedEngineResponse, surface: SdfNode, boundingBox: BoundingBox, relativeFilePath: string, gridResolution = DEFAULT_MESH_RESOLUTION): Promise<ActionResult> {
    const rejected = this.assertVerified(response, 'exportCADModels')
    if (rejected) return rejected

    if (!relativeFilePath.endsWith('.stl')) {
      // Only ASCII STL is implemented - a genuinely valid STEP (ISO 10303-21)
      // file needs a real B-rep/NURBS kernel this project doesn't have, and
      // fabricating a ".step" file that isn't actually one would be exactly
      // the kind of theater this codebase has consistently refused elsewhere.
      return { ok: false, action: 'exportCADModels', reason: `only .stl export is implemented (no B-rep/STEP kernel exists in this project) - got "${relativeFilePath}"` }
    }

    const triangles = meshSurfaceNets(surface, boundingBox, gridResolution)
    const target = this.resolveWorkspacePath(relativeFilePath)

    if (this.options.executionMode === 'dry-run') {
      return {
        ok: true,
        action: 'exportCADModels',
        dryRun: true,
        details: `would write ${triangles.length} triangle(s) to ${target}`,
        writtenPath: target,
        verificationTraces: response.verificationTraces,
      }
    }

    if (this.options.executionMode === 'interactive') {
      const declined = await this.confirmOrReject('exportCADModels', relativeFilePath, `Export ${triangles.length} verified triangle(s) to ${relativeFilePath}?`)
      if (declined) return declined
    }

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, toAsciiStl(triangles), 'utf8')

    if (this.options.executionMode === 'auto-commit') {
      this.gitCommit(relativeFilePath, `Export verified CAD model: ${relativeFilePath}`, response)
    }

    return { ok: true, action: 'exportCADModels', dryRun: false, details: `wrote ${triangles.length} triangle(s) to ${target}`, writtenPath: target }
  }

  async executeBinaryPayload(
    response: FormattedEngineResponse,
    arm64Assembly: string,
    initialRegisters: Record<string, bigint> = {},
    sandboxOptions?: SandboxExecutionOptions
  ): Promise<SandboxExecutionResult> {
    if (response.summary.outcome !== 'PASS') {
      return { executed: false, reason: `refusing to execute: verification outcome was "${response.summary.outcome}", not PASS` }
    }

    const lines = arm64Assembly.split('\n')
    const instructionCount = lines.filter((line) => line.trim().length > 0).length

    // Admission control here too (SandboxRunner re-validates internally as
    // its own independent boundary) - lets dry-run/interactive report an
    // HONEST outcome without ever spawning a sandbox worker for a payload
    // that was always going to be refused.
    const rejection = validateExecutableProgram(lines)
    if (rejection) {
      return { executed: false, reason: `${rejection.reason} (in "${rejection.line}")` }
    }

    if (this.options.executionMode === 'dry-run') {
      return { executed: false, reason: `dry-run: would execute ${instructionCount} instruction(s) in the isolated sandbox` }
    }

    if (this.options.executionMode === 'interactive') {
      const approved = await (this.options.confirm ?? defaultConfirm)(`Execute ${instructionCount} verified instruction(s) in the isolated sandbox?`)
      if (!approved) return { executed: false, reason: 'user declined the interactive prompt for executeBinaryPayload' }
    }

    return this.sandbox.execute(arm64Assembly, initialRegisters, sandboxOptions)
  }
}
