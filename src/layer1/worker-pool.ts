import { Worker } from 'node:worker_threads'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkerDomain, WorkerVerifyTask, WorkerGateOutcome } from './worker-pool-worker'

export type { WorkerDomain, WorkerVerifyTask, WorkerGateOutcome }

// Phase 12.0: re-exported so a WorkerPoolEvaluator caller can ingest a real
// project pack (directory/ZIP/CAD/PDF) and turn it into the
// WorkerVerifyTask.workspaceFiles a 'topology' task consumes (see
// worker-pool-worker.ts's 'topology' case), without a separate import - the
// verification path this enables is "a candidate checked against a real
// multi-file repository graph," not just its own isolated proposed files.
export { ProjectPackIngestor, toWorkspaceFiles, type ProjectWorkspaceGraph } from './ingestion-floor'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_SCRIPT_PATH = path.join(dirname, 'worker-pool-worker.ts')

export interface WorkerPoolOptions {
  poolSize?: number
  taskTimeoutMs?: number
  /** Phase 13.3: a worker reporting process.memoryUsage.rss() above this after a task is proactively terminated and respawned. Default 512MB - see DEFAULT_MAX_WORKER_RSS_BYTES's comment for why, and the class header comment below for the real-vs-per-worker caveat. */
  maxWorkerRssBytes?: number
}

const DEFAULT_TASK_TIMEOUT_MS = 30_000

// Empirically measured (standalone script, one worker, no vitest overhead),
// not guessed: this pool's worker-pool-worker.ts eagerly imports EVERY
// domain floor (Z3 via FloorEngine, ts-morph for topology/claim) regardless
// of which task arrives first, so cold RSS already reaches ~258MB before
// any real work happens; 10 mixed instruction/topology tasks on one worker
// climbed to ~475MB (ts-morph Project creation per topology task is
// genuinely heap-heavy and isn't immediately GC'd). A 256MB default (this
// feature's originally-requested example threshold) would recycle nearly
// every worker on its very first task, defeating the feature entirely -
// 512MB gives real headroom above the measured healthy-operation range
// while still catching genuinely unbounded growth well before a Node OOM.
const DEFAULT_MAX_WORKER_RSS_BYTES = 512 * 1024 * 1024

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

// A pool of Node worker_threads offloading Layer 1 verification (ts-morph
// Project creation, Z3 solving, dense SDF grid sampling) off the main
// thread, so evaluating N Best-of-N candidates in parallel can use real OS
// threads instead of competing for one JS event loop (the exact CPU
// bottleneck scripts/benchmark-sampler.ts exposed on the ts-morph-heavy
// topology/claim domains: Best-of-N's wall-clock got WORSE than
// single-shot there, since 4x the synchronous verification work per round
// didn't actually parallelize on Node's single thread).
//
// Each worker is spawned with execArgv: ['--import', 'tsx'] so it can load
// this project's .ts worker script directly - this repo has no build step
// (only tsx/vitest), so a precompiled .js worker isn't an option, and tsx
// (already a devDependency, used for every script entrypoint in this
// project) supports exactly this via its documented `node --import tsx`
// loader mode. Spike-verified (standalone AND from inside vitest) before
// this was built: a tsx-loaded worker can import project modules and
// initialize z3-solver's WASM module successfully.
//
// Z3 caveat (a REAL, previously-encountered problem in this codebase - see
// FloorEngine.ts's getZ3() comment): each worker thread is its own V8
// isolate with its own module registry, so a worker handling an
// 'instruction' task initializes its OWN z3-solver WASM instance, memoized
// per-worker (mirroring getZ3()'s existing per-process memoization) - NOT
// shared across the pool. A large pool size handling many instruction tasks
// can mean several independent WASM instances alive at once; poolSize is
// configurable specifically so a caller can cap this if memory becomes a
// concern, rather than always taking the os.cpus().length - 1 default.
//
// Any single task failure (worker crash, timeout, uncaught exception) is
// isolated to that task: the affected worker slot is torn down and
// respawned, and the ORIGINAL caller falls back to the `fallback` it
// supplies (typically the existing in-process runVerificationFloor call) -
// a bad worker must never fail a candidate that would otherwise pass, only
// make it slower.
//
// Phase 13.3 caveat (read before trusting maxWorkerRssBytes as a per-worker
// isolation guarantee - it ISN'T one): worker_threads are real OS THREADS
// sharing one process's address space, not separate OS processes like
// child_process.fork. process.memoryUsage.rss() therefore reports the
// WHOLE process's resident set - main thread plus every worker in this
// pool - not any one worker's exclusive share. Recycling still does
// something real: it discards the reporting worker's own V8 isolate
// (whatever module-level state/heap growth THAT worker had accumulated -
// e.g. large ts-morph Projects from big ingested packs), which reduces the
// process's total footprint even though the RSS reading that triggered it
// can't be attributed to one worker in isolation. This is disclosed rather
// than presented as true per-thread memory isolation, which Node's
// worker_threads model doesn't actually provide.
export class WorkerPoolEvaluator {
  private readonly slots: WorkerSlot[]
  private readonly taskTimeoutMs: number
  private readonly maxWorkerRssBytes: number
  private nextSlotIndex = 0
  private closed = false
  private recycledWorkers = 0

  constructor(options: WorkerPoolOptions = {}) {
    const poolSize = Math.max(1, options.poolSize ?? os.cpus().length - 1)
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
    this.maxWorkerRssBytes = options.maxWorkerRssBytes ?? DEFAULT_MAX_WORKER_RSS_BYTES
    this.slots = Array.from({ length: poolSize }, () => this.spawnSlot())
  }

  /** Total workers proactively recycled for exceeding maxWorkerRssBytes, over this pool's lifetime. */
  get recycledWorkerCount(): number {
    return this.recycledWorkers
  }

  get poolSize(): number {
    return this.slots.length
  }

  private spawnSlot(): WorkerSlot {
    const worker = new Worker(WORKER_SCRIPT_PATH, { execArgv: ['--import', 'tsx'] })
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

  /** Phase 13.3: a VOLUNTARY, healthy termination + respawn (unlike
   *  handleSlotDeath, which reacts to an actual crash/error) - triggered
   *  when a worker's reported RSS crosses maxWorkerRssBytes. Any OTHER
   *  task still in flight on this slot is failed and falls back, same as
   *  a real crash would - terminate() would strand it anyway. */
  private recycleSlot(slot: WorkerSlot, reason: string): void {
    if (!slot.alive) return
    this.failAllPending(slot, new Error(`worker recycled: ${reason}`))
    void slot.worker.terminate()
    this.recycledWorkers++

    if (this.closed) return
    const index = this.slots.indexOf(slot)
    if (index !== -1) this.slots[index] = this.spawnSlot()
  }

  /**
   * Runs a verification task on the pool. If the pool is shut down, the
   * assigned worker has died, the task throws, or it exceeds
   * taskTimeoutMs, falls back to `fallback` (typically the caller's
   * existing in-process verification path) instead of rejecting - a
   * worker-pool problem degrades to "no speedup for this candidate," never
   * "this candidate silently fails to verify."
   */
  async verify(task: WorkerVerifyTask, fallback: () => Promise<WorkerGateOutcome[]>): Promise<WorkerGateOutcome[]> {
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
        slot.worker.postMessage({ taskId, ...task })
      })
    } catch {
      return fallback()
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
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
