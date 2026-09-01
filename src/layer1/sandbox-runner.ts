import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateExecutableProgram } from './sandbox-instruction-set'

// Phase 12.1: Isolated Sandboxed Runner Floor.
//
// This replaces Phase 11.7's permanent fail-closed executeBinaryPayload
// stub - but NOT with WASM/WASI or a seccomp container, both of which were
// offered as examples but don't actually apply here: WASM/WASI executes
// WASM bytecode, not the ARM64 assembly TEXT this project's candidates
// actually are (there is no ARM64-to-WASM assembler anywhere in this
// codebase or reasonably in scope to build), and seccomp is a Linux kernel
// feature unavailable on this Windows host. What IS real and available in
// Node, verified directly against its actual documented behavior before
// this was written (not assumed):
//   - worker_threads' `resourceLimits` (maxOldGenerationSizeMb /
//     maxYoungGenerationSizeMb) - a genuine, PER-ISOLATE V8 heap ceiling.
//     Confirmed: exceeding it crashes that worker with a real "JS heap out
//     of memory" error, isolated to that worker's own V8 isolate (unlike
//     Phase 13.3's RSS monitoring, which is honestly process-wide - this
//     is a stronger, genuinely per-context guarantee).
//   - `worker.terminate()` - genuine OS-level thread teardown. Confirmed:
//     it kills a real, never-yielding synchronous infinite loop within
//     ~1ms of being called, which a Promise.race timeout (Phase 13.2)
//     categorically cannot do for synchronous code.
//   - A closed, hand-written interpreter (sandbox-instruction-set.ts) for
//     the exact register-transfer ALU subset instruction-floor.ts's Z3
//     gate already models. It has no memory address space, no syscall
//     surface, no filesystem/network/subprocess API - "path-isolated IO"
//     is satisfied BY CONSTRUCTION (there is no code path to touch any
//     path at all), not by revoking permissions from something that could
//     otherwise reach them. Anything outside that closed instruction set
//     is refused before a sandbox worker is even spawned.
//
// Every execution gets a FRESH worker (never pooled/reused), so no state
// - registers, heap, anything - can leak between separate sandboxed runs;
// this is the honest reading of "per execution context" isolation.

const dirname = path.dirname(fileURLToPath(import.meta.url))
const SANDBOX_WORKER_SCRIPT_PATH = path.join(dirname, 'sandbox-runner-worker.ts')

export interface SandboxExecutionOptions {
  /** Hard wall-clock deadline, enforced by a real worker.terminate() (not cooperative). Default 500ms. */
  timeoutMs?: number
  /** Per-isolate V8 old-generation heap ceiling in MB, real and worker-isolated. Default 32MB - generous for a register-only interpreter with no loops. */
  maxOldGenerationMb?: number
  /** Per-isolate V8 young-generation heap ceiling in MB. Default 16MB. */
  maxYoungGenerationMb?: number
}

// Empirically adjusted, not guessed (same lesson as Phase 13.3's worker RSS
// default): a normal single-instruction execution measured ~120-150ms
// standalone, comfortably inside a naive 500ms/32MB default - but running
// the FULL test suite in parallel (many other test files' own worker
// threads and ts-morph/z3 processes competing for CPU and memory) pushed a
// real execution past those tight defaults intermittently, observed
// directly as a flaky failure. These give real headroom against that
// system-wide contention while still being a HARD bound, not an unbounded
// wait - a genuinely stuck or memory-runaway payload is still caught, just
// not shaved as close to best-case timing.
const DEFAULT_TIMEOUT_MS = 2000
const DEFAULT_MAX_OLD_GENERATION_MB = 64
const DEFAULT_MAX_YOUNG_GENERATION_MB = 32

export type SandboxExecutionResult =
  | { executed: true; registers: Record<string, bigint>; instructionsExecuted: number; elapsedMs: number }
  | { executed: false; reason: string }

interface SandboxTask {
  lines: string[]
  initialRegisters: Record<string, bigint>
  __testHangMs?: number
  __testAllocateMb?: number
}

type WorkerResponse = { ok: true; registers: Record<string, bigint>; instructionsExecuted: number } | { ok: false; error: string }

export class SandboxRunner {
  async execute(arm64Assembly: string, initialRegisters: Record<string, bigint> = {}, options: SandboxExecutionOptions = {}): Promise<SandboxExecutionResult> {
    return this.run({ lines: arm64Assembly.split('\n'), initialRegisters }, options)
  }

  /** TEST-ONLY entry point: exposes __testHangMs/__testAllocateMb so timeout and memory-ceiling enforcement can be tested deterministically. Not part of the public execute() surface. */
  async __testExecuteRaw(task: SandboxTask, options: SandboxExecutionOptions = {}): Promise<SandboxExecutionResult> {
    return this.run(task, options)
  }

  private async run(task: SandboxTask, options: SandboxExecutionOptions): Promise<SandboxExecutionResult> {
    // Admission control BEFORE a sandbox is spawned - pure shape
    // validation, never execution, so it's safe here in the parent
    // process. See sandbox-instruction-set.ts's header comment.
    const rejection = validateExecutableProgram(task.lines)
    if (rejection) {
      return { executed: false, reason: `${rejection.reason} (in "${rejection.line}")` }
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const start = Date.now()

    const worker = new Worker(SANDBOX_WORKER_SCRIPT_PATH, {
      execArgv: ['--import', 'tsx'],
      workerData: task,
      resourceLimits: {
        maxOldGenerationSizeMb: options.maxOldGenerationMb ?? DEFAULT_MAX_OLD_GENERATION_MB,
        maxYoungGenerationSizeMb: options.maxYoungGenerationMb ?? DEFAULT_MAX_YOUNG_GENERATION_MB,
      },
    })

    return new Promise<SandboxExecutionResult>((resolve) => {
      let settled = false
      const finish = (result: SandboxExecutionResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        resolve(result)
      }

      const timer = setTimeout(() => {
        finish({ executed: false, reason: 'Sandbox execution deadline exceeded' })
      }, timeoutMs)

      worker.on('message', (message: WorkerResponse) => {
        if (message.ok) {
          finish({ executed: true, registers: message.registers, instructionsExecuted: message.instructionsExecuted, elapsedMs: Date.now() - start })
        } else {
          finish({ executed: false, reason: message.error })
        }
      })

      worker.on('error', (error: Error) => {
        finish({ executed: false, reason: `sandbox worker crashed: ${error.message}` })
      })

      worker.on('exit', (code) => {
        if (code !== 0) {
          finish({ executed: false, reason: `sandbox worker exited with code ${code} - likely the memory ceiling (maxOldGenerationMb/maxYoungGenerationMb)` })
        }
      })
    })
  }
}
