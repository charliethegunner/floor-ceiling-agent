import { randomBytes } from 'node:crypto'
import type { CeilingRequestKind } from '../CeilingAgent'

// Production telemetry/audit tracing for the engine. Genuinely OTLP
// (OpenTelemetry Protocol) JSON-shaped export - real 128-bit/64-bit hex
// trace/span IDs, real typed-attribute-value encoding, real numeric
// SPAN_KIND/STATUS_CODE enum values matching the actual OTel spec - built
// entirely on Node builtins (node:crypto for IDs), NOT the @opentelemetry/*
// SDK: this project has zero telemetry dependencies today, and pulling in
// the real SDK for one feature isn't justified when a spec-faithful JSON
// exporter needs nothing beyond what Node already provides. A real OTLP
// collector or any tool that consumes the JSON encoding can ingest this
// output directly; what's NOT here is the SDK's context-propagation,
// sampling, or network-export machinery, none of which this project needs.
//
// One EngineTracer instance = one trace, matching one runCeilingAgent call's
// lifecycle (create a fresh instance per call, exactly like the existing
// opt-in WorkerPoolEvaluator/MetaKernelCompiler options). Floor gate checks
// become real CHILD SPANS (they carry a genuine duration); meta-kernel
// checks and sampler-round decisions become SPAN EVENTS on the root span
// (point-in-time annotations, the correct OTel concept for something
// without its own duration).

const NANOS_PER_MS = 1_000_000n

// STATUS_CODE_UNSET/OK/ERROR per the real OTLP trace proto enum.
const STATUS_CODE: Record<'UNSET' | 'OK' | 'ERROR', number> = { UNSET: 0, OK: 1, ERROR: 2 }
// SPAN_KIND_INTERNAL per the real OTLP trace proto enum - every span this
// tracer produces represents internal engine processing, never a client/
// server RPC boundary.
const SPAN_KIND_INTERNAL = 1

type AttributeValue = string | number | boolean

export interface OtlpKeyValue {
  key: string
  value: { stringValue: string } | { intValue: number } | { doubleValue: number } | { boolValue: boolean }
}

export interface OtlpSpanEvent {
  name: string
  timeUnixNano: string
  attributes: OtlpKeyValue[]
}

export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano?: string
  attributes: OtlpKeyValue[]
  events: OtlpSpanEvent[]
  status: { code: number }
}

export interface OtlpTraceExport {
  resourceSpans: [
    {
      resource: { attributes: OtlpKeyValue[] }
      scopeSpans: [
        {
          scope: { name: string }
          spans: OtlpSpan[]
        },
      ]
    },
  ]
}

function toOtlpValue(value: AttributeValue): OtlpKeyValue['value'] {
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  return Number.isInteger(value) ? { intValue: value } : { doubleValue: value }
}

function toOtlpAttributes(attrs: Record<string, AttributeValue>): OtlpKeyValue[] {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: toOtlpValue(value) }))
}

function generateTraceId(): string {
  return randomBytes(16).toString('hex') // 128-bit, 32 hex chars - real OTel traceId length
}

function generateSpanId(): string {
  return randomBytes(8).toString('hex') // 64-bit, 16 hex chars - real OTel spanId length
}

// Unix-epoch nanoseconds as a bigint. The underlying precision is only
// milliseconds (Date.now(), zero-padded) - the same precision every
// latencyMs measurement elsewhere in this codebase already has
// (performance.now()/Date.now() in layer3/sampler.ts and the benchmark
// scripts) - this is honest about that, not claiming false sub-millisecond
// resolution. OTLP encodes nanosecond timestamps as JSON strings (not
// numbers) specifically because they exceed Number.MAX_SAFE_INTEGER, so all
// arithmetic here stays in bigint and only becomes a string at the boundary.
function nowUnixNano(): bigint {
  return BigInt(Date.now()) * NANOS_PER_MS
}

interface InternalEvent {
  name: string
  timeUnixNano: bigint
  attributes: Record<string, AttributeValue>
}

interface InternalSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: bigint
  endTimeUnixNano?: bigint
  attributes: Record<string, AttributeValue>
  events: InternalEvent[]
  status: 'UNSET' | 'OK' | 'ERROR'
}

export class EngineTracer {
  private rootSpan: InternalSpan | undefined
  private gateSpans: InternalSpan[] = []

  private requireStarted(): InternalSpan {
    if (!this.rootSpan) throw new Error('EngineTracer: startTrace() must be called before any record*/export method')
    return this.rootSpan
  }

  startTrace(requestId: string, domain: CeilingRequestKind): void {
    this.rootSpan = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      name: `runCeilingAgent:${domain}`,
      startTimeUnixNano: nowUnixNano(),
      attributes: { 'ceiling.request_id': requestId, 'ceiling.domain': domain },
      events: [],
      status: 'UNSET',
    }
    this.gateSpans = []
  }

  recordMetaKernelCheck(hit: boolean, ruleId?: string): void {
    const root = this.requireStarted()
    root.events.push({
      name: 'meta_kernel_check',
      timeUnixNano: nowUnixNano(),
      attributes: { hit, ...(ruleId !== undefined ? { rule_id: ruleId } : {}) },
    })
  }

  recordSamplerRun(candidateCount: number, winningTemp: number | undefined, shortCircuited: boolean): void {
    const root = this.requireStarted()
    root.events.push({
      name: 'sampler_run',
      timeUnixNano: nowUnixNano(),
      attributes: {
        candidate_count: candidateCount,
        short_circuited: shortCircuited,
        ...(winningTemp !== undefined ? { winning_temperature: winningTemp } : {}),
      },
    })
  }

  recordFloorGate(gateName: string, passed: boolean, latencyMs: number, diagnostics?: string): void {
    const root = this.requireStarted()
    const endTimeUnixNano = nowUnixNano()
    const startTimeUnixNano = endTimeUnixNano - BigInt(Math.round(latencyMs * 1_000_000))
    this.gateSpans.push({
      traceId: root.traceId,
      spanId: generateSpanId(),
      parentSpanId: root.spanId,
      name: `floor_gate:${gateName}`,
      startTimeUnixNano,
      endTimeUnixNano,
      attributes: { passed, latency_ms: latencyMs, ...(diagnostics !== undefined ? { diagnostics } : {}) },
      events: [],
      status: passed ? 'OK' : 'ERROR',
    })
  }

  /** Real per-gate latencies recorded so far via recordFloorGate, for a
   *  lightweight consumer (e.g. a /metrics endpoint) that wants the numbers
   *  without re-parsing exportSpanJson's OTLP attribute-value union. */
  getGateLatencies(): { gate: string; ok: boolean; elapsedMs: number }[] {
    return this.gateSpans.map((span) => ({
      gate: span.name.slice('floor_gate:'.length),
      ok: span.status === 'OK',
      elapsedMs: typeof span.attributes.latency_ms === 'number' ? span.attributes.latency_ms : 0,
    }))
  }

  private toOtlpSpan(span: InternalSpan): OtlpSpan {
    return {
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
      name: span.name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: span.startTimeUnixNano.toString(),
      ...(span.endTimeUnixNano !== undefined ? { endTimeUnixNano: span.endTimeUnixNano.toString() } : {}),
      attributes: toOtlpAttributes(span.attributes),
      events: span.events.map((event) => ({
        name: event.name,
        timeUnixNano: event.timeUnixNano.toString(),
        attributes: toOtlpAttributes(event.attributes),
      })),
      status: { code: STATUS_CODE[span.status] },
    }
  }

  /** Closes the root span (if not already closed) with `status`, then emits
   *  the full trace as OTLP-shaped JSON: resourceSpans[].scopeSpans[].spans[]. */
  exportSpanJson(status: 'OK' | 'ERROR' = 'OK'): OtlpTraceExport {
    const root = this.requireStarted()
    if (root.endTimeUnixNano === undefined) {
      root.endTimeUnixNano = nowUnixNano()
      root.status = status
    }

    return {
      resourceSpans: [
        {
          resource: { attributes: toOtlpAttributes({ 'service.name': 'floor-ceiling-agent' }) },
          scopeSpans: [
            {
              scope: { name: 'ceiling-agent-tracer' },
              spans: [this.toOtlpSpan(root), ...this.gateSpans.map((span) => this.toOtlpSpan(span))],
            },
          ],
        },
      ],
    }
  }
}
