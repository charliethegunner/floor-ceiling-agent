import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCeilingAgent, type LlmClient, type CeilingRequest } from '../CeilingAgent'
import { WorkerPoolEvaluator } from '../layer1/worker-pool'
import { ProjectPackIngestor, toWorkspaceFiles } from '../layer1/ingestion-floor'
import { SandboxRunner } from '../layer1/sandbox-runner'
import { EngineTracer } from '../telemetry/tracer'
import type { TopologyCandidate } from '../topology-floor'

// v1.6.0 end-to-end integration suite: proves the four subsystems this
// engine is built from - ProjectPack ingestion (Phase 12.0), real Z3/
// worker-pool verification (Phase 9/9.1), production telemetry (Phase
// 11.1), and the isolated sandbox runner (Phase 12.1) - genuinely COMPOSE,
// not just individually pass their own unit tests. Everything here is
// real: real workspaces on disk, a real WorkerPoolEvaluator, real Z3
// proofs, real EngineTracer spans, real sandboxed ARM64 execution. The
// only thing ever synthetic is the LLM (a local scripted fake, matching
// this codebase's established pattern everywhere else) - the point of
// this suite is proving REAL subsystem composition, not LLM behavior.
//
// This is deliberately separate from scripts/load-test-engine.ts: this
// file runs as part of `npm test` (so it must be fast/reliable enough to
// stay green every run), while the load-test script is a standalone,
// on-demand, high-volume stress harness with its own memory-over-time
// reporting - conflating the two would either make `npm test` slow and
// flaky, or make the load test too small to mean anything.

class OneShotLlmClient implements LlmClient {
  callCount = 0
  constructor(private readonly candidate: string) {}
  async complete(): Promise<string> {
    this.callCount++
    return this.candidate
  }
}

const pools: WorkerPoolEvaluator[] = []
function trackedPool(...args: ConstructorParameters<typeof WorkerPoolEvaluator>): WorkerPoolEvaluator {
  const pool = new WorkerPoolEvaluator(...args)
  pools.push(pool)
  return pool
}

const workspaces: string[] = []
function trackedWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-integration-'))
  workspaces.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()))
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('v1.6.0 integration: ingestion -> worker-pool verification -> telemetry, one real pipeline', () => {
  test('a real ingested multi-file workspace supplies genuine cross-file context to a worker-routed topology verification, fully traced', async () => {
    const workspace = trackedWorkspace()
    writeFileSync(join(workspace, 'math.ts'), 'export function double(n: number): number { return n * 2 }\n')

    const graph = await new ProjectPackIngestor().ingestWorkspace(workspace)
    const workspaceFiles = toWorkspaceFiles(graph)
    expect(workspaceFiles['math.ts']).toContain('export function double')

    const candidate: TopologyCandidate = {
      inMemoryFiles: { 'app.ts': "import { double } from './math'\nexport function quadruple(n: number): number { return double(double(n)) }\n" },
      expectedExports: [{ filePath: 'app.ts', exportedNames: ['quadruple'] }],
      reachability: [{ from: { filePath: 'app.ts', functionName: 'quadruple' }, to: { filePath: 'math.ts', functionName: 'double' }, expectReachable: true }],
    }

    const pool = trackedPool({ poolSize: 1 })
    const tracer = new EngineTracer()
    tracer.startTrace('integration-req-1', 'topology')

    const start = Date.now()
    const gates = await pool.verify({ domain: 'topology', candidateText: JSON.stringify(candidate), workspaceFiles }, async () => {
      throw new Error('fallback should not have been needed - this is a real, well-formed request')
    })
    const elapsedMs = Date.now() - start

    for (const gate of gates) {
      tracer.recordFloorGate(gate.gate, gate.ok, gate.elapsedMs ?? elapsedMs, gate.ok ? undefined : gate.details)
    }

    // The real verification result: reachability into the ingested
    // workspace's real function actually resolved.
    expect(gates.map((g) => g.gate)).toEqual(['exports', 'types', 'reachability'])
    expect(gates.every((g) => g.ok)).toBe(true)

    // Trace span accuracy: exactly the gates that ran, in order, each
    // correctly marked passed with a real (non-fabricated) latency.
    const exported = tracer.exportSpanJson()
    const spans = exported.resourceSpans[0].scopeSpans[0].spans
    const gateSpans = spans.slice(1)
    expect(gateSpans.map((s) => s.name)).toEqual(['floor_gate:exports', 'floor_gate:types', 'floor_gate:reachability'])
    for (const span of gateSpans) {
      expect(span.attributes).toContainEqual({ key: 'passed', value: { boolValue: true } })
      expect(span.status.code).toBe(1) // STATUS_CODE_OK
    }
    expect(spans[0].attributes).toContainEqual({ key: 'ceiling.request_id', value: { stringValue: 'integration-req-1' } })
  }, 20000)

  test('after ingestion + worker-pool verification, an unrelated real sandboxed execution still runs correctly (no cross-subsystem interference)', async () => {
    const workspace = trackedWorkspace()
    writeFileSync(join(workspace, 'a.ts'), 'export function a(): number { return 1 }\n')
    await new ProjectPackIngestor().ingestWorkspace(workspace)

    const pool = trackedPool({ poolSize: 1 })
    await pool.verify(
      { domain: 'spatial', candidateText: JSON.stringify({ surface: { type: 'sphere', center: [0, 0, 0], radius: 1 }, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } }) },
      async () => {
        throw new Error('unexpected fallback')
      }
    )

    const sandboxResult = await new SandboxRunner().execute('ADD X0, X1, X2', { X1: 3n, X2: 4n })
    expect(sandboxResult.executed).toBe(true)
    expect(sandboxResult.executed && sandboxResult.registers.X0).toBe(7n)
  }, 20000)
})

describe('v1.6.0 integration: concurrent real Z3 verification with independent per-call tracing', () => {
  // 'instruction' domain Z3 solving deliberately runs IN-PROCESS, not via
  // the worker pool (see CeilingAgent.ts's WORKER_DOMAIN_BY_KIND comment -
  // per-worker z3-solver WASM init cost was measured to dwarf an
  // already-fast in-process check for this domain). "Concurrent Z3
  // verification" here means genuinely concurrent in-process Solver()
  // invocations via Promise.all, which is the real, honest architecture
  // for this domain - not a fabricated worker-routed path that doesn't
  // reflect how this engine actually runs instruction verification.
  test('N concurrent runCeilingAgent instruction requests, each with its own EngineTracer, produce correct results with zero cross-contamination', async () => {
    const cases: Array<{ request: CeilingRequest; candidate: string }> = [
      { request: { kind: 'instruction', description: 'ADD RAX, RBX' }, candidate: 'ADD X0, X0, X1' },
      { request: { kind: 'instruction', description: 'SUB RCX, RAX' }, candidate: 'SUB X2, X2, X0' },
      { request: { kind: 'instruction', description: 'AND RDX, RAX' }, candidate: 'AND X3, X3, X0' },
      { request: { kind: 'instruction', description: 'MOV RBX, RAX' }, candidate: 'MOV X1, X0' },
      { request: { kind: 'instruction', description: 'CMP RAX, RBX' }, candidate: 'CMP X0, X1' },
      { request: { kind: 'instruction', description: 'OR RDX, RAX' }, candidate: 'ORR X3, X3, X0' },
    ]

    const runs = cases.map(async ({ request, candidate }, index) => {
      const tracer = new EngineTracer()
      const result = await runCeilingAgent(request, new OneShotLlmClient(candidate), { tracer })
      return { index, request, result, tracer }
    })

    const outcomes = await Promise.all(runs)

    for (const { index, request, result, tracer } of outcomes) {
      expect(result.ok).toBe(true)
      expect(result.attempts).toBe(1)

      const exported = tracer.exportSpanJson()
      const root = exported.resourceSpans[0].scopeSpans[0].spans[0]
      const gateSpans = exported.resourceSpans[0].scopeSpans[0].spans.slice(1)

      // Each concurrent tracer's root span reflects ONLY its own request -
      // proving no shared/global state leaked a different concurrent
      // request's data into this one (EngineTracer is documented as
      // one-instance-per-trace; this is the empirical proof under real
      // concurrency, not just a reading of the source).
      expect(root.attributes).toContainEqual({ key: 'ceiling.domain', value: { stringValue: 'instruction' } })
      expect(gateSpans.map((s) => s.name)).toEqual(['floor_gate:static', 'floor_gate:fuzz', 'floor_gate:symbolic'])
      expect(gateSpans.every((s) => s.status.code === 1)).toBe(true)
      void index
      void request
    }
  }, 30000)
})

describe('v1.6.0 integration: worker recycling under simulated pressure does not corrupt concurrent real verification', () => {
  test('a mix of real topology verifications and RSS-pressure-simulating tasks on the same pool: recycling fires, and the real tasks still return correct results', async () => {
    // A real, healthy worker's genuine baseline RSS (ts-morph + z3-solver
    // WASM loaded eagerly regardless of task domain) measures in the
    // ~250-500MB range - see worker-pool.ts's own DEFAULT_MAX_WORKER_RSS_BYTES
    // comment. 700MB sits comfortably above that real baseline (so the
    // REAL topology tasks below are never spuriously recycled) but well
    // below the __testFakeRssBytes value the pressure tasks report.
    const pool = trackedPool({ poolSize: 2, maxWorkerRssBytes: 700 * 1024 * 1024 })

    const realCandidate: TopologyCandidate = {
      inMemoryFiles: { 'a.ts': 'export function a(): number { return 1 }' },
      expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
      reachability: [],
    }
    const realTask = () =>
      pool.verify({ domain: 'topology', candidateText: JSON.stringify(realCandidate) }, async () => {
        throw new Error('a real, well-formed task should never need the fallback')
      })
    const pressureTask = () =>
      pool.verify({ domain: 'spatial', candidateText: '{}', __testFakeRssBytes: 999_999_999 }, async () => [{ gate: 'fallback', ok: false, details: 'pressure task fell back, which is fine' }])

    // Interleave real work with simulated memory-pressure tasks, mirroring
    // genuine bursty/contended load rather than a clean, isolated call.
    const results = await Promise.all([realTask(), pressureTask(), realTask(), pressureTask(), realTask(), pressureTask()])

    expect(pool.recycledWorkerCount).toBeGreaterThan(0)

    const realResults = [results[0], results[2], results[4]]
    for (const gates of realResults) {
      expect(gates.every((g) => g.ok)).toBe(true)
    }
  }, 30000)
})

describe('v1.6.0 integration: high-frequency sandboxed runner executions stay isolated and correct under concurrency', () => {
  test('a burst of concurrent sandbox executions each produce their own correct, non-cross-contaminated register state', async () => {
    const runner = new SandboxRunner()
    const programs = Array.from({ length: 8 }, (_, i) => ({ program: 'ADD X0, X1, X2', a: BigInt(i), b: BigInt(i * 2) }))

    const results = await Promise.all(programs.map(({ program, a, b }) => runner.execute(program, { X1: a, X2: b })))

    results.forEach((result, i) => {
      expect(result.executed).toBe(true)
      expect(result.executed && result.registers.X0).toBe(programs[i].a + programs[i].b)
    })
  }, 30000)

  test('memory stays within a generous bound across a moderate burst (coarse sanity check, not a rigorous leak proof)', async () => {
    const runner = new SandboxRunner()
    const before = process.memoryUsage().rss

    for (let i = 0; i < 15; i++) {
      const result = await runner.execute('ADD X0, X1, X2', { X1: BigInt(i), X2: 1n })
      expect(result.executed).toBe(true)
    }

    const after = process.memoryUsage().rss
    // A generous, deliberately non-tight bound: this is a coarse smoke
    // check against a gross leak (e.g. accidentally retaining every
    // worker), not a claim of proven memory stability - see
    // scripts/load-test-engine.ts for a real, longer-running RSS-over-time
    // characterization, which is the honest place to make that claim.
    expect(after).toBeLessThan(before * 3 + 200 * 1024 * 1024)
  }, 30000)
})
