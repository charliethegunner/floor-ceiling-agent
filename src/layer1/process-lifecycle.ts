// A shared, ONE-TIME-REGISTERED SIGINT/SIGTERM safety net for every
// worker-thread pool in this codebase (WorkerPoolEvaluator,
// BRepWorkerPoolEvaluator) - real OS threads that keep Node's event loop
// alive until explicitly terminated, so an interrupted run (Ctrl+C mid
// test suite, or a killed CLI process) can otherwise leave them running
// and competing for CPU/RAM after the run that owned them is gone.
//
// A naive `process.on('SIGINT', ...)` registered in every pool's own
// constructor hits two real problems once more than a handful of pools
// exist in one process (this suite creates several per test file):
// Node's default max-listener warning, and a race between N independent
// handlers each trying to be the one that calls process.exit() first.
// Registering exactly ONE process-level listener that fans out to every
// currently-live pool avoids both - shutdown() unregisters a pool the
// same way it already tears down its own workers, so a long test run
// never accumulates dead references either.

export interface Terminable {
  terminate(): Promise<void>
}

const registered = new Set<Terminable>()
let signalHandlerInstalled = false

const EXIT_CODE_BY_SIGNAL: Partial<Record<NodeJS.Signals, number>> = {
  SIGINT: 130, // 128 + 2, the conventional POSIX exit code for a signal-terminated process
  SIGTERM: 143, // 128 + 15
}

// Split from the process.on(...) wiring below deliberately: this is the
// actual cleanup fan-out logic, and it's the part this module is
// responsible for getting right. The OS-level signal SUBSCRIPTION itself
// is Node's own well-established primitive - not something worth
// re-proving in a test - and on Windows, child_process.kill('SIGINT'/
// 'SIGTERM') doesn't even deliver a catchable signal to begin with
// (confirmed empirically: it force-terminates the child directly, with no
// handler ever running), so a test relying on real cross-process signal
// delivery would be unable to pass on this platform regardless of whether
// the handler itself is correct. Exported for exactly that reason - a
// test can invoke the real fan-out logic directly and safely, in-process.
export async function runGracefulShutdown(): Promise<void> {
  const pending = [...registered]
  registered.clear()
  // Best-effort: a pool that fails to terminate cleanly must never block
  // every OTHER pool's cleanup.
  await Promise.allSettled(pending.map((pool) => pool.terminate()))
}

function installSignalHandlerOnce(): void {
  if (signalHandlerInstalled) return
  signalHandlerInstalled = true

  const handleSignal = (signal: NodeJS.Signals): void => {
    void runGracefulShutdown().then(() => process.exit(EXIT_CODE_BY_SIGNAL[signal] ?? 1))
  }

  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)
}

/** Registers `pool` to be terminated if the process receives SIGINT/SIGTERM
 *  before the pool's own shutdown() is called. Returns an unregister
 *  function - call it from shutdown() so a pool that already tore itself
 *  down cleanly isn't terminated a second time, and so a long-running
 *  process (e.g. this test suite) doesn't accumulate dead references. */
export function registerForGracefulShutdown(pool: Terminable): () => void {
  installSignalHandlerOnce()
  registered.add(pool)
  return () => registered.delete(pool)
}

/** TEST-ONLY: the number of pools currently registered for signal-based
 *  cleanup - lets a test prove registration/unregistration actually
 *  happens without depending on sending real signals to the test process
 *  itself (which would kill the test runner). */
export function registeredPoolCount(): number {
  return registered.size
}
