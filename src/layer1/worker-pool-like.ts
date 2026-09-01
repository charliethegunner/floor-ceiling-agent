import type { WorkerVerifyTask, WorkerGateOutcome } from './worker-pool-worker'

// Phase 14.0: the minimal structural interface both the existing local
// WorkerPoolEvaluator and the new DistributedWorkerPoolEvaluator satisfy,
// so CeilingAgent.ts (via BestOfNOptions.workerPool) and
// layer3/sampler.ts's WorkerOffload never have to know which one they're
// holding. WorkerPoolEvaluator already structurally satisfies this - no
// change to that class itself, only a widened type at its two real call
// sites (CeilingAgent.ts's BestOfNOptions, layer3/types.ts's WorkerOffload).
export interface WorkerPoolLike {
  verify(task: WorkerVerifyTask, fallback: () => Promise<WorkerGateOutcome[]>): Promise<WorkerGateOutcome[]>
  shutdown(): Promise<void>
}
