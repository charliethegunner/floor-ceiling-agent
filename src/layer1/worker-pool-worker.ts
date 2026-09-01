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
  /** domain: 'topology' only (Phase 12.0) - extra { path: text } repository
   *  context from a ProjectPackIngestor-ingested workspace (see
   *  ingestion-floor.ts's toWorkspaceFiles), merged into the candidate's own
   *  inMemoryFiles before verification so reachability/export checks can
   *  resolve against a real multi-file graph, not just the candidate's own
   *  proposed files. The candidate's own files always win on a path
   *  collision - workspaceFiles is background context, never an override. */
  workspaceFiles?: Record<string, string>
  /** TEST-ONLY: sleep this many ms before verifying, so a timeout can be
   *  triggered deterministically instead of relying on timing luck. */
  __testDelayMs?: number
  /** TEST-ONLY: exit the process immediately on receipt, simulating a real
   *  worker crash (as opposed to a caught-and-reported verification error). */
  __testCrash?: boolean
  /** TEST-ONLY: report this RSS value instead of the real
   *  process.memoryUsage.rss() reading, so Phase 13.3's recycling behavior
   *  can be tested deterministically without actually allocating hundreds
   *  of MB. */
  __testFakeRssBytes?: number
}

export interface WorkerGateOutcome {
  gate: string
  ok: boolean
  details: string
  /** Real per-gate latency, measured INSIDE the worker thread via
   *  runVerificationFloor's onGateComplete hook (Phase 11.1) - not
   *  approximated from the round-trip time after the fact. Optional so a
   *  caller-supplied fallback (WorkerPoolEvaluator.verify's `fallback`
   *  param) that doesn't itself have per-gate timing can still satisfy this
   *  type; sampler.ts treats a missing value as "unknown," not "zero." */
  elapsedMs?: number
}

// Phase 13.3: process.memoryUsage.rss() is a PROCESS-WIDE OS metric - Node's
// worker_threads are real OS threads sharing one process (unlike
// child_process, which spawns genuinely separate processes with their own
// isolated RSS), so this reading is the WHOLE process's resident set, not
// this worker's exclusive share. It's still a real, useful signal: sampled
// right as each worker finishes a task, WorkerPoolEvaluator uses a rising
// reading to proactively recycle the worker that just reported it, which
// discards that worker's own V8 isolate (module state, its own heap
// growth) and forces the pool to respawn a fresh one - a genuine mitigation
// for process memory growth from long-running/large-project-pack work, even
// though the number itself can't be attributed to one worker in isolation.

async function verify(task: WorkerVerifyTask): Promise<WorkerGateOutcome[]> {
  const gates: WorkerGateOutcome[] = []
  const onGateComplete = (gate: { gate: string; ok: boolean; details: string }, elapsedMs: number): void => {
    gates.push({ ...gate, elapsedMs })
  }

  switch (task.domain) {
    case 'instruction': {
      if (task.x86Instruction === undefined) {
        throw new Error('worker task for domain "instruction" is missing x86Instruction')
      }
      await runVerificationFloor(
        ARM64_INSTRUCTION_FLOOR,
        { x86Instruction: task.x86Instruction, candidate: task.candidateText.toUpperCase() }, // mirrors instruction-floor.ts's own case-folding
        onGateComplete
      )
      return gates
    }
    case 'topology': {
      const parsed = JSON.parse(stripJsonFences(task.candidateText)) as TopologyCandidate
      const candidate: TopologyCandidate = task.workspaceFiles
        ? { ...parsed, inMemoryFiles: { ...task.workspaceFiles, ...parsed.inMemoryFiles } }
        : parsed
      await runVerificationFloor(TOPOLOGY_FLOOR, candidate, onGateComplete)
      return gates
    }
    case 'claim': {
      const parsed = JSON.parse(stripJsonFences(task.candidateText)) as ClaimCandidate
      await runVerificationFloor(CLAIM_VERIFICATION_FLOOR, parsed, onGateComplete)
      return gates
    }
    case 'spatial': {
      const parsed = JSON.parse(stripJsonFences(task.candidateText)) as SpatialCandidate
      await runVerificationFloor(SPATIAL_VERIFICATION_FLOOR, parsed, onGateComplete)
      return gates
    }
  }
}

interface IncomingMessage extends WorkerVerifyTask {
  taskId: number
}

type OutgoingMessage = { taskId: number; ok: true; gates: WorkerGateOutcome[]; rssBytes: number } | { taskId: number; ok: false; error: string; rssBytes: number }

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
