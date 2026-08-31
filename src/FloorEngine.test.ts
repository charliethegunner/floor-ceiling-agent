import { describe, expect, test } from 'vitest'
import { runStaticGate, runFuzzGate, runSymbolicGate, runFloorEngine } from './FloorEngine'

describe('Gate 1 (Static): ts-morph', () => {
  test('lib/ compiles with zero diagnostics and a verified entrypoint signature', () => {
    const result = runStaticGate()

    expect(result.gate).toBe('static')
    expect(result.ok).toBe(true)
    expect(result.details).toContain('0 diagnostics')
    expect(result.details).toContain('0 "any" usages')
  })
})

describe('Gate 2 (Fuzzing): fast-check, 1000 runs', () => {
  test('the real pipeline output satisfies determinism, register-token, and label-integrity invariants', () => {
    const result = runFuzzGate(1000)

    expect(result.gate).toBe('fuzz')
    expect(result.ok).toBe(true)
    expect(result.details).toContain('1000 property runs passed')
  }, 30000)
})

describe('Gate 3 (Symbolic): z3-solver', () => {
  test('MOV/ADD/CMP translations are proven register-file-equivalent to their x86 source', async () => {
    const result = await runSymbolicGate()

    expect(result.gate).toBe('symbolic')
    expect(result.ok).toBe(true)
    expect(result.details).toContain('Z3 proved register-file equivalence')
  }, 30000)
})

describe('runFloorEngine', () => {
  test('all three gates pass together and the aggregate report is ok', async () => {
    const report = await runFloorEngine()

    expect(report.gates.map((g) => g.gate)).toEqual(['static', 'fuzz', 'symbolic'])
    expect(report.gates.every((g) => g.ok)).toBe(true)
    expect(report.ok).toBe(true)
  }, 30000)
})
