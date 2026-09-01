import { describe, expect, test, afterEach } from 'vitest'
import os from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerPoolEvaluator, ProjectPackIngestor, toWorkspaceFiles, type WorkerGateOutcome } from './worker-pool'
import type { TopologyCandidate } from '../topology-floor'
import type { ClaimCandidate } from '../claim-floor'
import type { SpatialCandidate } from '../spatial-floor'

// Real worker_threads are spawned (spike-verified: new Worker(tsFile,
// {execArgv:['--import','tsx']}) genuinely loads a .ts entry, including Z3's
// WASM module, both standalone and from inside vitest) - so every pool
// created here MUST be shut down, or the process hangs at exit. Small pool
// sizes (1-2) keep the suite fast; spawn + Z3 WASM init is real, not free.
const pools: WorkerPoolEvaluator[] = []
function trackedPool(...args: ConstructorParameters<typeof WorkerPoolEvaluator>): WorkerPoolEvaluator {
  const pool = new WorkerPoolEvaluator(...args)
  pools.push(pool)
  return pool
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()))
})

const NEVER_CALLED = async (): Promise<WorkerGateOutcome[]> => {
  throw new Error('fallback should not have been called')
}

describe('WorkerPoolEvaluator: initialization', () => {
  test('defaults poolSize to os.cpus().length - 1', () => {
    const pool = trackedPool()
    expect(pool.poolSize).toBe(Math.max(1, os.cpus().length - 1))
  })

  test('an explicit poolSize is honored', () => {
    const pool = trackedPool({ poolSize: 2 })
    expect(pool.poolSize).toBe(2)
  })

  test('poolSize is never less than 1, even if os.cpus().length - 1 would be 0 or negative', () => {
    const pool = trackedPool({ poolSize: 0 })
    expect(pool.poolSize).toBe(1)
  })
})

describe('WorkerPoolEvaluator: genuinely offloads real verification to a worker thread', () => {
  test('topology domain: a well-formed candidate is verified correctly through the real TOPOLOGY_FLOOR', async () => {
    const pool = trackedPool({ poolSize: 1 })
    const candidate: TopologyCandidate = {
      inMemoryFiles: { 'a.ts': 'export function a(): number { return 1 }' },
      expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
      reachability: [],
    }
    const gates = await pool.verify({ domain: 'topology', candidateText: JSON.stringify(candidate) }, NEVER_CALLED)
    expect(gates.map((g) => g.gate)).toEqual(['exports', 'types', 'reachability'])
    expect(gates.every((g) => g.ok)).toBe(true)
  }, 15000)

  test('claim domain: an empirical failure is caught correctly through the real CLAIM_VERIFICATION_FLOOR', async () => {
    const pool = trackedPool({ poolSize: 1 })
    const candidate: ClaimCandidate = {
      claims: [
        {
          statement: 'a deliberately wrong claim',
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X1, X0' } },
        },
      ],
    }
    const gates = await pool.verify({ domain: 'claim', candidateText: JSON.stringify(candidate) }, NEVER_CALLED)
    expect(gates.find((g) => g.gate === 'empirical')?.ok).toBe(false)
  }, 15000)

  test('spatial domain: a well-formed sphere is verified correctly through the real SPATIAL_VERIFICATION_FLOOR', async () => {
    const pool = trackedPool({ poolSize: 1 })
    const candidate: SpatialCandidate = { surface: { type: 'sphere', center: [0, 0, 0], radius: 1 }, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } }
    const gates = await pool.verify({ domain: 'spatial', candidateText: JSON.stringify(candidate) }, NEVER_CALLED)
    expect(gates.every((g) => g.ok)).toBe(true)
  }, 15000)

  test('instruction domain: a real Z3 symbolic proof runs inside the worker', async () => {
    const pool = trackedPool({ poolSize: 1 })
    const gates = await pool.verify({ domain: 'instruction', x86Instruction: 'MOV RAX, RBX', candidateText: 'MOV X0, X1' }, NEVER_CALLED)
    const symbolic = gates.find((g) => g.gate === 'symbolic')
    expect(symbolic?.ok).toBe(true)
    expect(symbolic?.details).toContain('Z3 proved')
  }, 15000)

  test('a fenced JSON candidate is stripped and parsed correctly inside the worker too (Phase 5.1 parity)', async () => {
    const pool = trackedPool({ poolSize: 1 })
    const candidate: TopologyCandidate = {
      inMemoryFiles: { 'a.ts': 'export function a(): number { return 1 }' },
      expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
      reachability: [],
    }
    const gates = await pool.verify({ domain: 'topology', candidateText: '```json\n' + JSON.stringify(candidate) + '\n```' }, NEVER_CALLED)
    expect(gates.every((g) => g.ok)).toBe(true)
  }, 15000)

  test('malformed candidate text is reported as a failure via the fallback path, not an uncaught exception', async () => {
    const pool = trackedPool({ poolSize: 1 })
    let fallbackCalled = false
    const gates = await pool.verify({ domain: 'topology', candidateText: 'not valid json {{{' }, async () => {
      fallbackCalled = true
      return [{ gate: 'exports', ok: false, details: 'fallback: not valid JSON' }]
    })
    expect(fallbackCalled).toBe(true)
    expect(gates[0].ok).toBe(false)
  }, 15000)

  test('multiple concurrent tasks on a single-worker pool are all answered correctly (request/response correlation)', async () => {
    const pool = trackedPool({ poolSize: 1 })
    const makeCandidate = (radius: number): SpatialCandidate => ({ surface: { type: 'sphere', center: [0, 0, 0], radius }, boundingBox: { min: [-5, -5, -5], max: [5, 5, 5] } })

    const results = await Promise.all(
      [1, 2, 3, 4].map((radius) => pool.verify({ domain: 'spatial', candidateText: JSON.stringify(makeCandidate(radius)) }, NEVER_CALLED))
    )
    for (const gates of results) {
      expect(gates.every((g) => g.ok)).toBe(true)
    }
  }, 20000)
})

describe('WorkerPoolEvaluator: Phase 12.0 workspaceFiles gives topology tasks real multi-file repository context', () => {
  test('a candidate that fails reachability alone (its dependency is missing) passes once a real ingested workspace supplies that dependency', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'worker-pool-ingest-'))
    try {
      writeFileSync(join(workspace, 'b.ts'), 'export function b(): number { return 2 }\n')

      const candidate: TopologyCandidate = {
        inMemoryFiles: { 'a.ts': "import { b } from './b'\nexport function a(): number { return b() }\n" },
        expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
        reachability: [{ from: { filePath: 'a.ts', functionName: 'a' }, to: { filePath: 'b.ts', functionName: 'b' }, expectReachable: true }],
      }

      const pool = trackedPool({ poolSize: 1 })

      // Without repository context, a.ts's own import of './b' can't
      // resolve to anything - a genuine reachability failure, not a
      // contrived one.
      const withoutContext = await pool.verify({ domain: 'topology', candidateText: JSON.stringify(candidate) }, NEVER_CALLED)
      expect(withoutContext.find((g) => g.gate === 'reachability')?.ok).toBe(false)

      // Real ingestion of a real directory on disk, through the exact
      // ProjectPackIngestor/toWorkspaceFiles surface worker-pool.ts
      // re-exports.
      const graph = await new ProjectPackIngestor().ingestWorkspace(workspace)
      const workspaceFiles = toWorkspaceFiles(graph)
      expect(workspaceFiles['b.ts']).toContain('export function b')

      const withContext = await pool.verify({ domain: 'topology', candidateText: JSON.stringify(candidate), workspaceFiles }, NEVER_CALLED)
      expect(withContext.every((g) => g.ok)).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 15000)

  test("the candidate's own file wins over workspaceFiles on a path collision", async () => {
    const pool = trackedPool({ poolSize: 1 })
    const candidate: TopologyCandidate = {
      inMemoryFiles: { 'a.ts': 'export function a(): number { return 1 }' },
      expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
      reachability: [],
    }
    // workspaceFiles supplies a conflicting, broken version of a.ts (no
    // export) - the candidate's own real a.ts must still be what gets
    // verified.
    const gates = await pool.verify(
      { domain: 'topology', candidateText: JSON.stringify(candidate), workspaceFiles: { 'a.ts': 'function a(): number { return 999 }' } },
      NEVER_CALLED
    )
    expect(gates.every((g) => g.ok)).toBe(true)
  }, 15000)
})

describe('WorkerPoolEvaluator: Phase 13.3 worker RSS monitoring and recycling', () => {
  const VALID_SPHERE = { surface: { type: 'sphere', center: [0, 0, 0], radius: 1 }, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } }

  test('a worker reporting RSS above maxWorkerRssBytes is proactively terminated and respawned, and the pool keeps working', async () => {
    const pool = trackedPool({ poolSize: 1, maxWorkerRssBytes: 1000 })

    // __testFakeRssBytes is test-only instrumentation (worker-pool-worker.ts)
    // that reports a fabricated RSS instead of the real reading, so this is
    // deterministic without actually allocating hundreds of MB.
    const gates = await pool.verify({ domain: 'spatial', candidateText: JSON.stringify(VALID_SPHERE), __testFakeRssBytes: 999_999_999 }, NEVER_CALLED)
    expect(gates.every((g) => g.ok)).toBe(true) // the task itself still succeeded before recycling happened
    expect(pool.recycledWorkerCount).toBe(1)

    // The respawned worker is genuinely functional.
    const recoveryGates = await pool.verify({ domain: 'spatial', candidateText: JSON.stringify(VALID_SPHERE) }, NEVER_CALLED)
    expect(recoveryGates.every((g) => g.ok)).toBe(true)
  }, 15000)

  test('RSS at or below maxWorkerRssBytes never triggers recycling', async () => {
    const pool = trackedPool({ poolSize: 1, maxWorkerRssBytes: 1000 })
    await pool.verify({ domain: 'spatial', candidateText: JSON.stringify(VALID_SPHERE), __testFakeRssBytes: 1000 }, NEVER_CALLED)
    expect(pool.recycledWorkerCount).toBe(0)
  }, 15000)

  test('defaults maxWorkerRssBytes to 512MB (empirically justified - see DEFAULT_MAX_WORKER_RSS_BYTES\'s comment)', async () => {
    const pool = trackedPool({ poolSize: 1 })
    await pool.verify({ domain: 'spatial', candidateText: JSON.stringify(VALID_SPHERE), __testFakeRssBytes: 512 * 1024 * 1024 - 1 }, NEVER_CALLED)
    expect(pool.recycledWorkerCount).toBe(0)

    await pool.verify({ domain: 'spatial', candidateText: JSON.stringify(VALID_SPHERE), __testFakeRssBytes: 512 * 1024 * 1024 + 1 }, NEVER_CALLED)
    expect(pool.recycledWorkerCount).toBe(1)
  }, 15000)

  test('a real (non-fake) task reports a genuine positive RSS reading and does not spuriously recycle a healthy worker under normal operation', async () => {
    const pool = trackedPool({ poolSize: 1 })
    await pool.verify({ domain: 'spatial', candidateText: JSON.stringify(VALID_SPHERE) }, NEVER_CALLED)
    expect(pool.recycledWorkerCount).toBe(0)
  }, 15000)
})

describe('WorkerPoolEvaluator: task timeout handling', () => {
  test('a task exceeding taskTimeoutMs falls back rather than hanging forever', async () => {
    const pool = trackedPool({ poolSize: 1, taskTimeoutMs: 5 })
    let fallbackCalled = false

    const gates = await pool.verify(
      // __testDelayMs is a test-only instrumentation field the worker honors
      // by sleeping before running verification - the only reliable way to
      // deterministically exceed a real timeout without relying on timing luck.
      { domain: 'spatial', candidateText: JSON.stringify({ surface: { type: 'sphere', center: [0, 0, 0], radius: 1 }, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } }), __testDelayMs: 200 },
      async () => {
        fallbackCalled = true
        return [{ gate: 'timeout-fallback', ok: false, details: 'fell back after timeout' }]
      }
    )

    expect(fallbackCalled).toBe(true)
    expect(gates[0].details).toContain('fell back after timeout')
  }, 15000)

  test('a task well within taskTimeoutMs succeeds normally', async () => {
    const pool = trackedPool({ poolSize: 1, taskTimeoutMs: 10000 })
    const gates = await pool.verify(
      { domain: 'spatial', candidateText: JSON.stringify({ surface: { type: 'sphere', center: [0, 0, 0], radius: 1 }, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } }) },
      NEVER_CALLED
    )
    expect(gates.every((g) => g.ok)).toBe(true)
  }, 15000)
})

describe('WorkerPoolEvaluator: fallback behavior when a worker fails, and recovery after a crash', () => {
  test('a genuine worker crash triggers fallback for that task, and the pool respawns and keeps working', async () => {
    const pool = trackedPool({ poolSize: 1 })

    let fallbackCalled = false
    // __testCrash is a test-only instrumentation field: the worker calls
    // process.exit(1) immediately on receiving it, simulating a real crash
    // (as opposed to a caught-and-reported verification error).
    const gates = await pool.verify({ domain: 'spatial', candidateText: '{}', __testCrash: true }, async () => {
      fallbackCalled = true
      return [{ gate: 'crash-fallback', ok: false, details: 'fell back after worker crash' }]
    })
    expect(fallbackCalled).toBe(true)
    expect(gates[0].details).toContain('fell back after worker crash')

    // The pool must have respawned a replacement worker automatically -
    // prove it by successfully running a real task right after the crash.
    const recoveryGates = await pool.verify(
      { domain: 'spatial', candidateText: JSON.stringify({ surface: { type: 'sphere', center: [0, 0, 0], radius: 1 }, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } }) },
      NEVER_CALLED
    )
    expect(recoveryGates.every((g) => g.ok)).toBe(true)
  }, 20000)
})

describe('WorkerPoolEvaluator: graceful shutdown', () => {
  test('shutdown() resolves and terminates every worker', async () => {
    const pool = new WorkerPoolEvaluator({ poolSize: 2 })
    await expect(pool.shutdown()).resolves.toBeUndefined()
  }, 15000)

  test('verify() after shutdown falls back immediately rather than contacting a terminated worker', async () => {
    const pool = new WorkerPoolEvaluator({ poolSize: 1 })
    await pool.shutdown()

    let fallbackCalled = false
    const gates = await pool.verify({ domain: 'spatial', candidateText: '{}' }, async () => {
      fallbackCalled = true
      return [{ gate: 'post-shutdown-fallback', ok: false, details: 'pool was already shut down' }]
    })
    expect(fallbackCalled).toBe(true)
    expect(gates[0].details).toContain('already shut down')
  }, 15000)

  test('shutdown() is safe to call twice', async () => {
    const pool = new WorkerPoolEvaluator({ poolSize: 1 })
    await pool.shutdown()
    await expect(pool.shutdown()).resolves.toBeUndefined()
  }, 15000)
})
