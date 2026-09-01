import {
  runCeilingAgent,
  buildPrompt,
  stripJsonFences,
  CeilingAgentExhaustedError,
  MAX_RETRIES_DEFAULT,
  type CeilingRequestKind,
  type CeilingRequest,
  type CeilingAttempt,
  type CeilingSuccess,
  type GateCheckResult,
  type LlmClient,
  type BestOfNOptions,
} from '../CeilingAgent'
import type { MetaKernelCompiler } from '../layer5/meta-kernel'
import { runPeerReview, type PeerReviewResult } from './peer-review'
import type { BRepWorkerPoolEvaluator } from '../layer1/brep/brep-worker-pool'
import type { BRepCandidate } from '../layer1/brep/brep-floor'

// Phase 14.5.1: deterministic task decomposition - "deterministic" means
// exactly what it says: the DAG's STRUCTURE (which nodes exist, which
// depend on which) is caller-supplied and explicit, resolved by a real,
// pure topological sort. Nothing here asks an LLM to invent the plan -
// that would be genuine HTN-style autonomous planning, a materially
// different (non-deterministic, much harder to verify) capability this
// phase does not claim to provide. The LLM's role is unchanged from
// everywhere else in this project: generating ONE candidate per node,
// verified by the SAME unmodified runCeilingAgent/floor pipeline.
//
// Phase 14.5.2: MetaKernelCompiler already IS "cache, retrieve, and reuse
// past verified fixes" - that has been its whole job since Phase 10,
// hardened with LRU eviction in Phase 13.1. There is no new caching logic
// to add here. TaskGraphExecutorOptions.metaKernel threads ONE shared
// instance across every node in a run, so a rule learned fixing node A's
// failure is immediately available to node B if it fails the same way -
// exactly runCeilingAgent's existing, already-tested behavior, now applied
// across a whole graph instead of one isolated call. Reuse is PROVEN, not
// asserted, via the existing Phase 11.4 resolvedLayer field
// (formatResponse: true) - see task-graph.test.ts.

export interface TaskNode {
  id: string
  kind: CeilingRequestKind
  /** A fixed description, or a function of already-completed upstream
   *  dependencies' REAL verified results - lets a downstream node
   *  reference what an upstream node actually produced (e.g. embed a
   *  produced instruction/module's real text) rather than guessing it
   *  ahead of time. Only ever called with dependencies this node declared
   *  via `dependsOn` - never dependencies of dependencies. */
  description: string | ((upstream: ReadonlyMap<string, CeilingSuccess>) => string)
  /** ids of TaskNodes in the same graph that must complete successfully first. */
  dependsOn?: string[]
  maxRetries?: number
  bestOfN?: BestOfNOptions
}

export interface TaskGraph {
  nodes: TaskNode[]
}

export interface TaskGraphExecutorOptions {
  llm: LlmClient
  /** Shared across every node in a run - the real Phase 14.5.2 wiring. Omit for a run with no cross-node rule learning/reuse at all. */
  metaKernel?: MetaKernelCompiler
  /** Threaded into every node's runCeilingAgent call, so each result's `formatted.summary.resolvedLayer` can prove whether a meta-kernel bypass genuinely fired for that node. Default false, matching runCeilingAgent's own default. */
  formatResponse?: boolean
  /** Phase 14.5.3: when true, every node's verified result is additionally
   *  peer-reviewed (see ./peer-review.ts) - deterministic QA + Security,
   *  advisory-only Architect. A genuine QA/Security finding demotes an
   *  otherwise-'ok' node to 'failed' (its output is untrustworthy, so
   *  dependents are skipped exactly as on any other failure); Architect's
   *  commentary is attached for visibility only and can never do that.
   *  Default false. */
  peerReview?: boolean
  /** Phase 15.1: required if the graph contains any 'brep' node. BRep nodes
   *  never go through runCeilingAgent's own retry loop or the general
   *  bestOfN.workerPool mechanism (BRepWorkerPoolEvaluator doesn't
   *  structurally satisfy WorkerPoolLike - see brep-worker-pool.ts) - they
   *  have their own dedicated, worker-isolated dispatch (runBRepNode
   *  below), deliberately so a multi-node DAG run never pays OpenCASCADE's
   *  ~600ms/~450-500MB cost in-process. Validated up front in run(): a
   *  graph with a 'brep' node and no pool fails immediately, before any
   *  LLM call is made for ANY node, rather than burning real work first. */
  brepPool?: BRepWorkerPoolEvaluator
}

export type TaskNodeResult =
  | { id: string; status: 'ok'; success: CeilingSuccess; review?: PeerReviewResult }
  | { id: string; status: 'failed'; error: string; review?: PeerReviewResult }
  /** Never attempted - a declared dependency failed or was itself skipped. Propagates transitively down the graph. */
  | { id: string; status: 'skipped' }

export interface TaskGraphResult {
  ok: boolean
  /** In topological order (a dependency always precedes its dependents), regardless of the concurrent order nodes actually ran in. */
  nodes: TaskNodeResult[]
}

// ---------------------------------------------------------------------------
// topologicalSort: pure, synchronous, no LLM or I/O involved - independently
// unit-tested. Real cycle/unknown-dependency detection, never silently
// dropped or guessed at.
// ---------------------------------------------------------------------------

export function topologicalSort(nodes: TaskNode[]): TaskNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!byId.has(dep)) throw new Error(`task "${node.id}" depends on unknown task "${dep}"`)
    }
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  const order: TaskNode[] = []

  function visit(node: TaskNode): void {
    if (visited.has(node.id)) return
    if (visiting.has(node.id)) throw new Error(`task graph has a cycle involving "${node.id}"`)
    visiting.add(node.id)
    for (const depId of node.dependsOn ?? []) {
      visit(byId.get(depId)!)
    }
    visiting.delete(node.id)
    visited.add(node.id)
    order.push(node)
  }

  for (const node of nodes) visit(node)
  return order
}

// ---------------------------------------------------------------------------
// Phase 15.1: 'brep' node dispatch - a self-contained mirror of
// runCeilingAgent's retry-with-feedback loop (same buildPrompt/
// stripJsonFences helpers, same CeilingAttempt/CeilingSuccess shapes, so
// the rest of TaskGraphExecutor's bookkeeping - completed/results/peer
// review - is unaffected by which path produced a node's success), but
// verifying through BRepWorkerPoolEvaluator's real, worker-isolated
// OpenCASCADE kernel instead of an in-process floor call. Deliberately
// NOT integrated with MetaKernelCompiler bypass/formatResponse - both are
// real Phase 10/11 machinery scoped to runCeilingAgent's own loop, and
// wiring brep into them (a materially different failure-pattern shape
// from the four existing domains) is real, separate work this change
// does not claim to do.
// ---------------------------------------------------------------------------

const BREP_FALLBACK_GATE_NAME = 'structural-validity'

async function runBRepNode(description: string, llm: LlmClient, brepPool: BRepWorkerPoolEvaluator, maxRetries: number): Promise<CeilingSuccess> {
  const request: CeilingRequest = { kind: 'brep', description }
  const history: CeilingAttempt[] = []

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const candidateText = await llm.complete(buildPrompt(request, history))
    let gates: GateCheckResult[]
    try {
      const candidate = JSON.parse(stripJsonFences(candidateText)) as BRepCandidate
      gates = await brepPool.verify({ domain: 'brep', candidate }, async () => {
        throw new Error('the B-Rep worker pool is unavailable - there is no in-process fallback for a DAG-dispatched brep node')
      })
    } catch (error) {
      gates = [{ gate: BREP_FALLBACK_GATE_NAME, ok: false, details: `candidate could not be verified: ${error instanceof Error ? error.message : String(error)}` }]
    }

    const failedGate = gates.find((g) => !g.ok)
    if (!failedGate) {
      return { ok: true, result: candidateText, attempts: attempt, gates, history: [...history] }
    }
    history.push({ attempt, candidate: candidateText, failedGate })
  }

  throw new CeilingAgentExhaustedError({ request, attempts: maxRetries, history })
}

// ---------------------------------------------------------------------------
// TaskGraphExecutor
// ---------------------------------------------------------------------------

export class TaskGraphExecutor {
  constructor(private readonly options: TaskGraphExecutorOptions) {}

  /**
   * Runs every node in dependency order, executing all nodes whose
   * dependencies are already resolved CONCURRENTLY (a real DAG, not a
   * forced sequential chain) - safe because MetaKernelCompiler's Map-based
   * state can't tear under JS's single-threaded async interleaving, and
   * because each node's own runCeilingAgent call is already independently
   * safe to run concurrently (proven in Phase 13.4's integration tests).
   * A node whose dependency failed or was skipped is itself marked
   * skipped, never attempted - failure propagates down the graph, it
   * never silently proceeds with missing upstream data.
   */
  async run(graph: TaskGraph): Promise<TaskGraphResult> {
    const order = topologicalSort(graph.nodes) // validates the graph (cycles, unknown deps) up front, before any node runs
    if (order.some((node) => node.kind === 'brep') && !this.options.brepPool) {
      throw new Error(
        'this task graph has one or more "brep" nodes, but no TaskGraphExecutorOptions.brepPool was supplied - ' +
          'see BRepWorkerPoolEvaluator (src/layer1/brep/brep-worker-pool.ts)'
      )
    }

    const completed = new Map<string, CeilingSuccess>()
    const unrunnable = new Set<string>()
    const results = new Map<string, TaskNodeResult>()
    const remaining = new Set(order.map((node) => node.id))

    while (remaining.size > 0) {
      const ready = order.filter((node) => remaining.has(node.id) && (node.dependsOn ?? []).every((dep) => !remaining.has(dep)))
      // `ready` is guaranteed non-empty here: topologicalSort already
      // proved the graph is acyclic, so at least one remaining node's
      // dependencies are all already resolved (completed or unrunnable).
      await Promise.all(ready.map((node) => this.runNode(node, completed, unrunnable, results)))
      for (const node of ready) remaining.delete(node.id)
    }

    const orderedResults = order.map((node) => results.get(node.id)!)
    return { ok: orderedResults.every((r) => r.status === 'ok'), nodes: orderedResults }
  }

  private async runNode(node: TaskNode, completed: Map<string, CeilingSuccess>, unrunnable: Set<string>, results: Map<string, TaskNodeResult>): Promise<void> {
    if ((node.dependsOn ?? []).some((dep) => unrunnable.has(dep))) {
      unrunnable.add(node.id)
      results.set(node.id, { id: node.id, status: 'skipped' })
      return
    }

    const description = typeof node.description === 'function' ? node.description(completed) : node.description
    const request = { kind: node.kind, description }
    try {
      const success =
        node.kind === 'brep'
          ? await runBRepNode(description, this.options.llm, this.options.brepPool!, node.maxRetries ?? MAX_RETRIES_DEFAULT)
          : await runCeilingAgent(request, this.options.llm, {
              maxRetries: node.maxRetries,
              bestOfN: node.bestOfN,
              metaKernel: this.options.metaKernel,
              formatResponse: this.options.formatResponse,
            })

      if (this.options.peerReview) {
        const review = await runPeerReview(request, success, { llm: this.options.llm })
        if (!review.ok) {
          unrunnable.add(node.id)
          const findings = [...review.qa.findings.map((f) => f.description), ...review.security.findings]
          results.set(node.id, { id: node.id, status: 'failed', error: `peer review rejected the candidate: ${findings.join('; ')}`, review })
          return
        }
        completed.set(node.id, success)
        results.set(node.id, { id: node.id, status: 'ok', success, review })
        return
      }

      completed.set(node.id, success)
      results.set(node.id, { id: node.id, status: 'ok', success })
    } catch (error) {
      unrunnable.add(node.id)
      results.set(node.id, { id: node.id, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
}
