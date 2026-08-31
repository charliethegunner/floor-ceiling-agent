import { describe, expect, test } from 'vitest'
import { runVerificationFloor, type VerificationFloor } from './verification-floor'

// Deliberately NOT ARM64-flavored: proves the plugin contract is genuinely
// domain-agnostic, not just "the ARM64 floor's shape with extra steps".
describe('runVerificationFloor', () => {
  test('runs every gate in order and ok is the conjunction of all gate results', async () => {
    const calls: string[] = []
    const floor: VerificationFloor<number, 'positive' | 'even'> = {
      domain: 'test-numbers',
      gates: [
        {
          name: 'positive',
          check: (n) => {
            calls.push('positive')
            return { gate: 'positive', ok: n > 0, details: `n=${n}` }
          },
        },
        {
          name: 'even',
          check: (n) => {
            calls.push('even')
            return { gate: 'even', ok: n % 2 === 0, details: `n=${n}` }
          },
        },
      ],
    }

    const report = await runVerificationFloor(floor, 4)

    expect(report.domain).toBe('test-numbers')
    expect(report.ok).toBe(true)
    expect(report.gates.map((g) => g.gate)).toEqual(['positive', 'even'])
    expect(calls).toEqual(['positive', 'even'])
  })

  test('ok is false if any single gate fails, even when the others pass', async () => {
    const floor: VerificationFloor<number, 'positive' | 'even'> = {
      domain: 'test-numbers',
      gates: [
        { name: 'positive', check: (n) => ({ gate: 'positive', ok: n > 0, details: '' }) },
        { name: 'even', check: (n) => ({ gate: 'even', ok: n % 2 === 0, details: '' }) },
      ],
    }

    const report = await runVerificationFloor(floor, 3)

    expect(report.ok).toBe(false)
    expect(report.gates.find((g) => g.gate === 'positive')?.ok).toBe(true)
    expect(report.gates.find((g) => g.gate === 'even')?.ok).toBe(false)
  })

  test('supports gates that check asynchronously', async () => {
    const floor: VerificationFloor<string, 'nonEmpty'> = {
      domain: 'test-async',
      gates: [
        {
          name: 'nonEmpty',
          check: async (s) => {
            await new Promise((resolve) => setTimeout(resolve, 0))
            return { gate: 'nonEmpty', ok: s.length > 0, details: '' }
          },
        },
      ],
    }

    const report = await runVerificationFloor(floor, 'hello')
    expect(report.ok).toBe(true)
  })

  test('an empty gate list produces a vacuously-ok report', async () => {
    const floor: VerificationFloor<unknown, never> = { domain: 'empty', gates: [] }

    const report = await runVerificationFloor(floor, null)

    expect(report.ok).toBe(true)
    expect(report.gates).toEqual([])
  })
})
