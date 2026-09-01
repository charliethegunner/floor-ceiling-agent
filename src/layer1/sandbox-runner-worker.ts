import { parentPort, workerData } from 'node:worker_threads'
import { interpretArm64Program } from './sandbox-instruction-set'

// Phase 12.1: the ACTUAL isolated execution context - a freshly spawned
// worker_thread per invocation (never pooled/reused, so no state can leak
// between separate "sandboxed" executions), constrained by real
// V8-enforced resourceLimits (set by sandbox-runner.ts at construction
// time) and killed via a real worker.terminate() on timeout. Both
// mechanisms were verified against Node's actual behavior before this was
// written - a genuine "JS heap out of memory" crash from
// maxOldGenerationSizeMb, and a genuine kill of a synchronous, never-
// yielding infinite loop via terminate() (worker.terminate() is real OS-
// level thread teardown, not a cooperative check - it can interrupt code
// that never voluntarily yields, unlike a Promise.race timeout).

interface SandboxTask {
  lines: string[]
  initialRegisters: Record<string, bigint>
  /** TEST-ONLY: synchronously busy-wait this many ms before interpreting,
   *  to deterministically exercise the real worker.terminate() timeout
   *  path without depending on timing luck or an artificially long
   *  program (this interpreter has no loops/branches, so no real program
   *  can naturally run long). */
  __testHangMs?: number
  /** TEST-ONLY: allocate this many ~1MB chunks before interpreting, to
   *  deterministically exercise the real resourceLimits OOM path with a
   *  small, fast, intentional allocation instead of a slow organic leak. */
  __testAllocateMb?: number
}

type OutgoingMessage = { ok: true; registers: Record<string, bigint>; instructionsExecuted: number } | { ok: false; error: string }

function busyWaitMs(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // Deliberately synchronous and non-yielding - this is exactly what
    // proves worker.terminate() is real preemption, not cooperative.
  }
}

function testAllocate(mb: number): void {
  const chunks: number[][] = []
  for (let i = 0; i < mb; i++) {
    chunks.push(new Array(131_072).fill(i)) // 131,072 float64 elements * 8 bytes ~= 1MB
  }
  if (chunks.length < 0) throw new Error('unreachable') // keeps `chunks` reachable so V8 can't discard the allocation
}

if (!parentPort) {
  throw new Error('sandbox-runner-worker.ts must be run as a node:worker_threads Worker, not imported directly')
}

const task = workerData as SandboxTask

try {
  if (task.__testHangMs) busyWaitMs(task.__testHangMs)
  if (task.__testAllocateMb) testAllocate(task.__testAllocateMb)

  const { registers, instructionsExecuted } = interpretArm64Program(task.lines, task.initialRegisters)
  const response: OutgoingMessage = { ok: true, registers, instructionsExecuted }
  parentPort.postMessage(response)
} catch (error) {
  const response: OutgoingMessage = { ok: false, error: error instanceof Error ? error.message : String(error) }
  parentPort.postMessage(response)
}
