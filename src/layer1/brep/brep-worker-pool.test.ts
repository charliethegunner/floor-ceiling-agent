import { describe, expect, test, afterEach } from 'vitest'
import { BRepWorkerPoolEvaluator, type BRepWorkerVerifyTask } from './brep-worker-pool'
import type { BRepCandidate } from './brep-floor'
import type { WorkerGateOutcome } from '../worker-pool-worker'

// Real worker_threads are spawned - the SAME spike-verified mechanism
// (new Worker(tsFile, {execArgv:['--import','tsx']})) worker-pool.ts's own
// test suite relies on, now also loading a real OpenCASCADE WASM kernel
// inside the worker. Every pool created here MUST be shut down or the
// process hangs at exit. poolSize:1 throughout - a second worker means a
// second ~450-500MB kernel instance, real cost this suite has no reason to
// pay for coverage that doesn't need it.
const pools: BRepWorkerPoolEvaluator[] = []
function trackedPool(...args: ConstructorParameters<typeof BRepWorkerPoolEvaluator>): BRepWorkerPoolEvaluator {
  const pool = new BRepWorkerPoolEvaluator(...args)
  pools.push(pool)
  return pool
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()))
})

const NEVER_CALLED = async (): Promise<WorkerGateOutcome[]> => {
  throw new Error('fallback should not have been called')
}

const VALID_BOX: BRepCandidate = {
  solid: { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] },
  boundingBox: { min: [-6, -6, -6], max: [6, 6, 6] },
}

function task(overrides: Partial<BRepWorkerVerifyTask> = {}): BRepWorkerVerifyTask {
  return { domain: 'brep', candidate: VALID_BOX, ...overrides }
}

describe('BRepWorkerPoolEvaluator: initialization', () => {
  test('defaults poolSize to 1, unlike the general WorkerPoolEvaluator (each worker carries a real ~450-500MB OpenCASCADE instance)', () => {
    const pool = trackedPool()
    expect(pool.poolSize).toBe(1)
  })

  test('an explicit poolSize is honored', () => {
    const pool = trackedPool({ poolSize: 2 })
    expect(pool.poolSize).toBe(2)
  })

  test('poolSize is never less than 1', () => {
    const pool = trackedPool({ poolSize: 0 })
    expect(pool.poolSize).toBe(1)
  })
})

describe('BRepWorkerPoolEvaluator: genuinely verifies real B-Rep geometry inside a worker thread', () => {
  test('a well-formed box passes both real gates through the real worker', async () => {
    const pool = trackedPool()
    const gates = await pool.verify(task(), NEVER_CALLED)
    expect(gates.map((g) => g.gate)).toEqual(['structural-validity', 'volumetric-bound', 'step-export'])
    expect(gates.every((g) => g.ok)).toBe(true)
  }, 15000)

  test('degenerate geometry is reported as a real failure through the worker, not an uncaught exception', async () => {
    const pool = trackedPool()
    const degenerate: BRepCandidate = { solid: { type: 'sphere', center: [0, 0, 0], radius: -1 }, boundingBox: { min: [-1, -1, -1], max: [1, 1, 1] } }
    const gates = await pool.verify(task({ candidate: degenerate }), NEVER_CALLED)
    expect(gates.every((g) => g.ok)).toBe(false)
    expect(gates[0].details).toContain('radius must be > 0')
  }, 15000)

  test('a union genuinely reflects both shapes through the real worker (Shape() vs Shape1()/Shape2() correctness survives the worker round-trip too)', async () => {
    const pool = trackedPool()
    const union: BRepCandidate = {
      solid: { type: 'union', children: [{ type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] }, { type: 'sphere', center: [5, 0, 0], radius: 3 }] },
      boundingBox: { min: [-6, -6, -6], max: [9, 6, 6] },
    }
    const gates = await pool.verify(task({ candidate: union }), NEVER_CALLED)
    expect(gates.every((g) => g.ok)).toBe(true)
    expect(gates.find((g) => g.gate === 'volumetric-bound')?.details).toContain('8.0000')
  }, 15000)

  test('multiple concurrent tasks on a single-worker pool are all answered correctly (request/response correlation)', async () => {
    const pool = trackedPool()
    const spheres = [1, 2, 3].map((radius): BRepCandidate => ({ solid: { type: 'sphere', center: [0, 0, 0], radius }, boundingBox: { min: [-10, -10, -10], max: [10, 10, 10] } }))
    const results = await Promise.all(spheres.map((candidate) => pool.verify(task({ candidate }), NEVER_CALLED)))
    for (const gates of results) expect(gates.every((g) => g.ok)).toBe(true)
  }, 20000)

  test('the cold-init cost is paid once, not once per task - a second call is dramatically faster than the first', async () => {
    const pool = trackedPool()
    const start1 = Date.now()
    await pool.verify(task(), NEVER_CALLED)
    const firstMs = Date.now() - start1

    const start2 = Date.now()
    await pool.verify(task(), NEVER_CALLED)
    const secondMs = Date.now() - start2

    expect(secondMs).toBeLessThan(firstMs / 2)
  }, 15000)
})

describe('BRepWorkerPoolEvaluator: RSS monitoring and recycling', () => {
  test('a worker reporting RSS above maxWorkerRssBytes is proactively terminated and respawned, and the pool keeps working', async () => {
    const pool = trackedPool({ maxWorkerRssBytes: 1000 })
    const gates = await pool.verify(task({ __testFakeRssBytes: 999_999_999 }), NEVER_CALLED)
    expect(gates.every((g) => g.ok)).toBe(true) // the task itself still succeeded before recycling happened
    expect(pool.recycledWorkerCount).toBe(1)

    const recoveryGates = await pool.verify(task(), NEVER_CALLED)
    expect(recoveryGates.every((g) => g.ok)).toBe(true)
  }, 20000)

  test('RSS at or below maxWorkerRssBytes never triggers recycling', async () => {
    const pool = trackedPool({ maxWorkerRssBytes: 1000 })
    await pool.verify(task({ __testFakeRssBytes: 1000 }), NEVER_CALLED)
    expect(pool.recycledWorkerCount).toBe(0)
  }, 15000)

  test('a real (non-fake) task does not spuriously recycle a healthy worker under normal operation, using the 900MB default informed by the Phase 15.0 spike\'s measured ~470-500MB steady state', async () => {
    const pool = trackedPool()
    await pool.verify(task(), NEVER_CALLED)
    expect(pool.recycledWorkerCount).toBe(0)
  }, 15000)
})

describe('BRepWorkerPoolEvaluator: task timeout handling', () => {
  test('a task exceeding taskTimeoutMs falls back rather than hanging forever', async () => {
    const pool = trackedPool({ taskTimeoutMs: 5 })
    let fallbackCalled = false

    const gates = await pool.verify(task({ __testDelayMs: 200 }), async () => {
      fallbackCalled = true
      return [{ gate: 'timeout-fallback', ok: false, details: 'fell back after timeout' }]
    })

    expect(fallbackCalled).toBe(true)
    expect(gates[0].details).toContain('fell back after timeout')
  }, 15000)

  test('a task well within taskTimeoutMs succeeds normally', async () => {
    const pool = trackedPool({ taskTimeoutMs: 10000 })
    const gates = await pool.verify(task(), NEVER_CALLED)
    expect(gates.every((g) => g.ok)).toBe(true)
  }, 15000)
})

describe('BRepWorkerPoolEvaluator: fallback behavior when a worker fails, and recovery after a crash', () => {
  test('a genuine worker crash triggers fallback for that task, and the pool respawns and keeps working', async () => {
    const pool = trackedPool()

    let fallbackCalled = false
    const gates = await pool.verify(task({ __testCrash: true }), async () => {
      fallbackCalled = true
      return [{ gate: 'crash-fallback', ok: false, details: 'fell back after worker crash' }]
    })
    expect(fallbackCalled).toBe(true)
    expect(gates[0].details).toContain('fell back after worker crash')

    const recoveryGates = await pool.verify(task(), NEVER_CALLED)
    expect(recoveryGates.every((g) => g.ok)).toBe(true)
  }, 20000)
})

describe('BRepWorkerPoolEvaluator: graceful shutdown', () => {
  test('shutdown() resolves and terminates every worker', async () => {
    const pool = new BRepWorkerPoolEvaluator({ poolSize: 1 })
    await expect(pool.shutdown()).resolves.toBeUndefined()
  }, 15000)

  test('verify() after shutdown falls back immediately rather than contacting a terminated worker', async () => {
    const pool = new BRepWorkerPoolEvaluator({ poolSize: 1 })
    await pool.shutdown()

    let fallbackCalled = false
    const gates = await pool.verify(task(), async () => {
      fallbackCalled = true
      return [{ gate: 'post-shutdown-fallback', ok: false, details: 'pool was already shut down' }]
    })
    expect(fallbackCalled).toBe(true)
    expect(gates[0].details).toContain('already shut down')
  }, 15000)

  test('shutdown() is safe to call twice', async () => {
    const pool = new BRepWorkerPoolEvaluator({ poolSize: 1 })
    await pool.shutdown()
    await expect(pool.shutdown()).resolves.toBeUndefined()
  }, 15000)
})
