import type { WorkerVerifyTask, WorkerGateOutcome } from '../worker-pool-worker'
import type { ExecutionMode } from '../action-floor'

// Phase 14.0: the coordinator's in-memory, lease-based task queue - no
// external broker (no Redis). A solver node "leases" a task by calling
// requestLease(); the lease is active until reportResult() reports it, a
// heartbeat() keeps extending it, or leaseTimeoutMs passes with no
// heartbeat, at which point it's revoked and the task is requeued for
// another node (or given up on, after maxLeaseAttempts, so the caller can
// fall back). This is genuinely in-process logic, independently
// unit-testable with zero gRPC involved - see lease-queue.test.ts. The
// gRPC service (coordinator.ts) is a thin adapter over this.
//
// Honest limitation, stated here and in the v2.0 blueprint: this state is
// in-memory only. A coordinator process restart loses in-flight lease
// bookkeeping - in-flight enqueue() callers get a real rejection (never a
// silent hang), but there is no durable backing store. A future addition
// could add one without changing this class's public shape.

export interface LeaseQueueOptions {
  /** How long a granted lease survives without a matching heartbeat/report before being revoked and requeued. Default 10000ms. */
  leaseTimeoutMs?: number
  /** How many times a task may be (re-)leased before the queue gives up and rejects it, letting the caller fall back. Default 2. */
  maxLeaseAttempts?: number
  /** How long a task may sit waiting with NO node available at all before giving up (rejecting so the caller can fall back), separate from leaseTimeoutMs - a task that's never even been granted a lease has nothing to time out on otherwise. Default 10000ms. Found via a real end-to-end smoke test that hung indefinitely before this existed - not a hypothetical edge case. */
  noNodeTimeoutMs?: number
}

const DEFAULT_LEASE_TIMEOUT_MS = 10_000
const DEFAULT_MAX_LEASE_ATTEMPTS = 2
const DEFAULT_NO_NODE_TIMEOUT_MS = 10_000

export interface GrantedLease {
  leaseId: string
  task: WorkerVerifyTask
  executionMode: ExecutionMode
}

interface QueuedTask {
  taskId: string
  task: WorkerVerifyTask
  executionMode: ExecutionMode
  attempts: number
  resolve: (gates: WorkerGateOutcome[]) => void
  reject: (error: Error) => void
  /** Set while genuinely waiting in `waitingTasks` (no node has claimed it yet); cleared the instant it's granted. */
  waitingTimer?: ReturnType<typeof setTimeout>
}

interface ActiveLease {
  leaseId: string
  queued: QueuedTask
  timer: ReturnType<typeof setTimeout>
}

let nextTaskId = 0
let nextLeaseId = 0

export class LeaseQueue {
  private readonly leaseTimeoutMs: number
  private readonly maxLeaseAttempts: number
  private readonly noNodeTimeoutMs: number
  private readonly waitingTasks: QueuedTask[] = []
  private readonly waitingNodes: Array<(lease: GrantedLease | null) => void> = []
  private readonly activeLeases = new Map<string, ActiveLease>()
  private closed = false

  constructor(options: LeaseQueueOptions = {}) {
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS
    this.maxLeaseAttempts = options.maxLeaseAttempts ?? DEFAULT_MAX_LEASE_ATTEMPTS
    this.noNodeTimeoutMs = options.noNodeTimeoutMs ?? DEFAULT_NO_NODE_TIMEOUT_MS
  }

  /** Tasks enqueued but not yet leased to any node. */
  get pendingTaskCount(): number {
    return this.waitingTasks.length
  }

  /** Leases currently outstanding (granted, not yet reported or revoked). */
  get activeLeaseCount(): number {
    return this.activeLeases.size
  }

  /** Solver nodes currently blocked in requestLease() waiting for work. */
  get waitingNodeCount(): number {
    return this.waitingNodes.length
  }

  enqueue(task: WorkerVerifyTask, executionMode: ExecutionMode): Promise<WorkerGateOutcome[]> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('lease queue closed'))
        return
      }
      const queued: QueuedTask = { taskId: `task-${nextTaskId++}`, task, executionMode, attempts: 0, resolve, reject }
      this.dispatchOrQueue(queued)
    })
  }

  /** Called when a solver node has capacity. Resolves once a lease is available, or with null if the queue closes first (the caller should end its stream). */
  requestLease(): Promise<GrantedLease | null> {
    if (this.closed) return Promise.resolve(null)
    const next = this.waitingTasks.shift()
    if (next) return Promise.resolve(this.grant(next))
    return new Promise((resolve) => {
      this.waitingNodes.push(resolve)
    })
  }

  /** Extends an active lease's timeout. Returns false if leaseId isn't currently active (already reported, revoked, or never granted). */
  heartbeat(leaseId: string): boolean {
    const active = this.activeLeases.get(leaseId)
    if (!active) return false
    clearTimeout(active.timer)
    active.timer = setTimeout(() => this.revoke(leaseId, 'lease timeout'), this.leaseTimeoutMs)
    return true
  }

  /** Reports a lease's outcome. Returns false if leaseId isn't currently active. */
  reportResult(leaseId: string, result: { ok: true; gates: WorkerGateOutcome[] } | { ok: false; error: string }): boolean {
    const active = this.activeLeases.get(leaseId)
    if (!active) return false
    clearTimeout(active.timer)
    this.activeLeases.delete(leaseId)

    if (result.ok) {
      active.queued.resolve(result.gates)
    } else {
      this.requeueOrGiveUp(active.queued, result.error)
    }
    return true
  }

  /** Shuts the queue down: releases any node waiting for a lease (with null), clears active-lease timers, and rejects any still-unleased task. */
  close(): void {
    this.closed = true
    for (const active of this.activeLeases.values()) clearTimeout(active.timer)
    this.activeLeases.clear()

    const pullers = this.waitingNodes.splice(0)
    for (const puller of pullers) puller(null)

    const stillWaiting = this.waitingTasks.splice(0)
    for (const queued of stillWaiting) {
      if (queued.waitingTimer) clearTimeout(queued.waitingTimer)
      queued.reject(new Error('lease queue closed'))
    }
  }

  private dispatchOrQueue(queued: QueuedTask): void {
    const puller = this.waitingNodes.shift()
    if (puller) {
      puller(this.grant(queued))
      return
    }
    queued.waitingTimer = setTimeout(() => this.giveUpWaiting(queued), this.noNodeTimeoutMs)
    this.waitingTasks.push(queued)
  }

  private giveUpWaiting(queued: QueuedTask): void {
    const index = this.waitingTasks.indexOf(queued)
    if (index === -1) return // already granted (or otherwise removed) between the timer firing and now
    this.waitingTasks.splice(index, 1)
    queued.reject(new Error(`distributed task timed out after ${this.noNodeTimeoutMs}ms waiting for an available solver node`))
  }

  private grant(queued: QueuedTask): GrantedLease {
    if (queued.waitingTimer) {
      clearTimeout(queued.waitingTimer)
      queued.waitingTimer = undefined
    }
    queued.attempts++
    const leaseId = `lease-${nextLeaseId++}`
    const timer = setTimeout(() => this.revoke(leaseId, 'lease timeout'), this.leaseTimeoutMs)
    this.activeLeases.set(leaseId, { leaseId, queued, timer })
    return { leaseId, task: queued.task, executionMode: queued.executionMode }
  }

  private revoke(leaseId: string, reason: string): void {
    const active = this.activeLeases.get(leaseId)
    if (!active) return
    this.activeLeases.delete(leaseId)
    this.requeueOrGiveUp(active.queued, reason)
  }

  private requeueOrGiveUp(queued: QueuedTask, reason: string): void {
    if (this.closed) {
      queued.reject(new Error(`lease queue closed (last failure: ${reason})`))
      return
    }
    if (queued.attempts >= this.maxLeaseAttempts) {
      queued.reject(new Error(`distributed task exhausted ${this.maxLeaseAttempts} lease attempt(s), last failure: ${reason}`))
      return
    }
    this.dispatchOrQueue(queued)
  }
}
