import { randomUUID } from 'node:crypto'
import { createSolverGridClient, type SolverGridClient, type TaskLeaseMessage } from './proto'
import { verify, type WorkerVerifyTask, type WorkerGateOutcome } from '../worker-pool-worker'

// Phase 14.0: a standalone solver-node process - deployable on a remote
// machine, connecting to a SolverGridCoordinator over real gRPC. Runs
// every leased task through worker-pool-worker.ts's own `verify()`, the
// SAME dispatch a local worker_thread runs - only the transport differs.
//
// Lease lifecycle: each LeaseTask call yields at most one task before the
// stream ends (see solver-grid.proto's header comment on why this is
// simpler than a persistent multiplexed stream). This node re-invokes
// LeaseTask immediately after reporting each result, so it naturally
// blocks on an open stream waiting for work rather than polling - the
// stream only resolves once the coordinator has something to offer, or is
// shutting down.

export interface SolverNodeOptions {
  coordinatorAddress: string
  nodeId?: string
  /** How often to heartbeat while actively processing a leased task, keeping its lease alive on the coordinator. Default 3000ms. */
  heartbeatIntervalMs?: number
}

export interface SolverNodeHandle {
  readonly nodeId: string
  stop(): Promise<void>
}

export function startSolverNode(options: SolverNodeOptions): SolverNodeHandle {
  const nodeId = options.nodeId ?? `node-${randomUUID().slice(0, 8)}`
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 3000
  const client = createSolverGridClient(options.coordinatorAddress)
  let stopped = false

  const loopPromise = (async () => {
    while (!stopped) {
      const lease = await leaseOneTask(client, nodeId)
      if (stopped) break
      if (!lease) continue // stream ended with no task offered this round - try again
      await processLease(client, nodeId, lease, heartbeatIntervalMs)
    }
  })()

  return {
    nodeId,
    async stop() {
      stopped = true
      client.close()
      await loopPromise.catch(() => {
        // A pending leaseOneTask/reportResult call erroring out during
        // shutdown is expected (the client just closed) - not a real
        // failure to surface to the caller of stop().
      })
    },
  }
}

function leaseOneTask(client: SolverGridClient, nodeId: string): Promise<TaskLeaseMessage | null> {
  return new Promise((resolve) => {
    const call = client.leaseTask({ nodeId })
    let received: TaskLeaseMessage | null = null
    call.on('data', (lease: TaskLeaseMessage) => {
      received = lease
    })
    call.on('end', () => resolve(received))
    call.on('error', () => resolve(null)) // a closed/cancelled client during shutdown - treat as "no task," never crash the loop
  })
}

async function processLease(client: SolverGridClient, nodeId: string, lease: TaskLeaseMessage, heartbeatIntervalMs: number): Promise<void> {
  const heartbeatTimer = setInterval(() => {
    client.heartbeat({ nodeId, leaseId: lease.leaseId }, () => {
      // Best-effort: a failed heartbeat just means the coordinator may
      // revoke this lease on its own timeout - reportResult below still
      // races to complete the real work regardless.
    })
  }, heartbeatIntervalMs)

  try {
    const task = JSON.parse(lease.taskJson) as WorkerVerifyTask
    const gates = await verify(task)
    await reportResult(client, lease.leaseId, { ok: true, gates })
  } catch (error) {
    await reportResult(client, lease.leaseId, { ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    clearInterval(heartbeatTimer)
  }
}

function reportResult(client: SolverGridClient, leaseId: string, result: { ok: true; gates: WorkerGateOutcome[] } | { ok: false; error: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const message = result.ok
      ? { leaseId, ok: true, gatesJson: JSON.stringify(result.gates), error: '' }
      : { leaseId, ok: false, gatesJson: '', error: result.error }
    client.reportResult(message, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
