import { parentPort } from 'node:worker_threads'
import { runVerificationFloor } from '../../verification-floor'
import { BREP_VERIFICATION_FLOOR, type BRepCandidate } from './brep-floor'
import { loadOpenCascade } from './oc-loader'
import type { WorkerGateOutcome } from '../worker-pool-worker'

// The dedicated worker_thread entry point for Phase 15.0 B-Rep
// verification - deliberately its OWN worker script rather than a new case
// added to worker-pool-worker.ts's domain switch, so the general pool's
// existing workers (already measured at 258MB cold / 475MB under mixed
// load - see worker-pool.ts's header comment) never pay OpenCASCADE's
// ~450-500MB footprint just to handle an unrelated instruction/topology/
// claim/spatial task. loadOpenCascade() is called once, eagerly, at worker
// startup (module scope, not per-message) so every verification this
// worker ever handles reuses the same already-initialized kernel instance -
// the ~600ms cold-init cost is paid once per worker's lifetime.

export type BRepWorkerDomain = 'brep'

export interface BRepWorkerVerifyTask {
  domain: BRepWorkerDomain
  candidateText: string
}

const ocReady = loadOpenCascade()

export async function verify(task: BRepWorkerVerifyTask): Promise<WorkerGateOutcome[]> {
  await ocReady // ensures the kernel is loaded before the first task is processed, without re-loading it per call
  const gates: WorkerGateOutcome[] = []
  const onGateComplete = (gate: { gate: string; ok: boolean; details: string }, elapsedMs: number): void => {
    gates.push({ ...gate, elapsedMs })
  }
  const candidate = JSON.parse(task.candidateText) as BRepCandidate
  await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate, onGateComplete)
  return gates
}

interface IncomingMessage extends BRepWorkerVerifyTask {
  taskId: number
  /** TEST-ONLY: exit the process immediately, simulating a real worker crash. */
  __testCrash?: boolean
  /** TEST-ONLY: sleep this many ms before verifying, so a timeout can be triggered deterministically. */
  __testDelayMs?: number
  /** TEST-ONLY: report this RSS value instead of the real process.memoryUsage.rss() reading, so recycling can be tested deterministically without actually allocating hundreds of MB. */
  __testFakeRssBytes?: number
}

type OutgoingMessage = { taskId: number; ok: true; gates: WorkerGateOutcome[]; rssBytes: number } | { taskId: number; ok: false; error: string; rssBytes: number }

if (parentPort) {
  const port = parentPort

  port.on('message', (message: IncomingMessage) => {
    if (message.__testCrash) {
      process.exit(1)
    }

    const run = message.__testDelayMs
      ? new Promise<void>((resolve) => setTimeout(resolve, message.__testDelayMs)).then(() => verify(message))
      : verify(message)

    const rssBytes = (): number => message.__testFakeRssBytes ?? process.memoryUsage.rss()

    run
      .then((gates) => {
        const response: OutgoingMessage = { taskId: message.taskId, ok: true, gates, rssBytes: rssBytes() }
        port.postMessage(response)
      })
      .catch((error: unknown) => {
        const response: OutgoingMessage = { taskId: message.taskId, ok: false, error: error instanceof Error ? error.message : String(error), rssBytes: rssBytes() }
        port.postMessage(response)
      })
  })
}
