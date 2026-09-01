import { describe, test, expect, afterEach } from 'vitest'
import { topologicalSort, TaskGraphExecutor, CycleDetectedError, type TaskNode, type TaskNodeResult } from './task-graph'
import { MetaKernelCompiler } from '../layer5/meta-kernel'
import type { LlmClient } from '../CeilingAgent'
import { classifyIntent } from './intent-router'
import { BRepWorkerPoolEvaluator } from '../layer1/brep/brep-worker-pool'
import type { BRepCandidate } from '../layer1/brep/brep-floor'

function node(id: string, dependsOn?: string[]): TaskNode {
  return { id, kind: 'instruction', description: 'MOV RAX, RBX', dependsOn }
}

// ---------------------------------------------------------------------------
// topologicalSort (Phase 14.5.1): pure, synchronous, no LLM involved.
// ---------------------------------------------------------------------------

describe('topologicalSort: real dependency resolution, never LLM-inferred', () => {
  test('a linear chain sorts in dependency order', () => {
    const order = topologicalSort([node('c', ['b']), node('a'), node('b', ['a'])])
    expect(order.map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  test('a diamond dependency (a -> b, a -> c, b+c -> d) places a before b/c, and both before d', () => {
    const order = topologicalSort([node('d', ['b', 'c']), node('b', ['a']), node('c', ['a']), node('a')])
    const index = (id: string) => order.findIndex((n) => n.id === id)
    expect(index('a')).toBeLessThan(index('b'))
    expect(index('a')).toBeLessThan(index('c'))
    expect(index('b')).toBeLessThan(index('d'))
    expect(index('c')).toBeLessThan(index('d'))
  })

  test('independent nodes with no relationship all appear, in some valid order', () => {
    const order = topologicalSort([node('x'), node('y'), node('z')])
    expect(order.map((n) => n.id).sort()).toEqual(['x', 'y', 'z'])
  })

  test('a real cycle is detected and rejected, never silently dropped', () => {
    expect(() => topologicalSort([node('a', ['b']), node('b', ['a'])])).toThrow(/cycle/)
  })

  test('a dependency on an unknown task id is rejected, never silently ignored', () => {
    expect(() => topologicalSort([node('a', ['nonexistent'])])).toThrow(/unknown task "nonexistent"/)
  })
})

// ---------------------------------------------------------------------------
// TaskGraphExecutor: real runCeilingAgent calls underneath, real
// concurrency, real failure propagation, real cross-node MetaKernelCompiler
// reuse (Phase 14.5.2).
// ---------------------------------------------------------------------------

class ScriptedByPromptLlmClient implements LlmClient {
  callCount = 0
  private readonly callTimestamps: number[] = []
  constructor(private readonly byNeedle: Array<[string, string]>) {}

  async complete(prompt: string): Promise<string> {
    this.callCount++
    this.callTimestamps.push(Date.now())
    for (const [needle, response] of this.byNeedle) {
      if (prompt.includes(needle)) return response
    }
    throw new Error(`ScriptedByPromptLlmClient: no scripted response for prompt containing any of [${this.byNeedle.map((n) => n[0]).join(', ')}]: ${prompt.slice(0, 120)}`)
  }

  /** Real timestamps of each complete() call - used to prove genuine concurrency (a near-zero gap), not asserted from wall-clock alone (which includes real, variable Z3/verification overhead). */
  get timestamps(): readonly number[] {
    return this.callTimestamps
  }
}

class OneShotLlmClient implements LlmClient {
  constructor(private readonly candidate: string) {}
  async complete(): Promise<string> {
    return this.candidate
  }
}

describe('TaskGraphExecutor: real dependency-ordered execution', () => {
  test('independent nodes genuinely run concurrently, not sequentially (proven by call-start timing, not noisy wall clock)', async () => {
    const llm = new ScriptedByPromptLlmClient([
      ['MOV RAX, RBX', 'MOV X0, X1'],
      ['MOV RCX, RDX', 'MOV X2, X3'],
    ])
    const executor = new TaskGraphExecutor({ llm })

    const result = await executor.run({
      nodes: [
        { id: 'a', kind: 'instruction', description: 'MOV RAX, RBX' },
        { id: 'b', kind: 'instruction', description: 'MOV RCX, RDX' },
      ],
    })

    expect(result.ok).toBe(true)
    expect(llm.timestamps).toHaveLength(2)
    expect(Math.abs(llm.timestamps[0] - llm.timestamps[1])).toBeLessThan(50) // both fired essentially at once
  }, 15000)

  test('a downstream node genuinely receives its upstream dependency\'s REAL verified result, not a guess', async () => {
    const llm = new ScriptedByPromptLlmClient([
      ['MOV RAX, RBX', 'MOV X0, X1'],
      ['embed:', 'CMP X0, X1'], // the downstream node's own description will contain "embed:<upstream result>"
    ])
    const executor = new TaskGraphExecutor({ llm })

    let seenUpstreamResult = ''
    const result = await executor.run({
      nodes: [
        { id: 'upstream', kind: 'instruction', description: 'MOV RAX, RBX' },
        {
          id: 'downstream',
          kind: 'instruction',
          description: (upstream) => {
            seenUpstreamResult = upstream.get('upstream')!.result
            return `embed: ${seenUpstreamResult}`
          },
          dependsOn: ['upstream'],
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(seenUpstreamResult).toBe('MOV X0, X1') // the REAL verified output of the upstream node, not a placeholder
  }, 15000)

  test('a failed node causes its dependents to be skipped (never attempted), while unrelated independent nodes still complete', async () => {
    const llm = new ScriptedByPromptLlmClient([
      ['x86 instruction: ADD RAX, RBX', 'MOV X9, X9'], // always wrong for ADD - genuinely exhausts retries
      ['MOV RCX, RDX', 'MOV X2, X3'],
    ])
    const executor = new TaskGraphExecutor({ llm })

    const result = await executor.run({
      nodes: [
        { id: 'fails', kind: 'instruction', description: 'ADD RAX, RBX', maxRetries: 1 },
        { id: 'dependent', kind: 'instruction', description: 'MOV RCX, RDX', dependsOn: ['fails'] },
        { id: 'independent', kind: 'instruction', description: 'MOV RCX, RDX' },
      ],
    })

    expect(result.ok).toBe(false)
    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n.status]))
    expect(byId).toEqual({ fails: 'failed', dependent: 'skipped', independent: 'ok' })
  }, 15000)

  test('a chain of skips propagates transitively (grandchild of a failure is also skipped, not just the direct child)', async () => {
    const llm = new ScriptedByPromptLlmClient([['x86 instruction: ADD RAX, RBX', 'MOV X9, X9']])
    const executor = new TaskGraphExecutor({ llm })

    const result = await executor.run({
      nodes: [
        { id: 'fails', kind: 'instruction', description: 'ADD RAX, RBX', maxRetries: 1 },
        { id: 'child', kind: 'instruction', description: 'MOV RAX, RBX', dependsOn: ['fails'] },
        { id: 'grandchild', kind: 'instruction', description: 'MOV RAX, RBX', dependsOn: ['child'] },
      ],
    })

    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n.status]))
    expect(byId).toEqual({ fails: 'failed', child: 'skipped', grandchild: 'skipped' })
  }, 15000)

  test('results are returned in topological order regardless of concurrent completion order', async () => {
    const llm = new ScriptedByPromptLlmClient([
      ['MOV RAX, RBX', 'MOV X0, X1'],
      ['MOV RCX, RDX', 'MOV X2, X3'],
    ])
    const executor = new TaskGraphExecutor({ llm })
    const result = await executor.run({
      nodes: [
        { id: 'second', kind: 'instruction', description: 'MOV RCX, RDX', dependsOn: ['first'] },
        { id: 'first', kind: 'instruction', description: 'MOV RAX, RBX' },
      ],
    })
    expect(result.nodes.map((n) => n.id)).toEqual(['first', 'second'])
  }, 15000)
})

// ---------------------------------------------------------------------------
// Phase 17.0: an explicit demonstration of a property that already held
// (Phase 14.5.1's own concurrent-DAG-execution and skip-propagation
// design) - added here under the vocabulary Phase 17.0 was scoped in
// ("verified parent states retained, not re-generated, when a downstream
// step fails and backtracks to an alternative candidate branch"), rather
// than a new orchestration layer. completed.set(node.id, success) in
// runNode is called exactly once per node and never revisited, so this
// asserts the DIRECT, strong proof of that: the LLM's total call count
// is exactly attempts(A) + attempts(B) + attempts(C) - if either verified
// parent were ever regenerated because C failed, this count would be
// wrong.
// ---------------------------------------------------------------------------

describe('TaskGraphExecutor: Phase 17.0 - verified parent states are retained, never re-generated, across a downstream node\'s real failure and recovery', () => {
  test('nodes A and B pass on their first attempt; node C fails a real Z3 gate on attempt 1 and recovers on attempt 2; A and B are never re-evaluated', async () => {
    const llm = new ScriptedByPromptLlmClient([
      // Checked in array order - the more specific "this is a retry" needle
      // (the previously-rejected candidate text, present only in attempt 2's
      // feedback) must come before the generic "first attempt" needle for
      // the same node, or the generic one would win for both attempts.
      ['MOV X9, X9', 'ADD X0, X0, X1'], // C's retry: its own rejected candidate only appears in the retry-feedback prompt
      ['MOV RAX, RBX', 'MOV X0, X1'], // node A - correct on the only attempt it gets
      ['MOV RCX, RDX', 'MOV X2, X3'], // node B - correct on the only attempt it gets
      ['ADD RAX, RBX', 'MOV X9, X9'], // C's first attempt - a real, genuinely wrong ARM64 translation (missing the 3rd operand)
    ])
    const executor = new TaskGraphExecutor({ llm })

    const result = await executor.run({
      nodes: [
        { id: 'A', kind: 'instruction', description: 'MOV RAX, RBX' },
        { id: 'B', kind: 'instruction', description: 'MOV RCX, RDX' },
        { id: 'C', kind: 'instruction', description: 'ADD RAX, RBX', dependsOn: ['A', 'B'] },
      ],
    })

    expect(result.ok).toBe(true)
    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]))
    expect(byId.A.status).toBe('ok')
    expect(byId.B.status).toBe('ok')
    expect(byId.C.status).toBe('ok')

    // A and B: verified on the FIRST attempt, and that's the only LLM call
    // either of them ever gets - the direct meaning of "retained, not
    // re-generated," regardless of what happens to C.
    expect(byId.A.status === 'ok' && byId.A.success.attempts).toBe(1)
    expect(byId.B.status === 'ok' && byId.B.success.attempts).toBe(1)

    // C: a REAL Z3 rejection on attempt 1 (not a contrived one - "MOV X9, X9"
    // is a genuinely incomplete translation of "ADD RAX, RBX"), then a real
    // recovery on attempt 2 - "backtracks to an alternative candidate branch."
    expect(byId.C.status === 'ok' && byId.C.success.attempts).toBe(2)
    expect(byId.C.status === 'ok' && byId.C.success.history[0]?.failedGate.gate).toBe('symbolic')

    // The strongest, most direct proof: exactly 4 total LLM calls across
    // the whole run (A:1 + B:1 + C:2). If the executor had ever regenerated
    // an already-verified parent in response to C's failure, this count
    // would be higher than 4.
    expect(llm.callCount).toBe(4)
  }, 15000)
})

describe('TaskGraphExecutor: Phase 14.5.3 - real peer review wiring', () => {
  const CLAIM_JSON = JSON.stringify({
    claims: [
      {
        statement: "firstCharCode('A') returns 65",
        subject: { modulePath: 'src/layer0/__fixtures__/flaky-subject.ts', exportName: 'firstCharCode' },
        assertion: { args: ['A'], expected: 65 },
      },
    ],
  })

  test('a node whose claim passes the primary floor but fails reviewQa\'s real adversarial check is demoted to \'failed\', and its dependents are skipped - exactly like any other failure', async () => {
    const llm = new ScriptedByPromptLlmClient([
      ['firstCharCode', CLAIM_JSON],
      ['advisory commentary', 'looks fine to me'],
      ['MOV RCX, RDX', 'MOV X2, X3'],
    ])
    const executor = new TaskGraphExecutor({ llm, peerReview: true })

    const result = await executor.run({
      nodes: [
        { id: 'reviewed', kind: 'claim', description: "claim that firstCharCode('A') returns 65" },
        { id: 'dependent', kind: 'instruction', description: 'MOV RCX, RDX', dependsOn: ['reviewed'] },
        { id: 'independent', kind: 'instruction', description: 'MOV RCX, RDX' },
      ],
    })

    expect(result.ok).toBe(false)
    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n.status]))
    expect(byId).toEqual({ reviewed: 'failed', dependent: 'skipped', independent: 'ok' })

    const reviewedNode = result.nodes.find((n) => n.id === 'reviewed')
    expect(reviewedNode?.status === 'failed' && reviewedNode.review?.qa.ok).toBe(false)
    expect(reviewedNode?.status === 'failed' && reviewedNode.error).toMatch(/peer review rejected the candidate/)
  }, 15000)

  test('a clean claim with peerReview enabled succeeds and carries the real review result, including non-blocking Architect commentary', async () => {
    const cleanClaim = JSON.stringify({
      claims: [
        {
          statement: 'translateInstruction translates MOV RAX, RBX',
          subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
          assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X0, X1' } },
        },
      ],
    })
    const llm = new ScriptedByPromptLlmClient([
      ['translateInstruction translates', cleanClaim],
      ['advisory commentary', 'well-formed claim, no notes'],
    ])
    const executor = new TaskGraphExecutor({ llm, peerReview: true })

    const result = await executor.run({
      nodes: [{ id: 'ok-claim', kind: 'claim', description: 'translateInstruction translates MOV RAX, RBX' }],
    })

    expect(result.ok).toBe(true)
    const node = result.nodes[0]
    expect(node.status).toBe('ok')
    expect(node.status === 'ok' && node.review?.ok).toBe(true)
    expect(node.status === 'ok' && node.review?.architect?.advisory).toBe(true)
  }, 15000)
})

describe('TaskGraphExecutor: Phase 14.5.2 - real cross-node MetaKernelCompiler reuse', () => {
  test('a rule taught by one node\'s genuine self-heal is reused by a later, different-but-same-shape node - zero additional LLM calls, proven via the real resolvedLayer field', async () => {
    const metaKernel = new MetaKernelCompiler()

    // Node "teach": a genuine LLM self-heal (2 real calls) that ALSO teaches
    // the meta-kernel a rule. A retry's feedback prompt still contains the
    // original prompt text too, so a needle-matched scripted client can't
    // tell attempt 1 apart from attempt 2 - a small stateful client is used
    // instead, matching this project's own OnceOnlyLlmClient-style pattern.
    let teachCallCount = 0
    const statefulTeachLlm: LlmClient = {
      async complete(): Promise<string> {
        teachCallCount++
        return teachCallCount === 1 ? 'ADD X0, X1, X0' : 'ADD X0, X0, X1'
      },
    }

    const teachExecutor = new TaskGraphExecutor({ llm: statefulTeachLlm, metaKernel, formatResponse: true })
    const teachResult = await teachExecutor.run({ nodes: [{ id: 'teach', kind: 'instruction', description: 'ADD RAX, RBX' }] })
    expect(teachResult.ok).toBe(true)
    expect(metaKernel.ruleCount).toBe(1)

    // Node "bypass": a DIFFERENT instruction (SUB, different registers) failing the SAME shape of
    // mistake. Only ONE LLM call is scripted - if the bypass needed a second call, this would throw.
    const bypassLlm = new OneShotLlmClient('SUB X2, X0, X2') // wrong: swapped operands, same shape as the taught rule
    const bypassExecutor = new TaskGraphExecutor({ llm: bypassLlm, metaKernel, formatResponse: true })
    const bypassResult = await bypassExecutor.run({ nodes: [{ id: 'bypass', kind: 'instruction', description: 'SUB RCX, RAX' }] })

    expect(bypassResult.ok).toBe(true)
    const bypassNode = bypassResult.nodes[0]
    expect(bypassNode.status).toBe('ok')
    expect(bypassNode.status === 'ok' && bypassNode.success.result).toBe('SUB X2, X2, X0')
    // The real, concrete proof this was a cache hit, not a coincidence: resolvedLayer says so.
    expect(bypassNode.status === 'ok' && bypassNode.success.formatted?.summary.resolvedLayer).toBe('layer5-meta-kernel')
  }, 15000)

  test('without a shared metaKernel, two separate executors do NOT share learned rules (proving the sharing above is real, not automatic/global)', async () => {
    const teachLlm = new ScriptedByPromptLlmClient([['ADD RAX, RBX', 'ADD X0, X0, X1']])
    const teachExecutor = new TaskGraphExecutor({ llm: teachLlm, metaKernel: new MetaKernelCompiler() })
    await teachExecutor.run({ nodes: [{ id: 'teach', kind: 'instruction', description: 'ADD RAX, RBX' }] })

    // A second executor with NO metaKernel option at all (or a fresh one) must NOT bypass -
    // it needs a real LLM response for the "SUB" failure, which this scripted client doesn't have,
    // so a missing response would throw if a bypass were (incorrectly) skipped.
    const isolatedLlm = new ScriptedByPromptLlmClient([['SUB RCX, RAX', 'SUB X2, X0, X2']])
    const isolatedExecutor = new TaskGraphExecutor({ llm: isolatedLlm })
    const result = await isolatedExecutor.run({ nodes: [{ id: 'no-bypass', kind: 'instruction', description: 'SUB RCX, RAX', maxRetries: 1 }] })

    // No meta-kernel at all means no bypass is even attempted - the LLM's
    // (wrong) answer is used as-is and fails real verification.
    expect(result.ok).toBe(false)
  }, 15000)
})

// ---------------------------------------------------------------------------
// Phase 15.1: 'brep' DAG nodes dispatch directly to BRepWorkerPoolEvaluator
// (real worker thread, real OpenCASCADE) - never through runCeilingAgent's
// own retry loop. Real worker_threads are spawned, so every pool created
// here MUST be shut down or the process hangs at exit.
// ---------------------------------------------------------------------------

const pools: BRepWorkerPoolEvaluator[] = []
function trackedBRepPool(...args: ConstructorParameters<typeof BRepWorkerPoolEvaluator>): BRepWorkerPoolEvaluator {
  const pool = new BRepWorkerPoolEvaluator(...args)
  pools.push(pool)
  return pool
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()))
})

const GOOD_BREP_CANDIDATE: BRepCandidate = {
  solid: { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] },
  boundingBox: { min: [-6, -6, -6], max: [6, 6, 6] },
}

const DEGENERATE_BREP_CANDIDATE: BRepCandidate = {
  solid: { type: 'sphere', center: [0, 0, 0], radius: -1 },
  boundingBox: { min: [-1, -1, -1], max: [1, 1, 1] },
}

describe('TaskGraphExecutor: Phase 15.1 - brep node dispatch to BRepWorkerPoolEvaluator', () => {
  test('run() throws immediately, before any LLM call, when a brep node is present but no brepPool is supplied', async () => {
    let llmCalled = false
    const llm: LlmClient = {
      async complete() {
        llmCalled = true
        return '{}'
      },
    }
    const executor = new TaskGraphExecutor({ llm })

    await expect(executor.run({ nodes: [{ id: 'shape', kind: 'brep', description: 'a box' }] })).rejects.toThrow(/brepPool/)
    expect(llmCalled).toBe(false)
  })

  test('a well-formed brep node succeeds via the real BRepWorkerPoolEvaluator - real worker thread, real OpenCASCADE, real gates', async () => {
    const llm = new OneShotLlmClient(JSON.stringify(GOOD_BREP_CANDIDATE))
    const brepPool = trackedBRepPool({ poolSize: 1 })
    const executor = new TaskGraphExecutor({ llm, brepPool })

    const result = await executor.run({ nodes: [{ id: 'shape', kind: 'brep', description: 'a solid box centered at the origin' }] })

    expect(result.ok).toBe(true)
    const node = result.nodes[0]
    expect(node.status).toBe('ok')
    expect(node.status === 'ok' && node.success.gates.map((g) => g.gate)).toEqual(['structural-validity', 'volumetric-bound', 'step-export'])
    expect(node.status === 'ok' && node.success.gates.every((g) => g.ok)).toBe(true)
  }, 15000)

  test('a degenerate brep candidate exhausts retries, demotes the node to failed, and skip-propagates to its dependent - never silently accepted', async () => {
    const llm = new OneShotLlmClient(JSON.stringify(DEGENERATE_BREP_CANDIDATE))
    const brepPool = trackedBRepPool({ poolSize: 1 })
    const executor = new TaskGraphExecutor({ llm, brepPool })

    const result = await executor.run({
      nodes: [
        { id: 'bad-shape', kind: 'brep', description: 'a degenerate sphere', maxRetries: 1 },
        { id: 'dependent', kind: 'brep', description: 'a degenerate sphere', dependsOn: ['bad-shape'] },
      ],
    })

    expect(result.ok).toBe(false)
    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n.status]))
    expect(byId).toEqual({ 'bad-shape': 'failed', dependent: 'skipped' })
  }, 15000)

  test('end to end: intent routing (Phase 13.4) classifies a brep-flavored request, which seeds a DAG node executed via the real worker-isolated BRepWorkerPoolEvaluator (Phase 15.0)', async () => {
    const rawInput = 'Propose a solid CAD B-Rep box for manufacturing, centered at the origin'
    const brepCandidateJson = JSON.stringify(GOOD_BREP_CANDIDATE)

    const llm = new ScriptedByPromptLlmClient([
      ['classifying a request', JSON.stringify({ kind: 'brep', description: 'a solid box centered at the origin', confidence: 'high' })],
      ['B-Rep (Boundary Representation)', brepCandidateJson],
    ])

    const classification = await classifyIntent(rawInput, llm)
    expect(classification.ok).toBe(true)
    expect(classification.ok && classification.request.kind).toBe('brep')
    if (!classification.ok) return // narrows for TS below; already asserted above

    const brepPool = trackedBRepPool({ poolSize: 1 })
    const executor = new TaskGraphExecutor({ llm, brepPool })
    const result = await executor.run({
      nodes: [{ id: 'classified-shape', kind: classification.request.kind, description: classification.request.description }],
    })

    expect(result.ok).toBe(true)
    const node = result.nodes[0]
    expect(node.status).toBe('ok')
    expect(node.status === 'ok' && JSON.parse(node.success.result)).toEqual(GOOD_BREP_CANDIDATE)
  }, 15000)
})

// ---------------------------------------------------------------------------
// Phase 18.0: caller-driven runtime node injection. injectNodes() is
// deliberately never called from anywhere in task-graph.ts itself - only
// from a caller-supplied onNodeSettled callback, or elsewhere in caller
// code while a run() is in flight. The system never decides on its own
// what to inject; that boundary is the whole point (see topologicalSort's
// own header comment, and injectNodes' own doc comment on why).
// ---------------------------------------------------------------------------

describe('TaskGraphExecutor: Phase 18.0 - caller-driven node injection', () => {
  test('a caller inspecting a real, genuine failure via onNodeSettled injects a resolver node, which runs to completion - while the already-completed parent is never re-evaluated', async () => {
    const llm = new ScriptedByPromptLlmClient([
      ['MOV RAX, RBX', 'MOV X0, X1'], // node A
      ['x86 instruction: ADD RAX, RBX', 'MOV X9, X9'], // node B - a genuinely incomplete ARM64 translation, always wrong
      ['MOV RCX, RDX', 'MOV X2, X3'], // the injected resolver node
    ])

    const executor = new TaskGraphExecutor({
      llm,
      onNodeSettled: (result) => {
        if (result.id === 'B' && result.status === 'failed') {
          executor.injectNodes([{ id: 'B-resolver', kind: 'instruction', description: 'MOV RCX, RDX', dependsOn: ['A'] }])
        }
      },
    })

    const result = await executor.run({
      nodes: [
        { id: 'A', kind: 'instruction', description: 'MOV RAX, RBX' },
        { id: 'B', kind: 'instruction', description: 'ADD RAX, RBX', dependsOn: ['A'], maxRetries: 1 },
      ],
    })

    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]))
    expect(byId.A.status).toBe('ok')
    expect(byId.B.status).toBe('failed')
    expect(byId['B-resolver']).toBeDefined()
    expect(byId['B-resolver'].status).toBe('ok')

    // The already-completed parent A is never touched again - same direct
    // proof Phase 17.0 established: exactly one LLM call for A, regardless
    // of B's failure or the later injection.
    expect(byId.A.status === 'ok' && byId.A.success.attempts).toBe(1)
    expect(llm.callCount).toBe(3) // A:1 + B:1 (maxRetries:1, exhausts immediately) + B-resolver:1

    // result.nodes is in topological order - the injected node appears
    // after its real dependency A, proving the topological queue was
    // genuinely recomputed, not just appended.
    expect(result.nodes.findIndex((n) => n.id === 'B-resolver')).toBeGreaterThan(result.nodes.findIndex((n) => n.id === 'A'))
  }, 15000)

  test('an invalid injection (a genuine cycle among the new nodes) throws CycleDetectedError immediately, and the live run is completely unaffected - fail-closed, zero partial state', async () => {
    const llm = new ScriptedByPromptLlmClient([['MOV RAX, RBX', 'MOV X0, X1']])
    let caught: unknown
    const executor = new TaskGraphExecutor({
      llm,
      onNodeSettled: (result) => {
        if (result.id === 'only' && result.status === 'ok') {
          try {
            executor.injectNodes([
              { id: 'X', kind: 'instruction', description: 'MOV RAX, RBX', dependsOn: ['Y'] },
              { id: 'Y', kind: 'instruction', description: 'MOV RAX, RBX', dependsOn: ['X'] },
            ])
          } catch (error) {
            caught = error
          }
        }
      },
    })

    const result = await executor.run({ nodes: [{ id: 'only', kind: 'instruction', description: 'MOV RAX, RBX' }] })

    expect(caught).toBeInstanceOf(CycleDetectedError)
    expect((caught as Error).message).toContain('cycle')
    // The run itself completes successfully - the rejected injection left
    // no trace at all, not even a partially-applied one.
    expect(result.ok).toBe(true)
    expect(result.nodes.map((n) => n.id)).toEqual(['only'])
  }, 15000)

  test('injectNodes() called outside an active run() throws immediately, never silently no-ops', () => {
    const executor = new TaskGraphExecutor({ llm: new ScriptedByPromptLlmClient([]) })
    expect(() => executor.injectNodes([{ id: 'late', kind: 'instruction', description: 'MOV RAX, RBX' }])).toThrow(/no active graph to extend/)
  })

  test('injecting a node whose id already exists in the run throws a clear, specific diagnostic', async () => {
    const llm = new ScriptedByPromptLlmClient([['MOV RAX, RBX', 'MOV X0, X1']])
    let caught: unknown
    const executor = new TaskGraphExecutor({
      llm,
      onNodeSettled: (result) => {
        if (result.id === 'A' && result.status === 'ok') {
          try {
            executor.injectNodes([{ id: 'A', kind: 'instruction', description: 'MOV RAX, RBX' }])
          } catch (error) {
            caught = error
          }
        }
      },
    })
    await executor.run({ nodes: [{ id: 'A', kind: 'instruction', description: 'MOV RAX, RBX' }] })
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('a node with id "A" already exists')
  }, 15000)

  test('the `dependencies` parameter appends extra dependency ids onto an injected node, without needing to bake them into the node object itself', async () => {
    const llm = new ScriptedByPromptLlmClient([
      ['MOV RAX, RBX', 'MOV X0, X1'], // A
      ['MOV RCX, RDX', 'MOV X2, X3'], // injected node, must wait for A
    ])
    let sawUpstream = ''
    const executor = new TaskGraphExecutor({
      llm,
      onNodeSettled: (result) => {
        if (result.id === 'A' && result.status === 'ok') {
          executor.injectNodes(
            [
              {
                id: 'depends-on-A-via-map',
                kind: 'instruction',
                description: (upstream) => {
                  sawUpstream = upstream.get('A')?.result ?? ''
                  return 'MOV RCX, RDX'
                },
              },
            ],
            new Map([['depends-on-A-via-map', ['A']]])
          )
        }
      },
    })

    const result = await executor.run({ nodes: [{ id: 'A', kind: 'instruction', description: 'MOV RAX, RBX' }] })
    expect(result.ok).toBe(true)
    expect(sawUpstream).toBe('MOV X0, X1') // proves the dependency wiring via the map genuinely took effect, not just a coincidence of ordering
  }, 15000)

  test('injecting a "brep" node without a configured brepPool throws the same real, fail-closed error the initial graph already enforces', async () => {
    const llm = new ScriptedByPromptLlmClient([['MOV RAX, RBX', 'MOV X0, X1']])
    let caught: unknown
    const executor = new TaskGraphExecutor({
      llm,
      onNodeSettled: (result) => {
        if (result.id === 'A' && result.status === 'ok') {
          try {
            executor.injectNodes([{ id: 'shape', kind: 'brep', description: 'a box' }])
          } catch (error) {
            caught = error
          }
        }
      },
    })
    await executor.run({ nodes: [{ id: 'A', kind: 'instruction', description: 'MOV RAX, RBX' }] })
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('brepPool')
  }, 15000)

  test('injecting an empty array is a safe no-op', async () => {
    const llm = new ScriptedByPromptLlmClient([['MOV RAX, RBX', 'MOV X0, X1']])
    const executor = new TaskGraphExecutor({
      llm,
      onNodeSettled: (result) => {
        if (result.id === 'A' && result.status === 'ok') {
          expect(() => executor.injectNodes([])).not.toThrow()
        }
      },
    })
    const result = await executor.run({ nodes: [{ id: 'A', kind: 'instruction', description: 'MOV RAX, RBX' }] })
    expect(result.ok).toBe(true)
    expect(result.nodes).toHaveLength(1)
  }, 15000)

  test('a SECOND round of injection, triggered by the first injected node settling, composes correctly - injection is not limited to a single round per run', async () => {
    const llm = new ScriptedByPromptLlmClient([
      ['MOV RAX, RBX', 'MOV X0, X1'], // A
      ['MOV RCX, RDX', 'MOV X2, X3'], // round-1 injected node
      ['MOV RDI, RSP', 'MOV X4, SP'], // round-2 injected node
    ])
    const settledIds: string[] = []
    const executor = new TaskGraphExecutor({
      llm,
      onNodeSettled: (result: TaskNodeResult) => {
        settledIds.push(result.id)
        if (result.id === 'A' && result.status === 'ok') {
          executor.injectNodes([{ id: 'round-1', kind: 'instruction', description: 'MOV RCX, RDX' }])
        }
        if (result.id === 'round-1' && result.status === 'ok') {
          executor.injectNodes([{ id: 'round-2', kind: 'instruction', description: 'MOV RDI, RSP' }])
        }
      },
    })

    const result = await executor.run({ nodes: [{ id: 'A', kind: 'instruction', description: 'MOV RAX, RBX' }] })
    expect(result.ok).toBe(true)
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['A', 'round-1', 'round-2'])
    expect(settledIds).toContain('round-2')
  }, 15000)
})
