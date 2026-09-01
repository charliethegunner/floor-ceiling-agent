import { parentPort } from 'node:worker_threads'
import { runVerificationFloor } from '../verification-floor'
import { TOPOLOGY_FLOOR, type TopologyCandidate } from '../topology-floor'
import { CLAIM_VERIFICATION_FLOOR, type ClaimCandidate } from '../claim-floor'
import { SPATIAL_VERIFICATION_FLOOR, type SpatialCandidate } from '../spatial-floor'
import { ARM64_INSTRUCTION_FLOOR } from '../instruction-floor'

// The actual worker_thread entry point spawned by WorkerPoolEvaluator
// (./worker-pool.ts) - a separate top-level file because a Worker's entry
// must be its own module, not a class method. Only imports LEAF floor
// modules (verification-floor.ts + the four domain floors), never
// CeilingAgent.ts or anything under layer3/ - CeilingAgent.ts depends on
// the worker pool (via layer3/sampler.ts's optional offload), so this file
// importing back from CeilingAgent.ts would create a real circular
// dependency, not just an untidy one.
//
// stripJsonFences is duplicated from CeilingAgent.ts's private helper of
// the same name (6 lines of stable regex logic) rather than shared through
// a new module, specifically to avoid introducing an import edge purely to
// avoid duplicating something this small and unlikely to change - see
// CeilingAgent.ts's own copy for the fuller history/rationale (Phase 5.1).
const JSON_FENCE_PATTERN = /```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```/

function stripJsonFences(candidateText: string): string {
  const trimmed = candidateText.trim()
  const match = JSON_FENCE_PATTERN.exec(trimmed)
  return match ? match[1].trim() : trimmed
}

export type WorkerDomain = 'instruction' | 'topology' | 'claim' | 'spatial'

export interface WorkerVerifyTask {
  domain: WorkerDomain
  candidateText: string
  /** Required for domain: 'instruction' only. */
  x86Instruction?: string
  /** TEST-ONLY: sleep this many ms before verifying, so a timeout can be
   *  triggered deterministically instead of relying on timing luck. */
  __testDelayMs?: number
  /** TEST-ONLY: exit the process immediately on receipt, simulating a real
   *  worker crash (as opposed to a caught-and-reported verification error). */
  __testCrash?: boolean
}

export interface WorkerGateOutcome {
  gate: string
  ok: boolean
  details: string
}

async function verify(task: WorkerVerifyTask): Promise<WorkerGateOutcome[]> {
  switch (task.domain) {
    case 'instruction': {
      if (task.x86Instruction === undefined) {
        throw new Error('worker task for domain "instruction" is missing x86Instruction')
      }
      const report = await runVerificationFloor(ARM64_INSTRUCTION_FLOOR, {
        x86Instruction: task.x86Instruction,
        candidate: task.candidateText.toUpperCase(), // mirrors instruction-floor.ts's own case-folding
      })
      return report.gates
    }
    case 'topology': {
      const parsed = JSON.parse(stripJsonFences(task.candidateText)) as TopologyCandidate
      return (await runVerificationFloor(TOPOLOGY_FLOOR, parsed)).gates
    }
    case 'claim': {
      const parsed = JSON.parse(stripJsonFences(task.candidateText)) as ClaimCandidate
      return (await runVerificationFloor(CLAIM_VERIFICATION_FLOOR, parsed)).gates
    }
    case 'spatial': {
      const parsed = JSON.parse(stripJsonFences(task.candidateText)) as SpatialCandidate
      return (await runVerificationFloor(SPATIAL_VERIFICATION_FLOOR, parsed)).gates
    }
  }
}

interface IncomingMessage extends WorkerVerifyTask {
  taskId: number
}

type OutgoingMessage = { taskId: number; ok: true; gates: WorkerGateOutcome[] } | { taskId: number; ok: false; error: string }

if (!parentPort) {
  throw new Error('worker-pool-worker.ts must be run as a node:worker_threads Worker, not imported directly')
}

const port = parentPort

port.on('message', (message: IncomingMessage) => {
  if (message.__testCrash) {
    process.exit(1)
  }

  const run = message.__testDelayMs
    ? new Promise<void>((resolve) => setTimeout(resolve, message.__testDelayMs)).then(() => verify(message))
    : verify(message)

  run
    .then((gates) => {
      const response: OutgoingMessage = { taskId: message.taskId, ok: true, gates }
      port.postMessage(response)
    })
    .catch((error: unknown) => {
      const response: OutgoingMessage = { taskId: message.taskId, ok: false, error: error instanceof Error ? error.message : String(error) }
      port.postMessage(response)
    })
})
