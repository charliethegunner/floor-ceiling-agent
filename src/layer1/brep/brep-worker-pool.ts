import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkerGateOutcome } from '../worker-pool-worker'
import type { BRepCandidate } from './brep-floor'
import { registerForGracefulShutdown } from '../process-lifecycle'

// Phase 15.0: dedicated worker-thread isolation for B-Rep verification,
// following the SAME pool pattern WorkerPoolEvaluator (Phase 9/13.3)
// already proved out - spawn/message/error/exit handling, task timeout
// with fallback, RSS-based proactive recycling - reimplemented here as an
// independent class rather than widening WorkerPoolEvaluator/WorkerDomain
// to cover 'brep': that type is the existing, load-bearing contract
// CeilingAgent.ts and layer3/sampler.ts route the 4 existing domains
// through, and 'brep' is not one of them (no CeilingRequestKind exists for
// it yet) - forcing it into that union would either break
// worker-pool-worker.ts's exhaustive domain switch or require it to
// silently ignore a domain it doesn't handle. This mirrors the
// WorkerPoolLike shape (verify/shutdown) as a design pattern, not the
// literal exported type, since there is no existing 'brep' routing surface
// for it to be a structural drop-in for.
//
// poolSize defaults to 1, not os.cpus().length - 1 like the general pool:
// spike-measured, each worker's OpenCASCADE instance alone costs
// ~450-500MB RSS at rest, before any verification work - the general
// pool's concurrency-favoring default would be a real, severe regression
// here, not a free speedup.

export interface BRepWorkerPoolOptions {
  poolSize?: number
  taskTimeoutMs?: number
  /** Spike-measured: RSS settles at ~470-500MB immediately after a worker's
   *  OpenCASCADE kernel loads, and stayed flat there across 200 real
   *  build+check cycles. 900MB gives real headroom above that measured
   *  steady state while still catching genuine unbounded growth - the same
   *  reasoning worker-pool.ts's own DEFAULT_MAX_WORKER_RSS_BYTES comment
   *  used for its (much lower) domains. */
  maxWorkerRssBytes?: number
}

const DEFAULT_TASK_TIMEOUT_MS = 30_000
const DEFAULT_MAX_WORKER_RSS_BYTES = 900 * 1024 * 1024

const dirname = path.dirname(fileURLToPath(import.meta.url))
const BREP_WORKER_SCRIPT_PATH = path.join(dirname, 'brep-worker.ts')

export interface BRepWorkerVerifyTask {
  domain: 'brep'
  candidate: BRepCandidate
  /** TEST-ONLY: exit the worker process immediately, simulating a real crash. */
  __testCrash?: boolean
  /** TEST-ONLY: sleep this many ms inside the worker before verifying, so a timeout can be triggered deterministically. */
  __testDelayMs?: number
  /** TEST-ONLY: report this RSS value instead of the real reading, so recycling can be tested deterministically. */
  __testFakeRssBytes?: number
}

interface PendingTask {
  resolve: (gates: WorkerGateOutcome[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerSlot {
  worker: Worker
  pending: Map<number, PendingTask>
  alive: boolean
}

type WorkerResponse = { taskId: number; ok: true; gates: WorkerGateOutcome[]; rssBytes: number } | { taskId: number; ok: false; error: string; rssBytes: number }

let nextTaskId = 0

export class BRepWorkerPoolEvaluator {
  private readonly slots: WorkerSlot[]
  private readonly taskTimeoutMs: number
  private readonly maxWorkerRssBytes: number
  private nextSlotIndex = 0
  private closed = false
  private recycledWorkers = 0
  private readonly unregisterFromGracefulShutdown: () => void

  constructor(options: BRepWorkerPoolOptions = {}) {
    const poolSize = Math.max(1, options.poolSize ?? 1)
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
    this.maxWorkerRssBytes = options.maxWorkerRssBytes ?? DEFAULT_MAX_WORKER_RSS_BYTES
    this.slots = Array.from({ length: poolSize }, () => this.spawnSlot())
    // Phase 16.1: same real safety net as WorkerPoolEvaluator's - each
    // worker here also carries a real ~450-500MB OpenCASCADE instance, so
    // an interrupted run leaving one alive is a genuinely worse leak than
    // the general pool's lighter workers.
    this.unregisterFromGracefulShutdown = registerForGracefulShutdown({ terminate: () => this.shutdown() })
  }

  get recycledWorkerCount(): number {
    return this.recycledWorkers
  }

  get poolSize(): number {
    return this.slots.length
  }

  private spawnSlot(): WorkerSlot {
    const worker = new Worker(BREP_WORKER_SCRIPT_PATH, { execArgv: ['--import', 'tsx'] })
    const slot: WorkerSlot = { worker, pending: new Map(), alive: true }

    worker.on('message', (message: WorkerResponse) => {
      const pending = slot.pending.get(message.taskId)
      if (pending) {
        slot.pending.delete(message.taskId)
        clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.gates)
        else pending.reject(new Error(message.error))
      }

      if (slot.alive && message.rssBytes > this.maxWorkerRssBytes) {
        this.recycleSlot(slot, `RSS ${message.rssBytes} byte(s) exceeded the ${this.maxWorkerRssBytes} byte threshold after task ${message.taskId}`)
      }
    })

    worker.on('error', (error: Error) => {
      this.handleSlotDeath(slot, error)
    })

    worker.on('exit', (code) => {
      if (code !== 0 && slot.alive) {
        this.handleSlotDeath(slot, new Error(`worker exited with code ${code}`))
      }
    })

    return slot
  }

  private handleSlotDeath(slot: WorkerSlot, error: Error): void {
    if (!slot.alive) return
    slot.alive = false
    for (const pending of slot.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    slot.pending.clear()

    if (this.closed) return
    const index = this.slots.indexOf(slot)
    if (index !== -1) this.slots[index] = this.spawnSlot()
  }

  private recycleSlot(slot: WorkerSlot, reason: string): void {
    if (!slot.alive) return
    this.failAllPending(slot, new Error(`worker recycled: ${reason}`))
    void slot.worker.terminate()
    this.recycledWorkers++

    if (this.closed) return
    const index = this.slots.indexOf(slot)
    if (index !== -1) this.slots[index] = this.spawnSlot()
  }

  /** Same fail-open-on-infrastructure-problems contract as WorkerPoolEvaluator.verify:
   *  a dead pool, a dead worker, a thrown task, or a timeout all fall back
   *  to `fallback` rather than rejecting - a pool problem degrades to "no
   *  isolation for this candidate," never "this candidate silently fails
   *  to verify." */
  async verify(task: BRepWorkerVerifyTask, fallback: () => Promise<WorkerGateOutcome[]>): Promise<WorkerGateOutcome[]> {
    if (this.closed) return fallback()

    const slot = this.slots[this.nextSlotIndex]
    this.nextSlotIndex = (this.nextSlotIndex + 1) % this.slots.length

    if (!slot.alive) return fallback()

    const taskId = nextTaskId++
    try {
      return await new Promise<WorkerGateOutcome[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          slot.pending.delete(taskId)
          reject(new Error(`worker task timed out after ${this.taskTimeoutMs}ms`))
        }, this.taskTimeoutMs)
        slot.pending.set(taskId, { resolve, reject, timer })
        slot.worker.postMessage({
          taskId,
          domain: task.domain,
          candidateText: JSON.stringify(task.candidate),
          __testCrash: task.__testCrash,
          __testDelayMs: task.__testDelayMs,
          __testFakeRssBytes: task.__testFakeRssBytes,
        })
      })
    } catch {
      return fallback()
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unregisterFromGracefulShutdown()
    await Promise.all(
      this.slots.map(async (slot) => {
        this.failAllPending(slot, new Error('worker pool shut down'))
        await slot.worker.terminate()
      })
    )
  }

  private failAllPending(slot: WorkerSlot, error: Error): void {
    slot.alive = false
    for (const pending of slot.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    slot.pending.clear()
  }
}
