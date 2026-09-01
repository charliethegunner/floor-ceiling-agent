import { describe, test, expect, afterEach } from 'vitest'
import { TaskGraphExecutor } from '../layer0/task-graph'
import { buildPrompt, type LlmClient } from '../CeilingAgent'
import { BRepWorkerPoolEvaluator } from '../layer1/brep/brep-worker-pool'
import type { BRepCandidate } from '../layer1/brep/brep-floor'
import type { TopologyCandidate } from '../topology-floor'
import type { ClaimCandidate } from '../claim-floor'
import type { SpatialCandidate } from '../spatial-floor'

// Phase 20.0: proves the 5 real verification domains (instruction, spatial,
// brep, topology, claim) genuinely compose through ONE TaskGraphExecutor
// run - not just individually pass their own unit tests, and not just
// pairwise (src/integration/engine-integration.test.ts already covers
// ingestion/worker-pool/telemetry/sandbox composition; this file is
// deliberately scoped to what THAT one doesn't touch: TaskGraphExecutor
// itself, brep/claim domains, and the Phase 17.0/18.0/19.0 mechanisms -
// parent-state retention, caller-driven node injection, and structured
// diagnostics - running together across domain boundaries, not in
// isolation as their own unit tests already prove separately).
//
// A real finding from building this against the actual worker boundary,
// not assumed: a brep candidate is JSON round-tripped twice (once as the
// scripted "LLM response" text, once more inside BRepWorkerPoolEvaluator's
// postMessage payload) before OpenCASCADE ever sees it, and JSON has no
// NaN representation (JSON.stringify(NaN) === 'null') - so the NaN-radius
// sphere brep-floor.test.ts uses to reach BRepCheck_Analyzer's real
// invalid-shape path can't be reused here; it silently degrades to a
// DIFFERENT, earlier failure (a precondition throw, never reaching
// BRepCheck_Analyzer, so Phase 19.0's `structured` field never populates).
// Node C below instead uses the out-of-bounds edge index the Phase 20.0
// spec itself suggested as an example - a real, JSON-safe failure - and
// the structured-diagnostic proof is carried by Node A's Z3 counterexample
// instead (instruction-domain candidates are plain ARM64 text, never
// JSON, so this gap doesn't apply there).
//
// Same honesty discipline as engine-integration.test.ts's own RSS check
// ("coarse sanity check, not a rigorous leak proof"): worker-handle
// leak-freedom is checked via the real, spike-established
// process.getActiveResourcesInfo() MessagePort count
// (src/layer1/process-lifecycle.test.ts's own technique) before/after
// pool shutdown - genuine OS-level proof for worker_threads specifically,
// not a claim about WASM heap bytes reclaimed (opencascade.js exposes no
// such introspection; OcDisposable's tracked delete() calls, already
// exercised by every real brep test in this suite and brep-floor.test.ts,
// are this codebase's actual leak-prevention mechanism). "100% pass rate
// across consecutive runs" is verified by actually running this file (and
// the full suite) twice in a row, the same practice used for every phase
// in this project - not a repeated-run loop baked into the test itself,
// which engine-integration.test.ts's own header comment already rules out
// as a route to a slow/flaky `npm test`.

class MultiDomainScriptedLlmClient implements LlmClient {
  private readonly queues: Map<string, string[]>
  private readonly counts = new Map<string, number>()

  constructor(scripts: Array<[needle: string, responses: string[]]>) {
    this.queues = new Map(scripts.map(([needle, responses]) => [needle, [...responses]]))
  }

  async complete(prompt: string): Promise<string> {
    for (const [needle, queue] of this.queues) {
      if (prompt.includes(needle)) {
        const next = queue.shift()
        if (next === undefined) throw new Error(`MultiDomainScriptedLlmClient: needle "${needle}" ran out of scripted responses`)
        this.counts.set(needle, (this.counts.get(needle) ?? 0) + 1)
        return next
      }
    }
    throw new Error(`MultiDomainScriptedLlmClient: no scripted queue matches prompt:\n${prompt.slice(0, 300)}`)
  }

  /** Real per-node LLM call count, keyed by the same needle used to script
   *  it - the direct proof (not a code-reading assumption) that a node
   *  already in `completed` is never re-verified by a sibling's failure,
   *  retry, or injection elsewhere in the same run. */
  callCountFor(needle: string): number {
    return this.counts.get(needle) ?? 0
  }
}

function countMessagePorts(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'MessagePort').length
}

const pools: BRepWorkerPoolEvaluator[] = []
function trackedBRepPool(...args: ConstructorParameters<typeof BRepWorkerPoolEvaluator>): BRepWorkerPoolEvaluator {
  const pool = new BRepWorkerPoolEvaluator(...args)
  pools.push(pool)
  return pool
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()))
})

// Node A's first (bad) attempt: RCX - RCX instead of RCX - RAX - a real
// SAT mismatch (same proof CeilingAgent.test.ts's own Phase 19.0 test
// uses), so Z3 genuinely populates the structured symbolic-counterexample.
const BAD_INSTRUCTION_CANDIDATE = 'SUB X2, X2, X2'
const GOOD_INSTRUCTION_CANDIDATE = 'SUB X2, X2, X0'

// Node C's first (bad) attempt: an out-of-bounds edge index - the Phase
// 20.0 spec's own suggested example, and a real, JSON-round-trip-safe
// failure (unlike a NaN-radius shape - see the header comment above).
const BAD_BREP_CANDIDATE: BRepCandidate = {
  solid: { type: 'fillet', child: { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] }, edgeIndices: [99], radius: 1 },
  boundingBox: { min: [-60, -60, -60], max: [60, 60, 60] },
}

// Node C's retry attempt: a real composed operation (fillet applied to an
// already-shelled box - the exact composition brep-floor.test.ts's own
// "composed advanced operations" suite proves works) with STEP export
// requested.
const GOOD_BREP_CANDIDATE: BRepCandidate = {
  solid: {
    type: 'fillet',
    child: { type: 'shell', child: { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] }, faceIndices: [0], thickness: 1 },
    edgeIndices: [0],
    radius: 0.5,
  },
  boundingBox: { min: [-60, -60, -60], max: [60, 60, 60] },
  exportStep: true,
}

// Node D's candidate: always missing the required export - genuinely,
// permanently wrong, so with maxRetries: 1 it exhausts and settles
// 'failed' (not a self-corrected retry, unlike Nodes A/C above).
const BAD_TOPOLOGY_CANDIDATE: TopologyCandidate = {
  inMemoryFiles: { 'a.ts': 'function a(): number { return 1 }' },
  expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
  reachability: [],
}

// The injected D-resolver's candidate: the same module, fixed.
const GOOD_TOPOLOGY_CANDIDATE: TopologyCandidate = {
  inMemoryFiles: { 'a.ts': 'export function a(): number { return 1 }' },
  expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
  reachability: [],
}

const GOOD_SPATIAL_CANDIDATE: SpatialCandidate = {
  surface: { type: 'sphere', center: [0, 0, 0], radius: 1 },
  boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
}

const GOOD_CLAIM_CANDIDATE: ClaimCandidate = {
  claims: [
    {
      statement: 'translateInstruction lowers MOV RAX, RBX to MOV X0, X1',
      subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
      assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X0, X1' } },
    },
  ],
}

describe('Phase 20.0: full-engine multi-domain integration', () => {
  test(
    'a 5-domain graph (instruction, spatial, claim independent; brep depends on instruction+spatial; topology depends on brep) ' +
      'executes concurrently, Node A self-corrects via a Phase 19.0 structured Z3 diagnostic, Node C self-corrects on a real ' +
      "out-of-bounds edge index while its verified parents stay cached, Node D genuinely fails and its onNodeSettled callback " +
      'injects a resolver via injectNodes() that runs to completion, real STEP text is produced, and no worker handles leak ' +
      'past pool shutdown',
    async () => {
      const messagePortsBefore = countMessagePorts()
      const brepPool = trackedBRepPool({ poolSize: 1 })

      const llm = new MultiDomainScriptedLlmClient([
        ['x86 instruction: SUB RCX, RAX', [BAD_INSTRUCTION_CANDIDATE, GOOD_INSTRUCTION_CANDIDATE]],
        ['a unit sphere within its bounding box', [JSON.stringify(GOOD_SPATIAL_CANDIDATE)]],
        ['a filleted, shelled box with STEP export', [JSON.stringify(BAD_BREP_CANDIDATE), JSON.stringify(GOOD_BREP_CANDIDATE)]],
        ['a module a.ts exporting a, deliberately never fixed', [JSON.stringify(BAD_TOPOLOGY_CANDIDATE)]],
        ['a corrected module a.ts exporting a', [JSON.stringify(GOOD_TOPOLOGY_CANDIDATE)]],
        ['MOV RAX, RBX lowers to MOV X0, X1', [JSON.stringify(GOOD_CLAIM_CANDIDATE)]],
      ])

      const executor: TaskGraphExecutor = new TaskGraphExecutor({
        llm,
        brepPool,
        onNodeSettled: (result) => {
          if (result.id === 'D' && result.status === 'failed') {
            executor.injectNodes([{ id: 'D-resolver', kind: 'topology', description: 'a corrected module a.ts exporting a', dependsOn: ['C'] }])
          }
        },
      })

      const result = await executor.run({
        nodes: [
          { id: 'A', kind: 'instruction', description: 'SUB RCX, RAX' },
          { id: 'B', kind: 'spatial', description: 'a unit sphere within its bounding box' },
          { id: 'E', kind: 'claim', description: 'MOV RAX, RBX lowers to MOV X0, X1' },
          { id: 'C', kind: 'brep', description: 'a filleted, shelled box with STEP export', dependsOn: ['A', 'B'] },
          { id: 'D', kind: 'topology', description: 'a module a.ts exporting a, deliberately never fixed', dependsOn: ['C'], maxRetries: 1 },
        ],
      })

      const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]))

      // Node A: a genuine Z3 SAT mismatch, self-corrected on retry -
      // carrying Phase 19.0's real structured counterexample, not just a
      // pass/fail boolean. Plain-text ARM64 candidates never touch JSON,
      // so this is the clean vehicle for `structured` in this suite.
      expect(byId.A.status).toBe('ok')
      const aSuccess = byId.A.status === 'ok' ? byId.A.success : undefined
      expect(aSuccess?.attempts).toBe(2)
      expect(aSuccess?.history).toHaveLength(1)
      expect(aSuccess?.history[0].failedGate.gate).toBe('symbolic')
      expect(aSuccess?.history[0].failedGate.structured).toEqual({
        kind: 'symbolic-counterexample',
        assignments: expect.arrayContaining([expect.objectContaining({ variable: 'dst' }), expect.objectContaining({ variable: 'src' })]),
      })
      const aRetryPrompt = buildPrompt({ kind: 'instruction', description: 'SUB RCX, RAX' }, aSuccess!.history)
      expect(aRetryPrompt).toContain('Structured: dst=')

      expect(byId.B.status).toBe('ok')
      expect(byId.E.status).toBe('ok')

      // Node C: a real, JSON-safe failure (out-of-bounds edge index, the
      // spec's own suggested example) - self-corrected on retry, with its
      // verified parents (A, B) untouched throughout (proven below by
      // call count, not assumed).
      expect(byId.C.status).toBe('ok')
      const cSuccess = byId.C.status === 'ok' ? byId.C.success : undefined
      expect(cSuccess?.attempts).toBe(2)
      expect(cSuccess?.history).toHaveLength(1)
      expect(cSuccess?.history[0].failedGate.details).toContain('edgeIndices contains 99')

      // Real, non-empty, valid STEP text from the recovered node - the
      // real ISO-10303-21 artifact this project actually produces (not
      // "binary data" - STEP AP214 is a plain-text format).
      const stepGate = cSuccess?.gates.find((g) => g.gate === 'step-export')
      expect(stepGate?.ok).toBe(true)
      expect(stepGate?.details.startsWith('ISO-10303-21;')).toBe(true)
      expect(stepGate?.details.length).toBeGreaterThan(100)

      // Node D: genuinely, permanently wrong - exhausts and settles
      // 'failed', never silently retried forever or masked as success.
      expect(byId.D.status).toBe('failed')

      // Caller-driven injectNodes(), triggered from onNodeSettled on D's
      // real failure, ran its resolver to completion in the SAME run.
      expect(byId['D-resolver']).toBeDefined()
      expect(byId['D-resolver'].status).toBe('ok')

      // Parent-state retention (Phase 17.0/18.0's mechanism) proven by
      // real LLM call count, not a code-reading assumption: B (never
      // retried) stays at exactly 1 call, and A's total (2, from its own
      // earlier retry) never grows again once C starts its own retries or
      // D fails and is resolved - no already-completed node is
      // re-verified by a sibling's failure, retry, or injection.
      expect(llm.callCountFor('x86 instruction: SUB RCX, RAX')).toBe(2)
      expect(llm.callCountFor('a unit sphere within its bounding box')).toBe(1)

      // The graph is honest about D's real failure even though its
      // resolver succeeded - overall ok reflects every node, not just
      // the ones that were eventually patched up.
      expect(result.ok).toBe(false)

      await Promise.all(pools.splice(0).map((pool) => pool.shutdown()))
      expect(countMessagePorts()).toBeLessThanOrEqual(messagePortsBefore)
    },
    30000
  )
})
