// Phase 13.2: Hard Solver Deadlines - two DIFFERENT enforcement mechanisms,
// because "abort a stalled evaluation" means something different depending
// on whether the stalled work is genuinely asynchronous or synchronous:
//
//   - withSolverDeadline: a real Promise.race against a timer. This
//     genuinely works for an async operation (e.g. z3-solver's
//     Solver#check(), which returns a Promise backed by real async WASM
//     calls) - after deadlineMs, the caller stops waiting and gets a FAIL
//     result, even if the underlying solve is still running in the
//     background. Used by instruction-floor.ts's checkSymbolicEquivalence.
//
//   - startDeadlineClock/isDeadlineExceeded: a cooperative wall-clock check
//     for synchronous, CPU-bound loops (e.g. spatial-floor.ts's grid
//     sampling). A single JS thread CANNOT preempt synchronous code mid-
//     loop - wrapping a tight synchronous loop in Promise.race would be
//     theater, since the timeout callback could never fire until the loop
//     already finished on its own. The real, honest bound for synchronous
//     work is checking Date.now() against the deadline INSIDE the loop
//     itself and breaking out early - genuinely bounds worst-case wall-
//     clock time, at the cost of only being checked between iterations
//     (not truly mid-statement), which is the correct and only real option
//     available in single-threaded JS.
//
// Both report the exact same diagnostic text on timeout, so a caller-facing
// gate failure reads identically regardless of which mechanism caught it.

export const DEFAULT_SOLVER_DEADLINE_MS = 500
export const SOLVER_DEADLINE_DIAGNOSTIC = 'Solver execution deadline exceeded'

export type SolverDeadlineOutcome<T> = { ok: true; value: T } | { ok: false; timedOut: true }

export async function withSolverDeadline<T>(operation: () => Promise<T>, deadlineMs: number = DEFAULT_SOLVER_DEADLINE_MS): Promise<SolverDeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<SolverDeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), deadlineMs)
  })

  try {
    return await Promise.race([operation().then((value): SolverDeadlineOutcome<T> => ({ ok: true, value })), timeout])
  } finally {
    clearTimeout(timer!)
  }
}

export interface DeadlineClock {
  readonly startedAt: number
  readonly deadlineMs: number
}

export function startDeadlineClock(deadlineMs: number = DEFAULT_SOLVER_DEADLINE_MS): DeadlineClock {
  return { startedAt: Date.now(), deadlineMs }
}

export function isDeadlineExceeded(clock: DeadlineClock): boolean {
  return Date.now() - clock.startedAt > clock.deadlineMs
}
