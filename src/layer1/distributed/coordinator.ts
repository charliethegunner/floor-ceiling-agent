import * as grpc from '@grpc/grpc-js'
import { LeaseQueue, type LeaseQueueOptions } from './lease-queue'
import { loadSolverGridServiceDefinition, type NodeCapabilitiesMessage, type TaskLeaseMessage, type TaskResultMessage, type NodeStatusMessage, type AckMessage } from './proto'
import type { WorkerVerifyTask, WorkerGateOutcome } from '../worker-pool-worker'
import type { ExecutionMode } from '../action-floor'

// Phase 14.0: the gRPC-facing half of the Distributed Solver Pipeline - a
// thin adapter over LeaseQueue's real in-process logic. The service
// contract (solver-grid.proto) and the underlying streaming mechanism were
// verified directly (a real TCP bind, a real server-streaming push, a real
// unary round-trip) before this was written, mirroring this project's
// established discipline for every other primitive it relies on.

export interface SolverGridCoordinatorOptions extends LeaseQueueOptions {
  host?: string
  /** Default 0 - an OS-assigned ephemeral port, read back from start()'s return value. */
  port?: number
}

const DEFAULT_HOST = '127.0.0.1'

export class SolverGridCoordinator {
  readonly queue: LeaseQueue
  private readonly host: string
  private readonly requestedPort: number
  private server: grpc.Server | null = null
  private boundPort = 0

  constructor(options: SolverGridCoordinatorOptions = {}) {
    this.queue = new LeaseQueue({ leaseTimeoutMs: options.leaseTimeoutMs, maxLeaseAttempts: options.maxLeaseAttempts, noNodeTimeoutMs: options.noNodeTimeoutMs })
    this.host = options.host ?? DEFAULT_HOST
    this.requestedPort = options.port ?? 0
  }

  /** The real bound "host:port" address, valid only after start() resolves. */
  get address(): string {
    return `${this.host}:${this.boundPort}`
  }

  /** Enqueue a task for distribution - the same real path a solver node's LeaseTask call is fed from. Called directly, in-process, by DistributedWorkerPoolEvaluator; never needs its own gRPC round-trip since the coordinator and its caller share a process. */
  enqueue(task: WorkerVerifyTask, executionMode: ExecutionMode): Promise<WorkerGateOutcome[]> {
    return this.queue.enqueue(task, executionMode)
  }

  async start(): Promise<string> {
    const service = loadSolverGridServiceDefinition()
    const server = new grpc.Server()

    server.addService(service, {
      leaseTask: (call: grpc.ServerWritableStream<NodeCapabilitiesMessage, TaskLeaseMessage>) => {
        void this.handleLeaseTask(call)
      },
      reportResult: (call: grpc.ServerUnaryCall<TaskResultMessage, AckMessage>, callback: grpc.sendUnaryData<AckMessage>) => {
        const { leaseId, ok, gatesJson, error } = call.request
        const found = ok
          ? this.queue.reportResult(leaseId, { ok: true, gates: JSON.parse(gatesJson) as WorkerGateOutcome[] })
          : this.queue.reportResult(leaseId, { ok: false, error })
        callback(null, { ok: found })
      },
      heartbeat: (call: grpc.ServerUnaryCall<NodeStatusMessage, AckMessage>, callback: grpc.sendUnaryData<AckMessage>) => {
        const extended = this.queue.heartbeat(call.request.leaseId)
        callback(null, { ok: extended })
      },
    })

    this.boundPort = await new Promise<number>((resolve, reject) => {
      server.bindAsync(`${this.host}:${this.requestedPort}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
        if (err) reject(err)
        else resolve(boundPort)
      })
    })
    this.server = server
    return this.address
  }

  private async handleLeaseTask(call: grpc.ServerWritableStream<NodeCapabilitiesMessage, TaskLeaseMessage>): Promise<void> {
    let cancelled = false
    call.on('cancelled', () => {
      cancelled = true
    })

    const granted = await this.queue.requestLease()
    if (!cancelled && granted) {
      call.write({ leaseId: granted.leaseId, taskJson: JSON.stringify(granted.task), executionMode: granted.executionMode })
    }
    call.end()
  }

  /** Stops accepting new work (closes the queue - any node waiting for a lease is released, any still-unleased task is rejected) and tears down the real gRPC server. */
  async stop(): Promise<void> {
    this.queue.close()
    const server = this.server
    if (!server) return
    await new Promise<void>((resolve) => {
      server.tryShutdown(() => resolve())
    })
  }
}
