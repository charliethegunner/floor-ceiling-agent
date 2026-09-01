import { describe, expect, test } from 'vitest'
import { EngineTracer } from './tracer'

const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/

describe('EngineTracer: startTrace creates a real, OTel-spec-shaped root span', () => {
  test('generates a 128-bit (32 hex char) traceId and a 64-bit (16 hex char) root spanId', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'instruction')
    const exported = tracer.exportSpanJson()
    const rootSpan = exported.resourceSpans[0].scopeSpans[0].spans[0]

    expect(rootSpan.traceId).toMatch(HEX32)
    expect(rootSpan.spanId).toMatch(HEX16)
  })

  test('two different traces get different traceIds', () => {
    const a = new EngineTracer()
    a.startTrace('req-1', 'instruction')
    const b = new EngineTracer()
    b.startTrace('req-2', 'instruction')

    const traceIdA = a.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[0].traceId
    const traceIdB = b.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[0].traceId
    expect(traceIdA).not.toBe(traceIdB)
  })

  test('the root span carries the requestId and domain as attributes', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-42', 'topology')
    const rootSpan = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[0]

    expect(rootSpan.name).toBe('runCeilingAgent:topology')
    expect(rootSpan.attributes).toContainEqual({ key: 'ceiling.request_id', value: { stringValue: 'req-42' } })
    expect(rootSpan.attributes).toContainEqual({ key: 'ceiling.domain', value: { stringValue: 'topology' } })
  })

  test('calling any record*/export method before startTrace throws a clear error, not a silent no-op', () => {
    const tracer = new EngineTracer()
    expect(() => tracer.recordMetaKernelCheck(true)).toThrow(/startTrace/)
    expect(() => tracer.recordSamplerRun(4, 0.8, true)).toThrow(/startTrace/)
    expect(() => tracer.recordFloorGate('exports', true, 5)).toThrow(/startTrace/)
    expect(() => tracer.exportSpanJson()).toThrow(/startTrace/)
  })
})

describe('EngineTracer: recordMetaKernelCheck and recordSamplerRun add span events', () => {
  test('recordMetaKernelCheck adds a hit event with the ruleId attribute', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'instruction')
    tracer.recordMetaKernelCheck(true, 'instruction:symbolic:expected-got')

    const rootSpan = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[0]
    expect(rootSpan.events).toHaveLength(1)
    expect(rootSpan.events[0].name).toBe('meta_kernel_check')
    expect(rootSpan.events[0].attributes).toContainEqual({ key: 'hit', value: { boolValue: true } })
    expect(rootSpan.events[0].attributes).toContainEqual({ key: 'rule_id', value: { stringValue: 'instruction:symbolic:expected-got' } })
  })

  test('recordMetaKernelCheck on a miss omits the ruleId attribute entirely (not a null/undefined placeholder)', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'instruction')
    tracer.recordMetaKernelCheck(false)

    const event = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[0].events[0]
    expect(event.attributes.find((a) => a.key === 'rule_id')).toBeUndefined()
    expect(event.attributes).toContainEqual({ key: 'hit', value: { boolValue: false } })
  })

  test('recordSamplerRun captures candidateCount, winningTemp, and shortCircuited', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'topology')
    tracer.recordSamplerRun(4, 0.6, true)

    const event = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[0].events[0]
    expect(event.name).toBe('sampler_run')
    expect(event.attributes).toContainEqual({ key: 'candidate_count', value: { intValue: 4 } })
    expect(event.attributes).toContainEqual({ key: 'winning_temperature', value: { doubleValue: 0.6 } })
    expect(event.attributes).toContainEqual({ key: 'short_circuited', value: { boolValue: true } })
  })

  test('recordSamplerRun with no winningTemp (nothing passed) omits that attribute', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'topology')
    tracer.recordSamplerRun(4, undefined, false)

    const event = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[0].events[0]
    expect(event.attributes.find((a) => a.key === 'winning_temperature')).toBeUndefined()
  })

  test('multiple events accumulate in call order', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'topology')
    tracer.recordMetaKernelCheck(false)
    tracer.recordSamplerRun(4, 0.8, false)

    const events = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[0].events
    expect(events.map((e) => e.name)).toEqual(['meta_kernel_check', 'sampler_run'])
  })
})

describe('EngineTracer: recordFloorGate creates real child spans with computed durations', () => {
  test('a passing gate produces a child span with status OK, the right parentSpanId, and a start/end time latencyMs apart', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'instruction')
    tracer.recordFloorGate('symbolic', true, 12, 'Z3 proved equivalence')

    const exported = tracer.exportSpanJson()
    const [rootSpan, gateSpan] = exported.resourceSpans[0].scopeSpans[0].spans
    expect(gateSpan.name).toBe('floor_gate:symbolic')
    expect(gateSpan.parentSpanId).toBe(rootSpan.spanId)
    expect(gateSpan.traceId).toBe(rootSpan.traceId)
    expect(gateSpan.status).toEqual({ code: 1 }) // STATUS_CODE_OK
    expect(gateSpan.attributes).toContainEqual({ key: 'passed', value: { boolValue: true } })
    expect(gateSpan.attributes).toContainEqual({ key: 'diagnostics', value: { stringValue: 'Z3 proved equivalence' } })

    const startNanos = BigInt(gateSpan.startTimeUnixNano)
    const endNanos = BigInt(gateSpan.endTimeUnixNano!) // gate spans always close immediately - see recordFloorGate
    expect(endNanos - startNanos).toBe(12_000_000n) // 12ms in nanoseconds
  })

  test('a failing gate produces a child span with status ERROR', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'topology')
    tracer.recordFloorGate('exports', false, 3, 'expected export "a" not found')

    const gateSpan = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[1]
    expect(gateSpan.status).toEqual({ code: 2 }) // STATUS_CODE_ERROR
    expect(gateSpan.attributes).toContainEqual({ key: 'passed', value: { boolValue: false } })
  })

  test('a gate with no diagnostics omits that attribute', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'instruction')
    tracer.recordFloorGate('fuzz', true, 1)

    const gateSpan = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[1]
    expect(gateSpan.attributes.find((a) => a.key === 'diagnostics')).toBeUndefined()
  })

  test('multiple gate calls produce one child span each, in order, all sharing the same trace (multi-gate logging)', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'instruction')
    tracer.recordFloorGate('static', true, 1)
    tracer.recordFloorGate('fuzz', true, 1)
    tracer.recordFloorGate('symbolic', true, 15)

    const spans = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans
    expect(spans).toHaveLength(4) // root + 3 gates
    expect(spans.slice(1).map((s) => s.name)).toEqual(['floor_gate:static', 'floor_gate:fuzz', 'floor_gate:symbolic'])
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1) // all one trace
  })
})

describe('EngineTracer: exportSpanJson produces a well-formed OTLP-shaped trace export', () => {
  test('the top-level shape matches OTLP JSON: resourceSpans[].scopeSpans[].spans[]', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'claim')
    tracer.recordFloorGate('structural', true, 1)

    const exported = tracer.exportSpanJson()
    expect(exported.resourceSpans).toHaveLength(1)
    expect(exported.resourceSpans[0].resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'floor-ceiling-agent' } })
    expect(exported.resourceSpans[0].scopeSpans[0].scope.name).toBe('ceiling-agent-tracer')
    expect(exported.resourceSpans[0].scopeSpans[0].spans.length).toBeGreaterThan(0)
  })

  test('the root span is closed (gets an endTimeUnixNano) at export time, defaulting to status OK', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'claim')
    const rootSpan = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans[0]

    expect(rootSpan.endTimeUnixNano).toBeDefined()
    expect(BigInt(rootSpan.endTimeUnixNano!)).toBeGreaterThanOrEqual(BigInt(rootSpan.startTimeUnixNano))
    expect(rootSpan.status).toEqual({ code: 1 }) // STATUS_CODE_OK
  })

  test('exportSpanJson accepts an explicit final status for the root span (e.g. ERROR on exhaustion)', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'claim')
    const rootSpan = tracer.exportSpanJson('ERROR').resourceSpans[0].scopeSpans[0].spans[0]

    expect(rootSpan.status).toEqual({ code: 2 })
  })

  test('every span has SPAN_KIND_INTERNAL (kind: 1)', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'instruction')
    tracer.recordFloorGate('static', true, 1)

    const spans = tracer.exportSpanJson().resourceSpans[0].scopeSpans[0].spans
    for (const span of spans) expect(span.kind).toBe(1)
  })

  test('the export is genuinely JSON-serializable (no BigInt/function leakage)', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'spatial')
    tracer.recordMetaKernelCheck(true, 'spatial:self-intersection:negative-radius')
    tracer.recordFloorGate('continuity', true, 2)
    tracer.recordFloorGate('self-intersection', false, 4, 'negative radius')

    expect(() => JSON.stringify(tracer.exportSpanJson())).not.toThrow()
  })
})
