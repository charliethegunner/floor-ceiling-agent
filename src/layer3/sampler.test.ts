import { describe, expect, test, afterEach } from 'vitest'
import { ParallelCandidateSampler } from './sampler'
import { TOPOLOGY_FLOOR, type TopologyCandidate } from '../topology-floor'
import { WorkerPoolEvaluator } from '../layer1/worker-pool'
import type { WorkerOffload } from './types'

// Fixtures mirroring the shapes already exercised in CeilingAgent.test.ts /
// topology-floor.test.ts, kept self-contained (inMemoryFiles only) so this
// suite has no dependency on the real lib/ directory's current contents.

const GOOD: TopologyCandidate = {
  inMemoryFiles: { 'a.ts': 'export function a(): number { return 1 }' },
  expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
  reachability: [],
}

// Fails only the exports gate (not actually exported) - types/reachability
// still pass, so this scores 2/3.
const MISSING_EXPORT: TopologyCandidate = {
  inMemoryFiles: { 'a.ts': 'function a(): number { return 1 }' },
  expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
  reachability: [],
}

// Fails both the exports gate (not exported) AND the types gate (explicit
// `any`) - scores 1/3, strictly worse than MISSING_EXPORT.
const WORSE: TopologyCandidate = {
  inMemoryFiles: { 'a.ts': 'function a(value: any): unknown { return value }' },
  expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
  reachability: [],
}

describe('ParallelCandidateSampler: genuinely drives the real TOPOLOGY_FLOOR (Phase 6)', () => {
  test('selects a fully-passing candidate among a mix of bad and good candidates', async () => {
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({ sampleSize: 3 })
    const candidates = [MISSING_EXPORT, GOOD, WORSE]

    const result = await sampler.evaluateBestOfN(async (_temperature, index) => candidates[index], TOPOLOGY_FLOOR)

    expect(result.ok).toBe(true)
    expect(result.selected?.report.ok).toBe(true)
    expect(result.selected?.candidate.payload).toEqual(GOOD)
  })

  test('with earlyExitOnSuccess:false, every candidate is evaluated even once a passing one is found', async () => {
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({ sampleSize: 3, earlyExitOnSuccess: false })
    const candidates = [GOOD, GOOD, MISSING_EXPORT]

    const result = await sampler.evaluateBestOfN(async (_temperature, index) => candidates[index], TOPOLOGY_FLOOR)

    expect(result.evaluations).toHaveLength(3)
    expect(result.ok).toBe(true)
  })

  test('falls back to the highest-scoring candidate and reports ok:false when nothing fully passes', async () => {
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({ sampleSize: 2 })
    // WORSE generated first (index 0) so a correct result proves the sampler
    // actually re-ranks by score, not just picks whatever came first.
    const candidates = [WORSE, MISSING_EXPORT]

    const result = await sampler.evaluateBestOfN(async (_temperature, index) => candidates[index], TOPOLOGY_FLOOR)

    expect(result.ok).toBe(false)
    expect(result.evaluations).toHaveLength(2)
    expect(result.selected?.candidate.payload).toEqual(MISSING_EXPORT)
    expect(result.evaluations[0].score).toBeGreaterThanOrEqual(result.evaluations[1].score)
  })

  test('a rejecting generatorFn call does not produce an unhandled rejection, and evaluateBestOfN still resolves using whichever candidates DID succeed', async () => {
    // earlyExitOnSuccess defaults to true - this is specifically exercising
    // the early-exit branch's resilience to a rejecting sibling candidate.
    // (Promise.all's !earlyExitOnSuccess branch legitimately rejects on any
    // failure - that's intentional, unrelated to this fix.)
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({ sampleSize: 3 })
    const candidates: Array<() => Promise<TopologyCandidate>> = [
      async () => {
        throw new Error('simulated generatorFn failure (e.g. a real network error)')
      },
      async () => GOOD,
      async () => MISSING_EXPORT,
    ]

    const result = await sampler.evaluateBestOfN(async (_temperature, index) => candidates[index](), TOPOLOGY_FLOOR)

    // The exact settled count is a race (early exit can resolve as soon as
    // GOOD settles, regardless of whether MISSING_EXPORT has yet) - what
    // matters, and is deterministic, is that the rejecting candidate never
    // hangs or crashes the round, and a real passing candidate still wins.
    expect(result.ok).toBe(true)
    expect(result.selected?.candidate.payload).toEqual(GOOD)
  })

  test('if EVERY candidate rejects, evaluateBestOfN still resolves (does not hang forever) with an empty, failing result', async () => {
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({ sampleSize: 3 })

    const result = await sampler.evaluateBestOfN(async () => {
      throw new Error('simulated generatorFn failure')
    }, TOPOLOGY_FLOOR)

    expect(result.ok).toBe(false)
    expect(result.evaluations).toHaveLength(0)
    expect(result.selected).toBeUndefined()
  })

  test('the "fixed" temperature strategy passes the same baseTemperature to every generatorFn call', async () => {
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({
      sampleSize: 3,
      baseTemperature: 0.5,
      temperatureStrategy: 'fixed',
      earlyExitOnSuccess: false,
    })
    const seenTemperatures: number[] = []

    await sampler.evaluateBestOfN(async (temperature) => {
      seenTemperatures.push(temperature)
      return GOOD
    }, TOPOLOGY_FLOOR)

    expect(seenTemperatures).toEqual([0.5, 0.5, 0.5])
  })

  test('the "stepped" temperature strategy increases by 0.2 per sample', async () => {
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({
      sampleSize: 3,
      baseTemperature: 0.2,
      temperatureStrategy: 'stepped',
      earlyExitOnSuccess: false,
    })
    const seenTemperatures: number[] = []

    await sampler.evaluateBestOfN(async (temperature) => {
      seenTemperatures.push(temperature)
      return MISSING_EXPORT
    }, TOPOLOGY_FLOOR)

    expect(seenTemperatures.map((t) => Number(t.toFixed(1))).sort()).toEqual([0.2, 0.4, 0.6])
  })

  test('the "stepped" temperature strategy caps at 1.0', async () => {
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({
      sampleSize: 3,
      baseTemperature: 0.9,
      temperatureStrategy: 'stepped',
      earlyExitOnSuccess: false,
    })
    const seenTemperatures: number[] = []

    await sampler.evaluateBestOfN(async (temperature) => {
      seenTemperatures.push(temperature)
      return MISSING_EXPORT
    }, TOPOLOGY_FLOOR)

    expect(seenTemperatures.map((t) => Number(t.toFixed(1))).sort()).toEqual([0.9, 1, 1])
  })

  test('the "random" temperature strategy produces values within [0, 1)', async () => {
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({
      sampleSize: 5,
      temperatureStrategy: 'random',
      earlyExitOnSuccess: false,
    })
    const seenTemperatures: number[] = []

    await sampler.evaluateBestOfN(async (temperature) => {
      seenTemperatures.push(temperature)
      return MISSING_EXPORT
    }, TOPOLOGY_FLOOR)

    expect(seenTemperatures).toHaveLength(5)
    for (const t of seenTemperatures) {
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThan(1)
    }
  })

  test('totalElapsedMs is reported as a non-negative number', async () => {
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({ sampleSize: 1 })
    const result = await sampler.evaluateBestOfN(async () => GOOD, TOPOLOGY_FLOOR)

    expect(result.totalElapsedMs).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// Phase 9: optional CPU-parallel offload to WorkerPoolEvaluator
// (src/layer1/worker-pool.ts). Real worker_threads are spawned here too, so
// every pool created must be shut down or the process hangs at exit.
// ---------------------------------------------------------------------------

const pools: WorkerPoolEvaluator[] = []
function trackedPool(...args: ConstructorParameters<typeof WorkerPoolEvaluator>): WorkerPoolEvaluator {
  const pool = new WorkerPoolEvaluator(...args)
  pools.push(pool)
  return pool
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()))
})

function topologyWorkerOffload(pool: WorkerPoolEvaluator): WorkerOffload<TopologyCandidate> {
  return {
    pool,
    toTask: (candidate) => ({ domain: 'topology', candidateText: JSON.stringify(candidate) }),
  }
}

describe('ParallelCandidateSampler: optional worker-pool offload (Phase 9)', () => {
  test('with workerOffload configured, a passing candidate is still selected correctly', async () => {
    const pool = trackedPool({ poolSize: 1 })
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({ sampleSize: 3 }, topologyWorkerOffload(pool))
    const candidates = [MISSING_EXPORT, GOOD, WORSE]

    const result = await sampler.evaluateBestOfN(async (_temperature, index) => candidates[index], TOPOLOGY_FLOOR)

    expect(result.ok).toBe(true)
    expect(result.selected?.candidate.payload).toEqual(GOOD)
    expect(result.selected?.report.gates.map((g) => g.gate)).toEqual(['exports', 'types', 'reachability'])
  }, 15000)

  test('with workerOffload configured, a fallback-to-highest-score result still works when nothing passes', async () => {
    const pool = trackedPool({ poolSize: 1 })
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({ sampleSize: 2 }, topologyWorkerOffload(pool))
    const candidates = [WORSE, MISSING_EXPORT]

    const result = await sampler.evaluateBestOfN(async (_temperature, index) => candidates[index], TOPOLOGY_FLOOR)

    expect(result.ok).toBe(false)
    expect(result.selected?.candidate.payload).toEqual(MISSING_EXPORT)
  }, 15000)

  test('toTask returning null for every candidate falls back to identical in-process behavior', async () => {
    const pool = trackedPool({ poolSize: 1 })
    const offload: WorkerOffload<TopologyCandidate> = { pool, toTask: () => null }
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({ sampleSize: 3 }, offload)
    const candidates = [MISSING_EXPORT, GOOD, WORSE]

    const result = await sampler.evaluateBestOfN(async (_temperature, index) => candidates[index], TOPOLOGY_FLOOR)

    expect(result.ok).toBe(true)
    expect(result.selected?.candidate.payload).toEqual(GOOD)
  }, 15000)

  test('a shut-down worker pool transparently falls back to in-process verification, not a dropped/failed result', async () => {
    const pool = new WorkerPoolEvaluator({ poolSize: 1 })
    await pool.shutdown() // deliberately not tracked/kept alive - already dead before use
    const sampler = new ParallelCandidateSampler<TopologyCandidate>({ sampleSize: 1 }, topologyWorkerOffload(pool))

    const result = await sampler.evaluateBestOfN(async () => GOOD, TOPOLOGY_FLOOR)

    expect(result.ok).toBe(true)
    expect(result.selected?.report.gates.every((g) => g.ok)).toBe(true)
  }, 15000)
})
