import { describe, expect, test } from 'vitest'
import { TOPOLOGY_FLOOR, type TopologyCandidate } from './topology-floor'
import { runVerificationFloor } from './verification-floor'

function runGate(name: 'exports' | 'types' | 'reachability', candidate: TopologyCandidate) {
  const gate = TOPOLOGY_FLOOR.gates.find((g) => g.name === name)
  if (!gate) throw new Error(`no such gate: ${name}`)
  return gate.check(candidate)
}

describe('TOPOLOGY_FLOOR: exports gate', () => {
  test('real codebase: lib/index.ts exports translateX86ToArm64', async () => {
    const result = await runGate('exports', {
      projectRoot: 'lib',
      expectedExports: [{ filePath: 'lib/index.ts', exportedNames: ['translateX86ToArm64'] }],
      reachability: [],
    })

    expect(result.ok).toBe(true)
    expect(result.details).toContain('1 expected export(s) verified')
  })

  test('a nonexistent expected export is caught', async () => {
    const result = await runGate('exports', {
      projectRoot: 'lib',
      expectedExports: [{ filePath: 'lib/index.ts', exportedNames: ['thisFunctionDoesNotExist'] }],
      reachability: [],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('expected export "thisFunctionDoesNotExist" not found')
  })

  test('a nonexistent file is caught', async () => {
    const result = await runGate('exports', {
      projectRoot: 'lib',
      expectedExports: [{ filePath: 'lib/does-not-exist.ts', exportedNames: ['anything'] }],
      reachability: [],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('file not found in project')
  })
})

describe('TOPOLOGY_FLOOR: types gate', () => {
  test('real codebase: lib/ has zero explicit "any" usage', async () => {
    const result = await runGate('types', { projectRoot: 'lib', expectedExports: [], reachability: [] })

    expect(result.ok).toBe(true)
    expect(result.details).toContain('0 "any" usages')
  })

  test('real codebase: translateX86ToArm64 has an explicit return type', async () => {
    const result = await runGate('types', {
      projectRoot: 'lib',
      expectedExports: [{ filePath: 'lib/index.ts', exportedNames: ['translateX86ToArm64'] }],
      reachability: [],
    })

    expect(result.ok).toBe(true)
  })

  test('synthetic: explicit "any" usage is caught', async () => {
    const result = await runGate('types', {
      inMemoryFiles: { 'candidate.ts': 'export function withAny(value: any): unknown { return value }' },
      expectedExports: [],
      reachability: [],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('explicit "any" usage found')
  })

  test('synthetic: a missing return type annotation on an expected exported function is caught', async () => {
    const result = await runGate('types', {
      inMemoryFiles: { 'candidate.ts': 'export function noReturnType(x: number) { return x + 1 }' },
      expectedExports: [{ filePath: 'candidate.ts', exportedNames: ['noReturnType'] }],
      reachability: [],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('missing explicit return type annotation: candidate.ts#noReturnType')
  })

  test('synthetic: non-function exports (e.g. an interface) are not flagged for a missing "return type"', async () => {
    const result = await runGate('types', {
      inMemoryFiles: { 'candidate.ts': 'export interface Point { x: number; y: number }' },
      expectedExports: [{ filePath: 'candidate.ts', exportedNames: ['Point'] }],
      reachability: [],
    })

    expect(result.ok).toBe(true)
  })
})

describe('TOPOLOGY_FLOOR: reachability gate', () => {
  test('real codebase: a multi-hop, cross-file call chain is found (index.ts -> cfg.ts -> translator.ts)', async () => {
    const result = await runGate('reachability', {
      projectRoot: 'lib',
      expectedExports: [],
      reachability: [
        {
          from: { filePath: 'lib/index.ts', functionName: 'translateX86ToArm64' },
          to: { filePath: 'lib/translator.ts', functionName: 'parseInstruction' },
          expectReachable: true,
        },
      ],
    })

    expect(result.ok).toBe(true)
  })

  test('real codebase: lib/ never reaches into src/ (an architectural layering boundary)', async () => {
    const result = await runGate('reachability', {
      filesGlob: ['lib/**/*.ts', 'src/CeilingAgent.ts'],
      expectedExports: [],
      reachability: [
        {
          from: { filePath: 'lib/index.ts', functionName: 'translateX86ToArm64' },
          to: { filePath: 'src/CeilingAgent.ts', functionName: 'runCeilingAgent' },
          expectReachable: false,
        },
      ],
    })

    expect(result.ok).toBe(true)
  })

  test('synthetic: a direct single-hop call is found', async () => {
    const result = await runGate('reachability', {
      inMemoryFiles: {
        'a.ts': "import { b } from './b'\nexport function a(): number { return b() }",
        'b.ts': 'export function b(): number { return 42 }',
      },
      expectedExports: [],
      reachability: [{ from: { filePath: 'a.ts', functionName: 'a' }, to: { filePath: 'b.ts', functionName: 'b' }, expectReachable: true }],
    })

    expect(result.ok).toBe(true)
  })

  test('synthetic: a call that genuinely does not exist is correctly reported unreachable', async () => {
    const result = await runGate('reachability', {
      inMemoryFiles: {
        'a.ts': 'export function a(): number { return 1 }',
        'b.ts': 'export function b(): number { return 2 }',
      },
      expectedExports: [],
      reachability: [{ from: { filePath: 'a.ts', functionName: 'a' }, to: { filePath: 'b.ts', functionName: 'b' }, expectReachable: true }],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('expected reachable=true, got false')
  })

  test('synthetic: an expected-unreachable pair that is actually reachable is caught', async () => {
    const result = await runGate('reachability', {
      inMemoryFiles: {
        'a.ts': "import { b } from './b'\nexport function a(): number { return b() }",
        'b.ts': 'export function b(): number { return 42 }',
      },
      expectedExports: [],
      reachability: [{ from: { filePath: 'a.ts', functionName: 'a' }, to: { filePath: 'b.ts', functionName: 'b' }, expectReachable: false }],
    })

    expect(result.ok).toBe(false)
    expect(result.details).toContain('expected reachable=false, got true')
  })

  test('synthetic: reachability follows a transitive, multi-hop chain', async () => {
    const result = await runGate('reachability', {
      inMemoryFiles: {
        'a.ts': "import { b } from './b'\nexport function a(): number { return b() }",
        'b.ts': "import { c } from './c'\nexport function b(): number { return c() }",
        'c.ts': 'export function c(): number { return 7 }',
      },
      expectedExports: [],
      reachability: [{ from: { filePath: 'a.ts', functionName: 'a' }, to: { filePath: 'c.ts', functionName: 'c' }, expectReachable: true }],
    })

    expect(result.ok).toBe(true)
  })
})

describe('TOPOLOGY_FLOOR: full floor via runVerificationFloor', () => {
  test('all three gates pass together for the real lib/ directory', async () => {
    const candidate: TopologyCandidate = {
      projectRoot: 'lib',
      expectedExports: [{ filePath: 'lib/index.ts', exportedNames: ['translateX86ToArm64'] }],
      reachability: [
        {
          from: { filePath: 'lib/index.ts', functionName: 'translateX86ToArm64' },
          to: { filePath: 'lib/translator.ts', functionName: 'parseInstruction' },
          expectReachable: true,
        },
      ],
    }

    const report = await runVerificationFloor(TOPOLOGY_FLOOR, candidate)

    expect(report.domain).toBe('codebase-topology')
    expect(report.gates.map((g) => g.gate)).toEqual(['exports', 'types', 'reachability'])
    expect(report.ok).toBe(true)
  })
})
