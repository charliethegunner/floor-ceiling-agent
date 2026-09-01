import type { WorkerPoolLike } from '../worker-pool-like'
import type { WorkerVerifyTask, WorkerGateOutcome } from '../worker-pool-worker'
import type { ExecutionMode } from '../action-floor'
import type { SolverGridCoordinator } from './coordinator'

// Phase 14.0: a drop-in alternative to the local WorkerPoolEvaluator -
// structurally satisfies WorkerPoolLike, so CeilingAgent.ts's
// BestOfNOptions.workerPool and layer3/sampler.ts's WorkerOffload never
// need to know which one they're holding. Zero changes to either.
//
// executionMode (Phase 13.4.4/14.0) is threaded into every enqueued task's
// TaskLease.executionMode, so it genuinely crosses the gRPC wire with the
// task - a solver node (and any telemetry it emits) can observe the real
// autonomy mode that governed this specific dispatch, not just infer it
// from the coordinator's local state.

export interface DistributedWorkerPoolOptions {
  /** This evaluator's coordinator. Owned for this evaluator's lifetime - shutdown() stops it. */
  coordinator: SolverGridCoordinator
  /** Bound into every task this evaluator enqueues. Default 'auto'. */
  executionMode?: ExecutionMode
}

export class DistributedWorkerPoolEvaluator implements WorkerPoolLike {
  constructor(private readonly options: DistributedWorkerPoolOptions) {}

  get executionMode(): ExecutionMode {
    return this.options.executionMode ?? 'auto'
  }

  /**
   * Degradation is a design requirement, not an afterthought (see the
   * v2.0 blueprint): when no solver node ever completes this task within
   * LeaseQueue's maxLeaseAttempts, or the coordinator's queue is closed,
   * enqueue() rejects and this falls back - the exact contract the local
   * WorkerPoolEvaluator already honors on a dead worker or a timeout. A
   * distributed outage costs throughput, never correctness.
   */
  async verify(task: WorkerVerifyTask, fallback: () => Promise<WorkerGateOutcome[]>): Promise<WorkerGateOutcome[]> {
    try {
      return await this.options.coordinator.enqueue(task, this.executionMode)
    } catch {
      return fallback()
    }
  }

  async shutdown(): Promise<void> {
    await this.options.coordinator.stop()
  }
}
