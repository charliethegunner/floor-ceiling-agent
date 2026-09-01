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
  /** Phase 18.0: called after EVERY node settles (ok, failed, or skipped),
   *  before the executor decides what's ready to run next - the caller's
   *  one chance per node to inspect the real result and call
   *  injectNodes() to extend the graph, so newly added nodes participate
   *  in the SAME run rather than needing a separate one. Callbacks run
   *  sequentially (never concurrently with each other), so two callbacks
   *  in the same ready-batch never race to mutate the graph - the second
   *  one sees whatever the first already injected. injectNodes() itself
   *  is deliberately caller-driven, never invoked by this file - the
   *  executor never decides on its own what to inject (see
   *  topologicalSort's own header comment on why that boundary matters). */
  onNodeSettled?: (result: TaskNodeResult, completed: ReadonlyMap<string, CeilingSuccess>) => void | Promise<void>
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

/** Phase 18.0: thrown specifically for a genuine cycle detected while
 *  injecting nodes into an already-running graph (never for the OTHER
 *  real failure topologicalSort can report - an unknown dependency id -
 *  which stays a plain Error, so this name means exactly what it says). */
export class CycleDetectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CycleDetectedError'
  }
}

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

interface ActiveRunState {
  order: TaskNode[]
  byId: Map<string, TaskNode>
  completed: Map<string, CeilingSuccess>
  unrunnable: Set<string>
  results: Map<string, TaskNodeResult>
  remaining: Set<string>
}

function requireBRepPoolIfNeeded(nodes: readonly TaskNode[], brepPool: BRepWorkerPoolEvaluator | undefined): void {
  if (nodes.some((node) => node.kind === 'brep') && !brepPool) {
    throw new Error(
      'this task graph has one or more "brep" nodes, but no TaskGraphExecutorOptions.brepPool was supplied - ' +
        'see BRepWorkerPoolEvaluator (src/layer1/brep/brep-worker-pool.ts)'
    )
  }
}

export class TaskGraphExecutor {
  private activeRun: ActiveRunState | null = null

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
   *
   * Phase 18.0: the run's live state (order/completed/remaining/etc.) is
   * held on `this.activeRun` for the duration of this call specifically so
   * injectNodes() - called from an onNodeSettled callback, or from
   * anywhere else while this run is in flight - can extend it. Only one
   * run() may be active on a given executor instance at a time; a second,
   * concurrent run() on the SAME instance would mean two callers racing
   * to inject into the same graph, which has no well-defined meaning.
   */
  async run(graph: TaskGraph): Promise<TaskGraphResult> {
    if (this.activeRun) {
      throw new Error('this TaskGraphExecutor already has a run() in progress - use a separate instance for a concurrent run')
    }

    const order = topologicalSort(graph.nodes) // validates the graph (cycles, unknown deps) up front, before any node runs
    requireBRepPoolIfNeeded(order, this.options.brepPool)

    this.activeRun = {
      order,
      byId: new Map(order.map((node) => [node.id, node])),
      completed: new Map<string, CeilingSuccess>(),
      unrunnable: new Set<string>(),
      results: new Map<string, TaskNodeResult>(),
      remaining: new Set(order.map((node) => node.id)),
    }

    try {
      while (this.activeRun.remaining.size > 0) {
        const state = this.activeRun
        const ready = state.order.filter((node) => state.remaining.has(node.id) && (node.dependsOn ?? []).every((dep) => !state.remaining.has(dep)))
        // `ready` is guaranteed non-empty here: topologicalSort already
        // proved the graph is acyclic (both the original graph and every
        // injectNodes() extension re-validate this the same way), so at
        // least one remaining node's dependencies are all already
        // resolved (completed or unrunnable).
        await Promise.all(ready.map((node) => this.runNode(node, state.completed, state.unrunnable, state.results)))
        for (const node of ready) state.remaining.delete(node.id)

        if (this.options.onNodeSettled) {
          // Sequential, deliberately - see this option's own doc comment
          // for why two callbacks in the same batch must never race.
          for (const node of ready) {
            await this.options.onNodeSettled(state.results.get(node.id)!, state.completed)
          }
        }
      }

      const finalState = this.activeRun
      const orderedResults = finalState.order.map((node) => finalState.results.get(node.id)!)
      return { ok: orderedResults.every((r) => r.status === 'ok'), nodes: orderedResults }
    } finally {
      this.activeRun = null
    }
  }

  /**
   * Extends the CURRENTLY RUNNING graph with new nodes - only valid while
   * a run() is in flight (typically called from an onNodeSettled
   * callback). Purely caller-driven: the new nodes' kind/description/
   * dependencies come entirely from the caller, never invented by this
   * method or by anything it calls - the same deterministic-structure
   * boundary the rest of this file holds (see topologicalSort's header
   * comment). `dependencies` is an additive convenience - it APPENDS extra
   * dependency ids onto whatever a node's own `dependsOn` already lists,
   * for wiring a reusable node definition onto a specific already-running
   * graph without having to bake the dependency into the node object
   * itself.
   *
   * Re-validates the WHOLE expanded graph (cycles, unknown deps) before
   * committing anything - an invalid injection throws and leaves the live
   * run's state completely untouched, never partially applied.
   */
  injectNodes(newNodes: TaskNode[], dependencies?: Map<string, string[]>): void {
    const state = this.activeRun
    if (!state) {
      throw new Error('injectNodes() can only be called while a run() is in progress - there is no active graph to extend')
    }
    if (newNodes.length === 0) return

    for (const node of newNodes) {
      if (state.byId.has(node.id)) {
        throw new Error(`injectNodes: a node with id "${node.id}" already exists in this run`)
      }
    }

    const nodesToInject = newNodes.map((node) => {
      const extraDeps = dependencies?.get(node.id)
      return extraDeps && extraDeps.length > 0 ? { ...node, dependsOn: [...(node.dependsOn ?? []), ...extraDeps] } : node
    })

    const combinedNodes = [...state.order, ...nodesToInject]
    let newOrder: TaskNode[]
    try {
      newOrder = topologicalSort(combinedNodes)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Only a genuine cycle gets the named error - an unknown-dependency
      // id (a different, real mistake) stays a plain Error, so
      // CycleDetectedError never means something other than its name.
      if (message.includes('cycle')) throw new CycleDetectedError(message)
      throw error
    }

    requireBRepPoolIfNeeded(nodesToInject, this.options.brepPool)

    // Nothing above mutated `state` - only commit once every check passed,
    // so a rejected injection leaves the live run exactly as it was.
    state.order = newOrder
    for (const node of nodesToInject) {
      state.byId.set(node.id, node)
      state.remaining.add(node.id)
    }
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
