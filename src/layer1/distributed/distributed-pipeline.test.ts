import { describe, test, expect, afterEach } from 'vitest'
import { SolverGridCoordinator } from './coordinator'
import { startSolverNode, type SolverNodeHandle } from './solver-node'
import { DistributedWorkerPoolEvaluator } from './distributed-worker-pool'
import { createSolverGridClient, type TaskLeaseMessage } from './proto'
import { verify, type WorkerVerifyTask, type WorkerGateOutcome } from '../worker-pool-worker'
import { runCeilingAgent, type LlmClient } from '../../CeilingAgent'
import type { TopologyCandidate } from '../../topology-floor'

// Phase 14.0 end-to-end integration: real gRPC, over a real TCP socket -
// the streaming mechanism itself was verified standalone (a real bind, a
// real server-streaming push, a real unary round-trip) before any of this
// was written, mirroring this project's established discipline for every
// primitive it relies on. These tests exercise the FULL pipeline
// (coordinator + real solver node process-equivalent + distributed pool),
// not mocks of it.

const SPATIAL_TASK: WorkerVerifyTask = {
  domain: 'spatial',
  candidateText: JSON.stringify({ surface: { type: 'sphere', center: [0, 0, 0], radius: 1 }, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } }),
}

const coordinators: SolverGridCoordinator[] = []
const nodes: SolverNodeHandle[] = []

function trackedCoordinator(...args: ConstructorParameters<typeof SolverGridCoordinator>): SolverGridCoordinator {
  const coordinator = new SolverGridCoordinator(...args)
  coordinators.push(coordinator)
  return coordinator
}

function trackedNode(...args: Parameters<typeof startSolverNode>): SolverNodeHandle {
  const node = startSolverNode(...args)
  nodes.push(node)
  return node
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.stop()))
  await Promise.all(coordinators.splice(0).map((c) => c.stop()))
})

describe('Distributed Solver Pipeline: real gRPC end-to-end', () => {
  test('a real spatial verification task is genuinely dispatched, run, and reported across the real network round-trip', async () => {
    const coordinator = trackedCoordinator()
    const address = await coordinator.start()
    trackedNode({ coordinatorAddress: address })

    const pool = new DistributedWorkerPoolEvaluator({ coordinator })
    const gates = await pool.verify(SPATIAL_TASK, async () => {
      throw new Error('fallback should not have been needed - this is a real, well-formed task with a healthy node available')
    })

    expect(gates.map((g) => g.gate)).toEqual(['continuity', 'volumetric-bound', 'self-intersection'])
    expect(gates.every((g) => g.ok)).toBe(true)
  }, 15000)

  test('a malformed candidate is reported as a real failure over the wire, not an uncaught exception anywhere in the pipeline', async () => {
    const coordinator = trackedCoordinator()
    const address = await coordinator.start()
    trackedNode({ coordinatorAddress: address })

    const pool = new DistributedWorkerPoolEvaluator({ coordinator })
    let fallbackCalled = false
    const gates = await pool.verify({ domain: 'spatial', candidateText: 'not valid json {{{' }, async () => {
      fallbackCalled = true
      return [{ gate: 'fallback', ok: false, details: 'fell back after a worker-side parse failure' }]
    })

    expect(fallbackCalled).toBe(true)
    expect(gates[0].ok).toBe(false)
  }, 15000)

  test('with zero solver nodes connected, verify() falls back rather than hanging or throwing to the caller', async () => {
    const coordinator = trackedCoordinator({ noNodeTimeoutMs: 300 })
    await coordinator.start()

    const pool = new DistributedWorkerPoolEvaluator({ coordinator })
    let fallbackCalled = false
    const gates = await pool.verify(SPATIAL_TASK, async () => {
      fallbackCalled = true
      return [{ gate: 'fallback', ok: true, details: 'used the local fallback path' }]
    })

    expect(fallbackCalled).toBe(true)
    expect(gates[0].details).toBe('used the local fallback path')
  }, 10000)

  test('a lease that expires with no heartbeat (a dead node, honestly simulated by simply never servicing it) is requeued and completed by a different, healthy node', async () => {
    const coordinator = trackedCoordinator({ leaseTimeoutMs: 150, maxLeaseAttempts: 3 })
    const address = await coordinator.start()

    // The "dead" node: leases the task directly from the queue (bypassing
    // the real solver-node loop) and then does nothing with it - exactly
    // what a genuinely dead node presents as to the coordinator.
    const enqueued = coordinator.enqueue(SPATIAL_TASK, 'auto')
    const deadLease = await coordinator.queue.requestLease()
    expect(deadLease).not.toBeNull()

    // A real, healthy solver node connects AFTER the dead lease is already
    // granted - it can only get this task once the dead lease's timeout
    // revokes it and requeues it.
    trackedNode({ coordinatorAddress: address, nodeId: 'healthy-node' })

    const gates = await enqueued
    expect(gates.every((g) => g.ok)).toBe(true)
  }, 15000)

  test('ExecutionMode genuinely crosses the real streaming wire in the TaskLease message (Phase 13.4.4/14.0 binding)', async () => {
    const coordinator = trackedCoordinator()
    const address = await coordinator.start()
    const pool = new DistributedWorkerPoolEvaluator({ coordinator, executionMode: 'interactive' })

    const enqueuedPromise = pool.verify(SPATIAL_TASK, async () => {
      throw new Error('no fallback expected')
    })

    // A raw probe client - not startSolverNode's loop - so this test
    // inspects the ACTUAL TaskLease message a real node receives over the
    // real gRPC stream, not an internal mock of one.
    const probe = createSolverGridClient(address)
    const lease = await new Promise<TaskLeaseMessage>((resolve, reject) => {
      const call = probe.leaseTask({ nodeId: 'probe' })
      call.on('data', resolve)
      call.on('error', reject)
    })

    expect(lease.executionMode).toBe('interactive')

    const task = JSON.parse(lease.taskJson) as WorkerVerifyTask
    const gates: WorkerGateOutcome[] = await verify(task)
    await new Promise<void>((resolve, reject) => {
      probe.reportResult({ leaseId: lease.leaseId, ok: true, gatesJson: JSON.stringify(gates), error: '' }, (err) => (err ? reject(err) : resolve()))
    })
    probe.close()

    const finalGates = await enqueuedPromise
    expect(finalGates.every((g) => g.ok)).toBe(true)
  }, 15000)

  test('DistributedWorkerPoolEvaluator defaults executionMode to "auto" when none is supplied', () => {
    const coordinator = trackedCoordinator()
    const pool = new DistributedWorkerPoolEvaluator({ coordinator })
    expect(pool.executionMode).toBe('auto')
  })

  test('shutdown() stops the coordinator, and a subsequent verify() call falls back rather than hanging', async () => {
    const coordinator = trackedCoordinator({ noNodeTimeoutMs: 300 })
    await coordinator.start()
    const pool = new DistributedWorkerPoolEvaluator({ coordinator })

    await pool.shutdown()
    coordinators.splice(coordinators.indexOf(coordinator), 1) // already stopped - don't double-stop in afterEach

    let fallbackCalled = false
    await pool.verify(SPATIAL_TASK, async () => {
      fallbackCalled = true
      return []
    })
    expect(fallbackCalled).toBe(true)
  }, 10000)
})

describe('Distributed Solver Pipeline: a genuine drop-in for runCeilingAgent (no CeilingAgent.ts changes)', () => {
  class OneShotLlmClient implements LlmClient {
    constructor(private readonly candidate: string) {}
    async complete(): Promise<string> {
      return this.candidate
    }
  }

  test('runCeilingAgent, unmodified, verifies a real topology candidate through the distributed pipeline via bestOfN.workerPool', async () => {
    const coordinator = trackedCoordinator()
    const address = await coordinator.start()
    trackedNode({ coordinatorAddress: address })

    const pool = new DistributedWorkerPoolEvaluator({ coordinator })
    const candidate: TopologyCandidate = {
      inMemoryFiles: { 'a.ts': 'export function a(): number { return 1 }' },
      expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
      reachability: [],
    }
    const llm = new OneShotLlmClient(JSON.stringify(candidate))

    const result = await runCeilingAgent({ kind: 'topology', description: 'a module a.ts exporting a' }, llm, { bestOfN: { workerPool: pool } })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
  }, 20000)
})
