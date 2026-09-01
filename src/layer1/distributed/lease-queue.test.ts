import { describe, test, expect } from 'vitest'
import { LeaseQueue } from './lease-queue'
import type { WorkerVerifyTask, WorkerGateOutcome } from '../worker-pool-worker'

const SAMPLE_TASK: WorkerVerifyTask = { domain: 'spatial', candidateText: '{}' }
const SAMPLE_GATES: WorkerGateOutcome[] = [{ gate: 'g', ok: true, details: 'd' }]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('LeaseQueue: real in-process lease lifecycle, zero gRPC involved', () => {
  test('a task granted to a requesting node, then reported ok, resolves enqueue() with the real gates', async () => {
    const queue = new LeaseQueue()
    const enqueued = queue.enqueue(SAMPLE_TASK, 'auto')
    const granted = await queue.requestLease()

    expect(granted?.task).toEqual(SAMPLE_TASK)
    expect(granted?.executionMode).toBe('auto')
    expect(queue.reportResult(granted!.leaseId, { ok: true, gates: SAMPLE_GATES })).toBe(true)
    await expect(enqueued).resolves.toEqual(SAMPLE_GATES)
  })

  test('requestLease() called before any task is enqueued genuinely waits, then resolves once one arrives', async () => {
    const queue = new LeaseQueue()
    const leasePromise = queue.requestLease()
    await sleep(15) // proves it hasn't already resolved
    expect(queue.waitingNodeCount).toBe(1)

    queue.enqueue(SAMPLE_TASK, 'interactive')
    const granted = await leasePromise
    expect(granted?.executionMode).toBe('interactive')
    expect(queue.waitingNodeCount).toBe(0)
  })

  test('a lease that times out with no heartbeat/report is revoked and requeued', async () => {
    const queue = new LeaseQueue({ leaseTimeoutMs: 40, maxLeaseAttempts: 3 })
    queue.enqueue(SAMPLE_TASK, 'auto')
    await queue.requestLease() // never report or heartbeat - let it expire

    await sleep(80)
    expect(queue.activeLeaseCount).toBe(0)
    expect(queue.pendingTaskCount).toBe(1) // requeued, waiting for the next requester
  })

  test('heartbeat keeps a lease alive past its original timeout', async () => {
    const queue = new LeaseQueue({ leaseTimeoutMs: 60 })
    const enqueued = queue.enqueue(SAMPLE_TASK, 'auto')
    const granted = await queue.requestLease()

    const heartbeatTimer = setInterval(() => queue.heartbeat(granted!.leaseId), 20)
    await sleep(140) // longer than leaseTimeoutMs alone would survive
    clearInterval(heartbeatTimer)

    expect(queue.activeLeaseCount).toBe(1) // still alive thanks to real heartbeats
    queue.reportResult(granted!.leaseId, { ok: true, gates: SAMPLE_GATES })
    await expect(enqueued).resolves.toEqual(SAMPLE_GATES)
  })

  test('after maxLeaseAttempts is exhausted by repeated timeouts, enqueue() rejects so the caller can fall back', async () => {
    const queue = new LeaseQueue({ leaseTimeoutMs: 25, maxLeaseAttempts: 2 })
    const enqueued = queue.enqueue(SAMPLE_TASK, 'auto')

    await queue.requestLease() // attempt 1, let it expire
    await sleep(50)
    await queue.requestLease() // attempt 2, let it expire too

    await expect(enqueued).rejects.toThrow(/exhausted 2 lease attempt/)
  })

  test('a reported failure (not a timeout) also requeues, and rejects with the real last failure reason after max attempts', async () => {
    const queue = new LeaseQueue({ maxLeaseAttempts: 2 })
    const enqueued = queue.enqueue(SAMPLE_TASK, 'auto')

    const first = await queue.requestLease()
    queue.reportResult(first!.leaseId, { ok: false, error: 'worker crashed' })
    const second = await queue.requestLease()
    queue.reportResult(second!.leaseId, { ok: false, error: 'worker crashed again' })

    await expect(enqueued).rejects.toThrow(/worker crashed again/)
  })

  test('a task no node ever claims rejects after noNodeTimeoutMs - not indefinitely (a real bug this exact test caught during implementation)', async () => {
    const queue = new LeaseQueue({ noNodeTimeoutMs: 40 })
    const start = Date.now()
    await expect(queue.enqueue(SAMPLE_TASK, 'auto')).rejects.toThrow(/timed out after 40ms waiting for an available solver node/)
    expect(Date.now() - start).toBeLessThan(500)
  })

  test('reportResult/heartbeat on an unknown leaseId return false rather than throwing', () => {
    const queue = new LeaseQueue()
    expect(queue.reportResult('nonexistent', { ok: true, gates: [] })).toBe(false)
    expect(queue.heartbeat('nonexistent')).toBe(false)
  })

  test('two tasks and two waiting nodes pair up correctly (real dispatch, not a coincidence of ordering)', async () => {
    const queue = new LeaseQueue()
    const taskA: WorkerVerifyTask = { domain: 'spatial', candidateText: 'A' }
    const taskB: WorkerVerifyTask = { domain: 'spatial', candidateText: 'B' }

    const nodeCall1 = queue.requestLease()
    const nodeCall2 = queue.requestLease()
    expect(queue.waitingNodeCount).toBe(2)

    queue.enqueue(taskA, 'auto')
    queue.enqueue(taskB, 'auto')

    const [lease1, lease2] = await Promise.all([nodeCall1, nodeCall2])
    const leasedCandidates = [lease1?.task.candidateText, lease2?.task.candidateText].sort()
    expect(leasedCandidates).toEqual(['A', 'B'])
  })

  test('close() releases a node blocked in requestLease() with null', async () => {
    const queue = new LeaseQueue()
    const waitingNode = queue.requestLease()
    queue.close()
    await expect(waitingNode).resolves.toBeNull()
  })

  test('close() rejects a task that was still waiting for a node', async () => {
    const queue = new LeaseQueue()
    const enqueued = queue.enqueue(SAMPLE_TASK, 'auto')
    queue.close()
    await expect(enqueued).rejects.toThrow(/lease queue closed/)
  })

  test('enqueue() after close() rejects immediately', async () => {
    const queue = new LeaseQueue()
    queue.close()
    await expect(queue.enqueue(SAMPLE_TASK, 'auto')).rejects.toThrow(/lease queue closed/)
  })
})
