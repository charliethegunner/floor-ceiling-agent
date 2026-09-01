import { describe, test, expect, afterEach } from 'vitest'
import { registerForGracefulShutdown, runGracefulShutdown, registeredPoolCount, type Terminable } from './process-lifecycle'
import { WorkerPoolEvaluator } from './worker-pool'
import { BRepWorkerPoolEvaluator } from './brep/brep-worker-pool'
import type { SpatialCandidate } from '../spatial-floor'
import type { BRepCandidate } from './brep/brep-floor'

// Real worker_threads are spawned in the integration tests below, so any
// pool NOT already terminated by the test itself (runGracefulShutdown
// tests terminate their own pool as part of what they're proving) must be
// cleaned up here, or the process hangs at exit.
const pools: Array<{ shutdown(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()))
})

/** A real, verifiable signal that an OS-level worker thread is genuinely
 *  alive or gone - spike-confirmed: each live Worker registers exactly one
 *  MessagePort resource in the parent process, which disappears entirely
 *  once terminate() completes. Used instead of trying to catch a real
 *  SIGINT/SIGTERM (see process-lifecycle.ts's header comment on
 *  runGracefulShutdown for why that can't be reliably tested on Windows -
 *  confirmed empirically: child_process.kill('SIGINT'/'SIGTERM') force-
 *  terminates a Node child directly here, with no handler ever running). */
function countWorkerMessagePorts(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'MessagePort').length
}

describe('process-lifecycle: registration bookkeeping', () => {
  test('registering a pool increases the count; the returned unregister function decreases it', () => {
    const before = registeredPoolCount()
    const pool: Terminable = { terminate: async () => {} }
    const unregister = registerForGracefulShutdown(pool)
    expect(registeredPoolCount()).toBe(before + 1)
    unregister()
    expect(registeredPoolCount()).toBe(before)
  })

  test('unregistering twice is safe (idempotent)', () => {
    const before = registeredPoolCount()
    const pool: Terminable = { terminate: async () => {} }
    const unregister = registerForGracefulShutdown(pool)
    unregister()
    unregister()
    expect(registeredPoolCount()).toBe(before)
  })
})

describe('runGracefulShutdown: the real cleanup fan-out, invoked directly (not via a real OS signal - see this test file\'s header comment)', () => {
  test('terminates every currently-registered pool and clears the registry', async () => {
    const terminated: string[] = []
    const poolA: Terminable = {
      terminate: async () => {
        terminated.push('a')
      },
    }
    const poolB: Terminable = {
      terminate: async () => {
        terminated.push('b')
      },
    }
    registerForGracefulShutdown(poolA)
    registerForGracefulShutdown(poolB)

    await runGracefulShutdown()

    expect(terminated.sort()).toEqual(['a', 'b'])
    expect(registeredPoolCount()).toBe(0)
  })

  test('a pool whose terminate() throws never blocks another pool\'s cleanup', async () => {
    const terminated: string[] = []
    const failing: Terminable = {
      terminate: async () => {
        throw new Error('boom')
      },
    }
    const healthy: Terminable = {
      terminate: async () => {
        terminated.push('healthy')
      },
    }
    registerForGracefulShutdown(failing)
    registerForGracefulShutdown(healthy)

    await expect(runGracefulShutdown()).resolves.toBeUndefined()
    expect(terminated).toEqual(['healthy'])
  })

  test('with nothing registered, resolves immediately without error', async () => {
    await expect(runGracefulShutdown()).resolves.toBeUndefined()
  })
})

const VALID_SPHERE: SpatialCandidate = { surface: { type: 'sphere', center: [0, 0, 0], radius: 1 }, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } }
const VALID_BOX: BRepCandidate = { solid: { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] }, boundingBox: { min: [-6, -6, -6], max: [6, 6, 6] } }
const NEVER_CALLED = async () => {
  throw new Error('fallback should not have been called')
}

describe('process-lifecycle: real integration with WorkerPoolEvaluator - genuine OS threads, not simulated', () => {
  test('constructing a pool registers it; shutdown() unregisters it AND the underlying worker threads are genuinely gone (zero leaked MessagePort handles)', async () => {
    const before = registeredPoolCount()
    const portsBefore = countWorkerMessagePorts()

    const pool = new WorkerPoolEvaluator({ poolSize: 2 })
    expect(registeredPoolCount()).toBe(before + 1)
    await pool.verify({ domain: 'spatial', candidateText: JSON.stringify(VALID_SPHERE) }, NEVER_CALLED)
    expect(countWorkerMessagePorts()).toBeGreaterThan(portsBefore)

    await pool.shutdown()
    expect(registeredPoolCount()).toBe(before)
    expect(countWorkerMessagePorts()).toBe(portsBefore)
  }, 15000)

  test('runGracefulShutdown() genuinely terminates a real WorkerPoolEvaluator that never called its own shutdown() - the real scenario an interrupted run leaves behind', async () => {
    const before = registeredPoolCount()
    const portsBefore = countWorkerMessagePorts()

    const pool = new WorkerPoolEvaluator({ poolSize: 1 })
    await pool.verify({ domain: 'spatial', candidateText: JSON.stringify(VALID_SPHERE) }, NEVER_CALLED)
    expect(registeredPoolCount()).toBe(before + 1)
    expect(countWorkerMessagePorts()).toBeGreaterThan(portsBefore)

    await runGracefulShutdown()

    expect(registeredPoolCount()).toBe(before)
    expect(countWorkerMessagePorts()).toBe(portsBefore)

    let fallbackCalled = false
    await pool.verify({ domain: 'spatial', candidateText: JSON.stringify(VALID_SPHERE) }, async () => {
      fallbackCalled = true
      return []
    })
    expect(fallbackCalled).toBe(true)
  }, 15000)
})

describe('process-lifecycle: real integration with BRepWorkerPoolEvaluator - the same shared mechanism, the heavier OpenCASCADE pool', () => {
  test('constructing a pool registers it; shutdown() unregisters it and terminates the real worker thread', async () => {
    const before = registeredPoolCount()

    const pool = new BRepWorkerPoolEvaluator({ poolSize: 1 })
    pools.push(pool)
    expect(registeredPoolCount()).toBe(before + 1)
    await pool.verify({ domain: 'brep', candidate: VALID_BOX }, NEVER_CALLED)

    await pool.shutdown()
    pools.length = 0 // already shut down above
    expect(registeredPoolCount()).toBe(before)
  }, 15000)

  test('runGracefulShutdown() genuinely terminates a real, still-open BRepWorkerPoolEvaluator', async () => {
    const before = registeredPoolCount()

    const pool = new BRepWorkerPoolEvaluator({ poolSize: 1 })
    await pool.verify({ domain: 'brep', candidate: VALID_BOX }, NEVER_CALLED)
    expect(registeredPoolCount()).toBe(before + 1)

    await runGracefulShutdown()
    expect(registeredPoolCount()).toBe(before)

    let fallbackCalled = false
    await pool.verify({ domain: 'brep', candidate: VALID_BOX }, async () => {
      fallbackCalled = true
      return []
    })
    expect(fallbackCalled).toBe(true)
  }, 15000)
})
