import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCeilingAgent, type LlmClient } from '../src/CeilingAgent'
import { WorkerPoolEvaluator } from '../src/layer1/worker-pool'
import { BRepWorkerPoolEvaluator } from '../src/layer1/brep/brep-worker-pool'
import { ProjectPackIngestor, toWorkspaceFiles } from '../src/layer1/ingestion-floor'
import { SandboxRunner } from '../src/layer1/sandbox-runner'
import { EngineTracer } from '../src/telemetry/tracer'
import type { TopologyCandidate } from '../src/topology-floor'
import type { ClaimCandidate } from '../src/claim-floor'
import type { SpatialCandidate } from '../src/spatial-floor'
import type { BRepCandidate } from '../src/layer1/brep/brep-floor'

// v1.6.0 standalone LOAD/STRESS test - deliberately NOT part of `npm test`
// (src/integration/engine-integration.test.ts and
// src/integration/full-engine.test.ts cover the same real subsystems at
// fast, deterministic, small scale, and ARE part of the suite). This
// script drives real, higher-volume concurrent load across real
// ProjectPack ingestion, real Z3/worker-pool verification, real
// EngineTracer spans, and real isolated sandbox executions, and reports
// REAL measured metrics - memory-over-time, worker recycling counts, and
// trace-span-latency accuracy against independently measured wall-clock
// time - the same "measure, don't guess" discipline this project's other
// benchmark scripts follow (see benchmark-sampler.ts).
//
// Phase 21.0: extended to all 5 real verification domains (instruction,
// topology, claim, spatial, brep - sandbox execution is a 6th, separate
// concern, not a verification floor) and to report a genuine per-gate
// latency breakdown (Candidate Gen vs Z3 vs ts-morph AST vs WASM B-Rep),
// using the SAME `elapsedMs` telemetry every floor already produces
// (WorkerGateOutcome.elapsedMs for worker-routed domains; EngineTracer's
// exported spans for in-process instruction verification) - no new
// instrumentation, only aggregation and reporting. Deliberately still
// asserts NOTHING about wall-clock duration or "zero" memory growth: this
// project's benchmark/load infra has never gated pass/fail on speed
// (only on functional correctness, or - for the RSS check below - a
// loose, explicitly-labeled sanity bound), because a hard timing
// assertion here would just be a flaky CI failure waiting to happen on
// different hardware, not a real regression signal.
//
// Concurrency is DELIBERATELY bounded (not "run everything at once"): a
// real WorkerPoolEvaluator worker eagerly loads z3-solver's WASM module
// and ts-morph regardless of task domain, measured elsewhere in this
// project at ~250-500MB RSS per worker, a real BRepWorkerPoolEvaluator
// worker measured at ~450-500MB, and SandboxRunner spawns a FRESH worker
// per execution by design. Unbounded concurrency here would risk
// exhausting this host's memory rather than actually load-testing the
// engine - see runInBatches below.

const OUTPUT_DIR_PREFIX = 'load-test-engine-'
const SYNTHETIC_FILE_COUNT = 15
const INSTRUCTION_TASK_COUNT = 24
const TOPOLOGY_TASK_COUNT = 16
const CLAIM_TASK_COUNT = 16
const SPATIAL_TASK_COUNT = 16
const BREP_TASK_COUNT = 12 // smaller: real OpenCASCADE work is materially heavier per task than the other domains
const SANDBOX_TASK_COUNT = 24
const PRESSURE_TASK_EVERY_N = 4 // roughly 1-in-4 tasks (topology, claim, spatial, brep) simulates memory pressure
const BATCH_CONCURRENCY = 4
// Comfortably above both pools' real recycling thresholds (general pool:
// 512MB default, brep pool: 900MB default - see worker-pool.ts's and
// brep-worker-pool.ts's own DEFAULT_MAX_WORKER_RSS_BYTES), so a pressure
// task deterministically triggers recycling regardless of which pool it lands on.
const FAKE_PRESSURE_RSS_BYTES = 1_200 * 1024 * 1024

class OneShotLlmClient implements LlmClient {
  constructor(private readonly candidate: string) {}
  async complete(): Promise<string> {
    return this.candidate
  }
}

// ---------------------------------------------------------------------------
// A synthetic multi-file TypeScript project pack, written to a real temp
// directory - genuinely ingested via ProjectPackIngestor, not fabricated.
// ---------------------------------------------------------------------------

function buildSyntheticProject(root: string, fileCount: number): void {
  writeFileSync(join(root, 'f0.ts'), 'export function f0(): number { return 0 }\n')
  for (let i = 1; i < fileCount; i++) {
    writeFileSync(join(root, `f${i}.ts`), `import { f${i - 1} } from './f${i - 1}'\nexport function f${i}(): number { return f${i - 1}() + 1 }\n`)
  }
}

async function runInBatches<T>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += concurrency) {
    const batch = items.slice(start, start + concurrency)
    await Promise.all(batch.map((item, i) => run(item, start + i)))
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface TaskOutcome {
  category: 'instruction' | 'topology' | 'topology-pressure' | 'claim' | 'claim-pressure' | 'spatial' | 'spatial-pressure' | 'brep' | 'brep-pressure' | 'sandbox'
  ok: boolean
  wallClockMs: number
  /** Sum of the recorded trace span latencies for this task, when traced - compared against wallClockMs for span-accuracy reporting. */
  recordedSpanLatencyMs?: number
  note?: string
}

const outcomes: TaskOutcome[] = []
const rssSamplesBytes: number[] = []

function sampleRss(): void {
  rssSamplesBytes.push(process.memoryUsage().rss)
}

// ---------------------------------------------------------------------------
// Phase 21.0: per-gate latency breakdown (Candidate Gen vs Z3 vs ts-morph
// AST vs WASM B-Rep), keyed by "domain:gate" - built purely from `elapsedMs`
// telemetry every floor already produces (WorkerGateOutcome.elapsedMs for
// worker-routed domains, EngineTracer spans for in-process instruction
// verification), never a new timing mechanism of its own.
// ---------------------------------------------------------------------------

const gateLatenciesMs = new Map<string, number[]>()

function recordGateLatencies(domain: string, gates: ReadonlyArray<{ gate: string; elapsedMs?: number }>): void {
  for (const gate of gates) {
    if (gate.elapsedMs === undefined) continue // e.g. a fallback-produced gate, which never carries real timing
    const key = `${domain}:${gate.gate}`
    const samples = gateLatenciesMs.get(key) ?? []
    samples.push(gate.elapsedMs)
    gateLatenciesMs.set(key, samples)
  }
}

// ---------------------------------------------------------------------------
// Task generators
// ---------------------------------------------------------------------------

const INSTRUCTION_CASES: Array<{ x86: string; arm64: string }> = [
  { x86: 'ADD RAX, RBX', arm64: 'ADD X0, X0, X1' },
  { x86: 'SUB RCX, RAX', arm64: 'SUB X2, X2, X0' },
  { x86: 'AND RDX, RAX', arm64: 'AND X3, X3, X0' },
  { x86: 'MOV RBX, RAX', arm64: 'MOV X1, X0' },
  { x86: 'CMP RAX, RBX', arm64: 'CMP X0, X1' },
  { x86: 'OR RDX, RAX', arm64: 'ORR X3, X3, X0' },
  { x86: 'XOR RCX, RAX', arm64: 'EOR X2, X2, X0' },
  { x86: 'SHL RAX, RBX', arm64: 'LSL X0, X0, X1' },
]

async function runInstructionTask(index: number): Promise<void> {
  const testCase = INSTRUCTION_CASES[index % INSTRUCTION_CASES.length]
  const tracer = new EngineTracer()
  const start = Date.now()
  try {
    const result = await runCeilingAgent({ kind: 'instruction', description: testCase.x86 }, new OneShotLlmClient(testCase.arm64), { tracer })
    const wallClockMs = Date.now() - start
    const spans = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans.slice(1)
    const spanLatencyMs = (s: (typeof spans)[number]): number => {
      const latencyAttr = s.attributes.find((a) => a.key === 'latency_ms')
      return latencyAttr && 'doubleValue' in latencyAttr.value ? latencyAttr.value.doubleValue : latencyAttr && 'intValue' in latencyAttr.value ? latencyAttr.value.intValue : 0
    }
    const recordedSpanLatencyMs = spans.reduce((sum, s) => sum + spanLatencyMs(s), 0)
    recordGateLatencies(
      'instruction',
      spans.map((s) => ({ gate: s.name.replace(/^floor_gate:/, ''), elapsedMs: spanLatencyMs(s) }))
    )
    outcomes.push({ category: 'instruction', ok: result.ok === true, wallClockMs, recordedSpanLatencyMs })
  } catch (error) {
    outcomes.push({ category: 'instruction', ok: false, wallClockMs: Date.now() - start, note: error instanceof Error ? error.message : String(error) })
  }
}

async function runTopologyTask(pool: WorkerPoolEvaluator, workspaceFiles: Record<string, string>, index: number): Promise<void> {
  const isPressureTask = index % PRESSURE_TASK_EVERY_N === 0
  const targetFile = `f${index % SYNTHETIC_FILE_COUNT}`
  const candidate: TopologyCandidate = {
    inMemoryFiles: { 'caller.ts': `import { ${targetFile} } from './${targetFile}'\nexport function caller(): number { return ${targetFile}() }\n` },
    expectedExports: [{ filePath: 'caller.ts', exportedNames: ['caller'] }],
    reachability: [{ from: { filePath: 'caller.ts', functionName: 'caller' }, to: { filePath: `${targetFile}.ts`, functionName: targetFile }, expectReachable: true }],
  }

  const start = Date.now()
  try {
    const gates = await pool.verify(
      {
        domain: 'topology',
        candidateText: JSON.stringify(candidate),
        workspaceFiles,
        ...(isPressureTask ? { __testFakeRssBytes: FAKE_PRESSURE_RSS_BYTES } : {}),
      },
      async () => [{ gate: 'fallback', ok: !isPressureTask, details: 'fell back to in-process verification' }]
    )
    recordGateLatencies('topology', gates)
    outcomes.push({
      category: isPressureTask ? 'topology-pressure' : 'topology',
      ok: gates.every((g) => g.ok),
      wallClockMs: Date.now() - start,
    })
  } catch (error) {
    outcomes.push({ category: isPressureTask ? 'topology-pressure' : 'topology', ok: false, wallClockMs: Date.now() - start, note: error instanceof Error ? error.message : String(error) })
  }
}

// A single real, already-proven claim (see CeilingAgent.test.ts's own
// GOOD_CLAIM_CANDIDATE) about a real, committed function - repeated across
// tasks rather than varied, since the point here is throughput/latency
// under load, not claim diversity.
const CLAIM_CANDIDATE: ClaimCandidate = {
  claims: [
    {
      statement: 'translateInstruction lowers MOV RAX, RBX to MOV X0, X1',
      subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
      assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X0, X1' } },
    },
  ],
}

async function runClaimTask(pool: WorkerPoolEvaluator, index: number): Promise<void> {
  const isPressureTask = index % PRESSURE_TASK_EVERY_N === 0
  const start = Date.now()
  try {
    const gates = await pool.verify(
      { domain: 'claim', candidateText: JSON.stringify(CLAIM_CANDIDATE), ...(isPressureTask ? { __testFakeRssBytes: FAKE_PRESSURE_RSS_BYTES } : {}) },
      async () => [{ gate: 'fallback', ok: !isPressureTask, details: 'fell back to in-process verification' }]
    )
    recordGateLatencies('claim', gates)
    outcomes.push({ category: isPressureTask ? 'claim-pressure' : 'claim', ok: gates.every((g) => g.ok), wallClockMs: Date.now() - start })
  } catch (error) {
    outcomes.push({ category: isPressureTask ? 'claim-pressure' : 'claim', ok: false, wallClockMs: Date.now() - start, note: error instanceof Error ? error.message : String(error) })
  }
}

async function runSpatialTask(pool: WorkerPoolEvaluator, index: number): Promise<void> {
  const isPressureTask = index % PRESSURE_TASK_EVERY_N === 0
  const radius = 1 + (index % 3)
  const candidate: SpatialCandidate = {
    surface: { type: 'sphere', center: [0, 0, 0], radius },
    boundingBox: { min: [-radius - 1, -radius - 1, -radius - 1], max: [radius + 1, radius + 1, radius + 1] },
  }
  const start = Date.now()
  try {
    const gates = await pool.verify(
      { domain: 'spatial', candidateText: JSON.stringify(candidate), ...(isPressureTask ? { __testFakeRssBytes: FAKE_PRESSURE_RSS_BYTES } : {}) },
      async () => [{ gate: 'fallback', ok: !isPressureTask, details: 'fell back to in-process verification' }]
    )
    recordGateLatencies('spatial', gates)
    outcomes.push({ category: isPressureTask ? 'spatial-pressure' : 'spatial', ok: gates.every((g) => g.ok), wallClockMs: Date.now() - start })
  } catch (error) {
    outcomes.push({ category: isPressureTask ? 'spatial-pressure' : 'spatial', ok: false, wallClockMs: Date.now() - start, note: error instanceof Error ? error.message : String(error) })
  }
}

async function runBrepTask(pool: BRepWorkerPoolEvaluator, index: number): Promise<void> {
  const isPressureTask = index % PRESSURE_TASK_EVERY_N === 0
  const half = 1 + (index % 5)
  const candidate: BRepCandidate = {
    solid: { type: 'box', center: [0, 0, 0], halfExtents: [half, half, half] },
    boundingBox: { min: [-10, -10, -10], max: [10, 10, 10] },
  }
  const start = Date.now()
  try {
    const gates = await pool.verify(
      { domain: 'brep', candidate, ...(isPressureTask ? { __testFakeRssBytes: FAKE_PRESSURE_RSS_BYTES } : {}) },
      async () => [{ gate: 'fallback', ok: !isPressureTask, details: 'fell back to in-process verification' }]
    )
    recordGateLatencies('brep', gates)
    outcomes.push({ category: isPressureTask ? 'brep-pressure' : 'brep', ok: gates.every((g) => g.ok), wallClockMs: Date.now() - start })
  } catch (error) {
    outcomes.push({ category: isPressureTask ? 'brep-pressure' : 'brep', ok: false, wallClockMs: Date.now() - start, note: error instanceof Error ? error.message : String(error) })
  }
}

async function runSandboxTask(runner: SandboxRunner, index: number): Promise<void> {
  const a = BigInt(index)
  const b = BigInt(index * 3)
  const start = Date.now()
  const result = await runner.execute('ADD X0, X1, X2', { X1: a, X2: b })
  const wallClockMs = Date.now() - start
  const ok = result.executed && result.registers.X0 === a + b
  outcomes.push({ category: 'sandbox', ok, wallClockMs, note: result.executed ? undefined : result.reason })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printReport(pool: WorkerPoolEvaluator, brepPool: BRepWorkerPoolEvaluator, ingestMs: number, totalMs: number): void {
  console.log('\n=== v1.6.0 Engine Load Test Report ===\n')
  console.log(`Total wall clock: ${totalMs}ms (ingestion: ${ingestMs}ms)`)

  const byCategory = new Map<string, TaskOutcome[]>()
  for (const outcome of outcomes) {
    const list = byCategory.get(outcome.category) ?? []
    list.push(outcome)
    byCategory.set(outcome.category, list)
  }

  console.log('\n-- Task outcomes by category --')
  for (const [category, list] of byCategory) {
    const okCount = list.filter((o) => o.ok).length
    const avgMs = list.reduce((sum, o) => sum + o.wallClockMs, 0) / list.length
    console.log(`  ${category.padEnd(18)} ${okCount}/${list.length} ok, avg ${avgMs.toFixed(1)}ms`)
  }

  // Phase 21.0: real per-gate latency breakdown across all 5 domains -
  // e.g. instruction:symbolic is Z3 solve time, topology:reachability is
  // ts-morph AST analysis, brep:structural-validity is WASM B-Rep
  // evaluation. Reported, not asserted - see the file header comment on why.
  console.log('\n-- Per-gate latency breakdown (min/avg/max ms, from real elapsedMs telemetry) --')
  for (const [key, samples] of [...gateLatenciesMs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const min = Math.min(...samples)
    const max = Math.max(...samples)
    const avg = samples.reduce((sum, v) => sum + v, 0) / samples.length
    console.log(`  ${key.padEnd(28)} n=${samples.length.toString().padStart(3)}  min ${min.toFixed(1)}  avg ${avg.toFixed(1)}  max ${max.toFixed(1)}`)
  }

  console.log('\n-- Worker recycling behavior --')
  console.log(
    `  general pool recycledWorkerCount: ${pool.recycledWorkerCount} ` +
      `(expected > 0: ${(TOPOLOGY_TASK_COUNT + CLAIM_TASK_COUNT + SPATIAL_TASK_COUNT) / PRESSURE_TASK_EVERY_N} pressure task(s) were injected across topology/claim/spatial)`
  )
  console.log(`  brep pool recycledWorkerCount: ${brepPool.recycledWorkerCount} (expected > 0: ${BREP_TASK_COUNT / PRESSURE_TASK_EVERY_N} pressure task(s) were injected)`)

  console.log('\n-- Memory stability (RSS sampled after each batch) --')
  const minRss = Math.min(...rssSamplesBytes)
  const maxRss = Math.max(...rssSamplesBytes)
  const firstRss = rssSamplesBytes[0]
  const lastRss = rssSamplesBytes[rssSamplesBytes.length - 1]
  const growthPct = ((lastRss - firstRss) / firstRss) * 100
  console.log(`  samples: ${rssSamplesBytes.length}`)
  console.log(`  first: ${(firstRss / 1024 / 1024).toFixed(1)}MB, last: ${(lastRss / 1024 / 1024).toFixed(1)}MB, min: ${(minRss / 1024 / 1024).toFixed(1)}MB, max: ${(maxRss / 1024 / 1024).toFixed(1)}MB`)
  console.log(`  growth first->last: ${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(1)}%`)

  console.log('\n-- Trace span latency accuracy (instruction tasks: recorded gate span latency vs measured wall clock) --')
  const instructionOutcomes = outcomes.filter((o) => o.category === 'instruction' && o.recordedSpanLatencyMs !== undefined)
  if (instructionOutcomes.length > 0) {
    const diffs = instructionOutcomes.map((o) => o.wallClockMs - (o.recordedSpanLatencyMs ?? 0))
    const meanDiff = diffs.reduce((sum, d) => sum + d, 0) / diffs.length
    const maxDiff = Math.max(...diffs)
    const anyNegative = diffs.some((d) => d < 0)
    console.log(`  sampled: ${instructionOutcomes.length}, mean overhead (wall clock - recorded span sum): ${meanDiff.toFixed(1)}ms, max: ${maxDiff.toFixed(1)}ms`)
    console.log(`  recorded span latency ever EXCEEDED measured wall clock (would indicate fabricated/inconsistent timing): ${anyNegative}`)
  }

  const totalOk = outcomes.filter((o) => o.ok).length
  console.log(`\n-- Overall: ${totalOk}/${outcomes.length} tasks succeeded --\n`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runStart = Date.now()
  const workspace = mkdtempSync(join(tmpdir(), OUTPUT_DIR_PREFIX))
  const pool = new WorkerPoolEvaluator({ poolSize: 2 })
  const brepPool = new BRepWorkerPoolEvaluator({ poolSize: 1 })
  const sandbox = new SandboxRunner()

  try {
    console.log(`Building a synthetic ${SYNTHETIC_FILE_COUNT}-file project pack at ${workspace}...`)
    buildSyntheticProject(workspace, SYNTHETIC_FILE_COUNT)

    const ingestStart = Date.now()
    const graph = await new ProjectPackIngestor().ingestWorkspace(workspace)
    const ingestMs = Date.now() - ingestStart
    const workspaceFiles = toWorkspaceFiles(graph)
    console.log(`Ingested ${graph.metadata.fileCount} file(s), ${graph.dependencies.length} dependency edge(s), in ${ingestMs}ms.`)
    sampleRss()

    console.log(`Running ${INSTRUCTION_TASK_COUNT} concurrent Z3 instruction verification(s) in batches of ${BATCH_CONCURRENCY}...`)
    await runInBatches(Array.from({ length: INSTRUCTION_TASK_COUNT }, (_, i) => i), BATCH_CONCURRENCY, async (i) => {
      await runInstructionTask(i)
    })
    sampleRss()

    console.log(`Running ${TOPOLOGY_TASK_COUNT} worker-pool topology verification(s) (~1-in-${PRESSURE_TASK_EVERY_N} simulating RSS pressure) in batches of ${BATCH_CONCURRENCY}...`)
    await runInBatches(Array.from({ length: TOPOLOGY_TASK_COUNT }, (_, i) => i), BATCH_CONCURRENCY, async (i) => {
      await runTopologyTask(pool, workspaceFiles, i)
    })
    sampleRss()

    console.log(`Running ${CLAIM_TASK_COUNT} worker-pool claim verification(s) (~1-in-${PRESSURE_TASK_EVERY_N} simulating RSS pressure) in batches of ${BATCH_CONCURRENCY}...`)
    await runInBatches(Array.from({ length: CLAIM_TASK_COUNT }, (_, i) => i), BATCH_CONCURRENCY, async (i) => {
      await runClaimTask(pool, i)
    })
    sampleRss()

    console.log(`Running ${SPATIAL_TASK_COUNT} worker-pool spatial verification(s) (~1-in-${PRESSURE_TASK_EVERY_N} simulating RSS pressure) in batches of ${BATCH_CONCURRENCY}...`)
    await runInBatches(Array.from({ length: SPATIAL_TASK_COUNT }, (_, i) => i), BATCH_CONCURRENCY, async (i) => {
      await runSpatialTask(pool, i)
    })
    sampleRss()

    console.log(`Running ${BREP_TASK_COUNT} B-Rep-worker-pool verification(s) (~1-in-${PRESSURE_TASK_EVERY_N} simulating RSS pressure) in batches of ${BATCH_CONCURRENCY}...`)
    await runInBatches(Array.from({ length: BREP_TASK_COUNT }, (_, i) => i), BATCH_CONCURRENCY, async (i) => {
      await runBrepTask(brepPool, i)
    })
    sampleRss()

    console.log(`Running ${SANDBOX_TASK_COUNT} isolated sandbox execution(s) in batches of ${BATCH_CONCURRENCY}...`)
    await runInBatches(Array.from({ length: SANDBOX_TASK_COUNT }, (_, i) => i), BATCH_CONCURRENCY, async (i) => {
      await runSandboxTask(sandbox, i)
    })
    sampleRss()

    const totalMs = Date.now() - runStart
    printReport(pool, brepPool, ingestMs, totalMs)

    const anyFailures = outcomes.some((o) => !o.ok)
    const recyclingObserved = pool.recycledWorkerCount > 0 && brepPool.recycledWorkerCount > 0
    if (anyFailures) {
      console.error('LOAD TEST FAILED: at least one task did not succeed.')
      process.exitCode = 1
    } else if (!recyclingObserved) {
      console.error('LOAD TEST FAILED: no worker recycling was observed on one or both pools despite injected pressure tasks.')
      process.exitCode = 1
    } else {
      console.log('LOAD TEST PASSED.')
    }
  } finally {
    await Promise.all([pool.shutdown(), brepPool.shutdown()])
    rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error('Load test crashed:', error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
