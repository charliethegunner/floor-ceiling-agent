import { beforeEach, describe, expect, test } from 'vitest'
import {
  defaultStrategies,
  executeSelfHealingLoop,
  healerState,
  probeEnvironment,
} from './healer'

describe('probeEnvironment', () => {
  test('reports healthy when all metrics are within bounds', () => {
    const result = probeEnvironment({
      heapUsedRatio: 0.4,
      memoryAllocatable: true,
      testRunnerAvailable: true,
    })

    expect(result).toEqual({
      status: 'healthy',
      issues: [],
      autoFixesApplied: [],
    })
  })

  test('reports degraded with a single issue', () => {
    const result = probeEnvironment({
      heapUsedRatio: 0.95,
      memoryAllocatable: true,
      testRunnerAvailable: true,
    })

    expect(result.status).toBe('degraded')
    expect(result.issues).toEqual(['high memory usage detected'])
  })

  test('reports failed with multiple issues', () => {
    const result = probeEnvironment({
      heapUsedRatio: 0.95,
      memoryAllocatable: false,
      testRunnerAvailable: false,
    })

    expect(result.status).toBe('failed')
    expect(result.issues).toEqual([
      'high memory usage detected',
      'memory allocation failure',
      'test runner unavailable',
    ])
    expect(result.autoFixesApplied).toEqual([])
  })

  test('falls back to real process metrics when none are provided', () => {
    const result = probeEnvironment()

    expect(['healthy', 'degraded', 'failed']).toContain(result.status)
    expect(Array.isArray(result.issues)).toBe(true)
  })
})

describe('executeSelfHealingLoop', () => {
  beforeEach(() => {
    healerState.cache.clear()
    healerState.lotSize = 0.02
    delete process.env.LOT_SIZE
  })

  test('returns healthy immediately when the operation succeeds on the first try', () => {
    const result = executeSelfHealingLoop(() => {})

    expect(result).toEqual({
      status: 'healthy',
      issues: [],
      autoFixesApplied: [],
    })
  })

  test('captures the stack trace of a thrown error', () => {
    const result = executeSelfHealingLoop(() => {
      throw new Error('boom')
    }, { maxAttempts: 1 })

    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toContain('boom')
  })

  test('captures non-Error throws as strings', () => {
    const result = executeSelfHealingLoop(() => {
      throw 'plain string failure'
    }, { maxAttempts: 1 })

    expect(result.issues).toEqual(['plain string failure'])
  })

  test('applies a resolution strategy and succeeds on retry, reporting degraded', () => {
    healerState.lotSize = 5

    const result = executeSelfHealingLoop(() => {
      if (healerState.lotSize !== 0.02) {
        throw new Error('lot size is corrupted')
      }
    }, {
      strategies: [
        { name: 'reset lot size to default (0.02)', apply: () => { healerState.lotSize = 0.02 } },
      ],
      maxAttempts: 3,
    })

    expect(result.status).toBe('degraded')
    expect(result.issues).toHaveLength(1)
    expect(result.autoFixesApplied).toEqual(['reset lot size to default (0.02)'])
  })

  test('applies registered strategies in order across successive failures', () => {
    const applied: string[] = []
    const strategies = [
      { name: 'first', apply: () => applied.push('first') },
      { name: 'second', apply: () => applied.push('second') },
    ]
    let calls = 0

    const result = executeSelfHealingLoop(() => {
      calls += 1
      if (calls < 3) throw new Error(`attempt ${calls} failed`)
    }, { strategies, maxAttempts: 3 })

    expect(calls).toBe(3)
    expect(applied).toEqual(['first', 'second'])
    expect(result.status).toBe('degraded')
    expect(result.autoFixesApplied).toEqual(['first', 'second'])
  })

  test('returns failed after exhausting all attempts with an unfixable operation', () => {
    const result = executeSelfHealingLoop(() => {
      throw new Error('unrecoverable')
    })

    expect(result.status).toBe('failed')
    expect(result.issues).toHaveLength(3)
    expect(result.autoFixesApplied).toEqual(
      defaultStrategies.map((strategy) => strategy.name)
    )
  })

  test('respects a custom maxAttempts lower than the strategy count', () => {
    const result = executeSelfHealingLoop(() => {
      throw new Error('always fails')
    }, { maxAttempts: 1 })

    expect(result.status).toBe('failed')
    expect(result.issues).toHaveLength(1)
    expect(result.autoFixesApplied).toHaveLength(1)
  })
})

describe('defaultStrategies', () => {
  beforeEach(() => {
    healerState.cache.clear()
    healerState.lotSize = 0.02
    delete process.env.LOT_SIZE
  })

  test('flush state cache strategy clears healerState.cache', () => {
    healerState.cache.set('stale', 'value')
    const strategy = defaultStrategies.find((s) => s.name === 'flush state cache')

    strategy?.apply()

    expect(healerState.cache.size).toBe(0)
  })

  test('reset lot size strategy resets healerState.lotSize to 0.02', () => {
    healerState.lotSize = 123
    const strategy = defaultStrategies.find((s) => s.name === 'reset lot size to default (0.02)')

    strategy?.apply()

    expect(healerState.lotSize).toBe(0.02)
  })

  test('correct environment variables strategy removes an invalid LOT_SIZE', () => {
    process.env.LOT_SIZE = 'not-a-number'
    const strategy = defaultStrategies.find((s) => s.name === 'correct environment variables')

    strategy?.apply()

    expect(process.env.LOT_SIZE).toBeUndefined()
  })
})
