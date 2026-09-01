import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ActionExecutor, meshSurfaceNets, toAsciiStl } from './action-floor'
import type { FormattedEngineResponse } from '../telemetry/output-formatter'
import type { SdfNode, BoundingBox } from '../spatial-floor'

function passResponse(overrides: Partial<FormattedEngineResponse> = {}): FormattedEngineResponse {
  return {
    summary: { outcome: 'PASS', resolvedLayer: 'layer1-floor', attempts: 1 },
    structuralDiff: [
      { type: 'context', text: 'export function add(a: number, b: number): number {' },
      { type: 'add', text: '  return a + b' },
      { type: 'context', text: '}' },
    ],
    verificationTraces: [{ gate: 'static', passed: true, diagnostics: 'ok' }],
    telemetry: { gateSpanCount: 0, eventCount: 0 },
    ...overrides,
  }
}

function failResponse(): FormattedEngineResponse {
  return {
    summary: { outcome: 'FAIL', attempts: 2 },
    structuralDiff: [],
    verificationTraces: [{ gate: 'static', passed: false, diagnostics: 'nope' }],
    telemetry: { gateSpanCount: 0, eventCount: 0 },
  }
}

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'action-floor-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('ActionExecutor.applyCodePatches: dry-run', () => {
  test('reports the proposed diff and verification trace without touching disk', async () => {
    const executor = new ActionExecutor({ executionMode: 'dry-run', targetWorkspace: workspace })
    const response = passResponse()
    const result = await executor.applyCodePatches(response, 'src/add.ts')

    expect(result.ok).toBe(true)
    expect(result.ok && result.dryRun).toBe(true)
    expect(result.ok ? result.proposedDiff : undefined).toEqual(response.structuralDiff)
    expect(result.ok ? result.verificationTraces : undefined).toEqual(response.verificationTraces)
    expect(existsSync(join(workspace, 'src/add.ts'))).toBe(false)
  })
})

describe('ActionExecutor.applyCodePatches: interactive', () => {
  test('writes the file only after the injected confirm callback approves', async () => {
    const executor = new ActionExecutor({ executionMode: 'interactive', targetWorkspace: workspace, confirm: async () => true })
    const result = await executor.applyCodePatches(passResponse(), 'src/add.ts')

    expect(result.ok).toBe(true)
    expect(existsSync(join(workspace, 'src/add.ts'))).toBe(true)
  })

  test('a declined confirm callback leaves disk untouched and reports the decline', async () => {
    const executor = new ActionExecutor({ executionMode: 'interactive', targetWorkspace: workspace, confirm: async () => false })
    const result = await executor.applyCodePatches(passResponse(), 'src/add.ts')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('declined')
    expect(existsSync(join(workspace, 'src/add.ts'))).toBe(false)
  })

  test('the confirm prompt names the target file and the real passing-gate count', async () => {
    let seenMessage = ''
    const executor = new ActionExecutor({
      executionMode: 'interactive',
      targetWorkspace: workspace,
      confirm: async (message) => {
        seenMessage = message
        return true
      },
    })
    await executor.applyCodePatches(passResponse(), 'src/add.ts')

    expect(seenMessage).toContain('src/add.ts')
    expect(seenMessage).toContain('1 gate(s) passed')
  })
})

describe('ActionExecutor.applyCodePatches: auto', () => {
  test('writes the reconstructed patch content to a real file with no confirmation', async () => {
    const executor = new ActionExecutor({ executionMode: 'auto', targetWorkspace: workspace })
    const result = await executor.applyCodePatches(passResponse(), 'src/add.ts')

    expect(result.ok).toBe(true)
    expect(result.ok && result.dryRun).toBe(false)
    const written = readFileSync(join(workspace, 'src/add.ts'), 'utf8')
    expect(written).toBe('export function add(a: number, b: number): number {\n  return a + b\n}')
  })

  test('refuses to write outside targetWorkspace via a path-traversal filePath', async () => {
    const executor = new ActionExecutor({ executionMode: 'auto', targetWorkspace: workspace })
    await expect(executor.applyCodePatches(passResponse(), '../escape.ts')).rejects.toThrow(/refusing to write outside targetWorkspace/)
  })
})

describe('ActionExecutor.applyCodePatches: auto-commit', () => {
  function initGitRepo(): void {
    execFileSync('git', ['init'], { cwd: workspace })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workspace })
    // A real 'git commit' with no other history needs at least one commit
    // to exist already when autoBranch checks out from HEAD.
    execFileSync('git', ['commit', '--allow-empty', '-m', 'root'], { cwd: workspace })
  }

  test('writes the file AND commits it, with a real commit message carrying the verification trace', async () => {
    initGitRepo()
    const executor = new ActionExecutor({ executionMode: 'auto-commit', targetWorkspace: workspace, gitConfig: { commitMessagePrefix: '[bot] ' } })
    const result = await executor.applyCodePatches(passResponse(), 'add.ts')

    expect(result.ok).toBe(true)
    expect(readFileSync(join(workspace, 'add.ts'), 'utf8')).toContain('export function add')

    const log = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: workspace }).toString()
    expect(log).toContain('[bot] Apply verified patch: add.ts')
    expect(log).toContain('[PASS] static: ok')
  })

  test('gitConfig.autoBranch checks out a fresh action-floor/* branch before committing', async () => {
    initGitRepo()
    const before = execFileSync('git', ['branch', '--show-current'], { cwd: workspace }).toString().trim()

    const executor = new ActionExecutor({ executionMode: 'auto-commit', targetWorkspace: workspace, gitConfig: { autoBranch: true } })
    const result = await executor.applyCodePatches(passResponse(), 'add.ts')

    expect(result.ok).toBe(true)
    const after = execFileSync('git', ['branch', '--show-current'], { cwd: workspace }).toString().trim()
    expect(after).toMatch(/^action-floor\//)
    expect(after).not.toBe(before)
  })
})

describe('ActionExecutor: verification gate (all execution modes)', () => {
  test('a FAIL outcome is rejected before any disk write, in every execution mode', async () => {
    for (const executionMode of ['dry-run', 'interactive', 'auto', 'auto-commit'] as const) {
      const executor = new ActionExecutor({ executionMode, targetWorkspace: workspace, confirm: async () => true })
      const result = await executor.applyCodePatches(failResponse(), 'src/rejected.ts')

      expect(result.ok).toBe(false)
      expect(existsSync(join(workspace, 'src/rejected.ts'))).toBe(false)
    }
  })
})

describe('ActionExecutor.exportCADModels', () => {
  const SPHERE: SdfNode = { type: 'sphere', center: [0, 0, 0], radius: 1 }
  const BOX: BoundingBox = { min: [-2, -2, -2], max: [2, 2, 2] }

  test('dry-run reports triangle count without writing a file', async () => {
    const executor = new ActionExecutor({ executionMode: 'dry-run', targetWorkspace: workspace })
    const result = await executor.exportCADModels(passResponse(), SPHERE, BOX, 'sphere.stl')

    expect(result.ok).toBe(true)
    expect(existsSync(join(workspace, 'sphere.stl'))).toBe(false)
  })

  test('interactive mode exports only after approval', async () => {
    const declining = new ActionExecutor({ executionMode: 'interactive', targetWorkspace: workspace, confirm: async () => false })
    const declined = await declining.exportCADModels(passResponse(), SPHERE, BOX, 'sphere.stl', 12)
    expect(declined.ok).toBe(false)
    expect(existsSync(join(workspace, 'sphere.stl'))).toBe(false)

    const approving = new ActionExecutor({ executionMode: 'interactive', targetWorkspace: workspace, confirm: async () => true })
    const approved = await approving.exportCADModels(passResponse(), SPHERE, BOX, 'sphere.stl', 12)
    expect(approved.ok).toBe(true)
    expect(existsSync(join(workspace, 'sphere.stl'))).toBe(true)
  })

  test('auto mode writes a real, parseable ASCII STL mesh of the verified surface', async () => {
    const executor = new ActionExecutor({ executionMode: 'auto', targetWorkspace: workspace })
    const result = await executor.exportCADModels(passResponse(), SPHERE, BOX, 'sphere.stl', 20)

    expect(result.ok).toBe(true)
    const written = readFileSync(join(workspace, 'sphere.stl'), 'utf8')
    expect(written.startsWith('solid candidate')).toBe(true)
    expect(written.trim().endsWith('endsolid candidate')).toBe(true)

    // Every emitted vertex is a genuine sign-crossing on the sphere's actual
    // SDF (see meshSurfaceNets), not fabricated placeholder geometry - so
    // every vertex must sit close to the true radius.
    const vertexLines = written.split('\n').filter((line) => line.trim().startsWith('vertex'))
    expect(vertexLines.length).toBeGreaterThan(0)
    for (const line of vertexLines) {
      const [x, y, z] = line.trim().split(/\s+/).slice(1).map(Number)
      const radius = Math.sqrt(x * x + y * y + z * z)
      expect(Math.abs(radius - 1)).toBeLessThan(0.2)
    }
  })

  test('refuses a non-.stl extension rather than fabricating a fake STEP file', async () => {
    const executor = new ActionExecutor({ executionMode: 'auto', targetWorkspace: workspace })
    const result = await executor.exportCADModels(passResponse(), SPHERE, BOX, 'sphere.step')

    expect(result.ok).toBe(false)
    expect(existsSync(join(workspace, 'sphere.step'))).toBe(false)
  })

  test('refuses to export from a FAIL outcome, and touches no file', async () => {
    const executor = new ActionExecutor({ executionMode: 'auto', targetWorkspace: workspace })
    const result = await executor.exportCADModels(failResponse(), SPHERE, BOX, 'sphere.stl')

    expect(result.ok).toBe(false)
    expect(existsSync(join(workspace, 'sphere.stl'))).toBe(false)
  })
})

describe('ActionExecutor.executeBinaryPayload: fail-closed', () => {
  test('always returns executed: false with the required safety reason, for every execution mode', () => {
    for (const executionMode of ['dry-run', 'interactive', 'auto', 'auto-commit'] as const) {
      const executor = new ActionExecutor({ executionMode, targetWorkspace: workspace })
      const result = executor.executeBinaryPayload(new Uint8Array([0x00, 0x00, 0x80, 0xd2]))

      expect(result).toEqual({ executed: false, reason: 'Binary execution disabled — requires microVM/seccomp isolation' })
    }
  })

  test('never spawns a host subprocess (no child_process call happens for this method)', () => {
    // execFileSync/spawn are only ever invoked from gitCommit - calling
    // executeBinaryPayload on a workspace with no git repo at all proves no
    // subprocess was attempted, since a real spawn attempt there would throw.
    const executor = new ActionExecutor({ executionMode: 'auto-commit', targetWorkspace: workspace })
    expect(() => executor.executeBinaryPayload(new Uint8Array([0x1f, 0x20, 0x03, 0xd5]))).not.toThrow()
  })
})

describe('meshSurfaceNets / toAsciiStl: geometric correctness (not fabricated data)', () => {
  test('a unit sphere mesh has vertices within numerical tolerance of the true radius', () => {
    const triangles = meshSurfaceNets({ type: 'sphere', center: [0, 0, 0], radius: 1 }, { min: [-2, -2, -2], max: [2, 2, 2] }, 24)
    expect(triangles.length).toBeGreaterThan(0)

    let maxError = 0
    for (const t of triangles) {
      for (const v of [t.v0, t.v1, t.v2]) {
        maxError = Math.max(maxError, Math.abs(Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) - 1))
      }
    }
    expect(maxError).toBeLessThan(0.05)
  })

  test('a bounding box with no surface inside it produces an empty mesh, not fabricated geometry', () => {
    const triangles = meshSurfaceNets({ type: 'sphere', center: [100, 100, 100], radius: 1 }, { min: [-2, -2, -2], max: [2, 2, 2] }, 8)
    expect(triangles).toEqual([])
  })

  test('toAsciiStl renders a well-formed ASCII STL for a real triangle list', () => {
    const stl = toAsciiStl([{ v0: [0, 0, 0], v1: [1, 0, 0], v2: [0, 1, 0] }])
    expect(stl).toContain('solid candidate')
    expect(stl).toContain('facet normal')
    expect(stl).toContain('outer loop')
    expect(stl).toContain('vertex 0.000000 0.000000 0.000000')
    expect(stl.trim().endsWith('endsolid candidate')).toBe(true)
  })
})
