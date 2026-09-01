import { describe, expect, test } from 'vitest'
import {
  computeUnifiedDiff,
  formatEngineResponse,
  toAnsiText,
  toMarkdown,
  toJson,
  type EngineOutcome,
} from './output-formatter'
import { EngineTracer } from './tracer'
import type { CeilingSuccess, CeilingFailureReport } from '../CeilingAgent'

// ---------------------------------------------------------------------------
// computeUnifiedDiff: a real LCS-based line diff (Node builtins only, no new
// dependency) - candidate texts here are always short (a handful of lines:
// one ARM64 instruction, a JSON blob, a small TS snippet), so an O(n*m) DP
// table is trivially cheap; there's no scalability concern to optimize for.
// ---------------------------------------------------------------------------

describe('computeUnifiedDiff', () => {
  test('identical text produces an all-context diff with no add/remove lines', () => {
    const diff = computeUnifiedDiff('ADD X0, X0, X1', 'ADD X0, X0, X1')
    expect(diff).toEqual([{ type: 'context', text: 'ADD X0, X0, X1' }])
  })

  test('a single-line operand swap produces exactly one remove and one add', () => {
    const diff = computeUnifiedDiff('ADD X0, X1, X0', 'ADD X0, X0, X1')
    expect(diff).toEqual([
      { type: 'remove', text: 'ADD X0, X1, X0' },
      { type: 'add', text: 'ADD X0, X0, X1' },
    ])
  })

  test('a multi-line diff preserves unchanged context lines around the real change', () => {
    const before = 'line1\nline2-wrong\nline3'
    const after = 'line1\nline2-right\nline3'
    const diff = computeUnifiedDiff(before, after)
    expect(diff).toEqual([
      { type: 'context', text: 'line1' },
      { type: 'remove', text: 'line2-wrong' },
      { type: 'add', text: 'line2-right' },
      { type: 'context', text: 'line3' },
    ])
  })

  test('an insertion-only diff (nothing removed) produces pure add lines after context', () => {
    const diff = computeUnifiedDiff('a', 'a\nb')
    expect(diff).toEqual([
      { type: 'context', text: 'a' },
      { type: 'add', text: 'b' },
    ])
  })

  test('a deletion-only diff (nothing added) produces pure remove lines', () => {
    const diff = computeUnifiedDiff('a\nb', 'a')
    expect(diff).toEqual([
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
    ])
  })

  test('completely different single lines produce a clean remove+add, not a false partial match', () => {
    const diff = computeUnifiedDiff('completely different', 'nothing alike here')
    expect(diff).toEqual([
      { type: 'remove', text: 'completely different' },
      { type: 'add', text: 'nothing alike here' },
    ])
  })

  test('an empty-string before/after is handled without throwing', () => {
    // ''.split('\n') is ['\'\''] - one empty-string line, not zero lines -
    // so an empty "before"/"after" is consistently treated as a single
    // empty line being replaced, not specially elided.
    expect(computeUnifiedDiff('', 'new content')).toEqual([
      { type: 'remove', text: '' },
      { type: 'add', text: 'new content' },
    ])
    expect(computeUnifiedDiff('old content', '')).toEqual([
      { type: 'remove', text: 'old content' },
      { type: 'add', text: '' },
    ])
    expect(computeUnifiedDiff('', '')).toEqual([{ type: 'context', text: '' }])
  })
})

// ---------------------------------------------------------------------------
// formatEngineResponse: PASS (Layer 5/3/4/1) and FAIL paths.
// ---------------------------------------------------------------------------

function makeSuccess(overrides: Partial<CeilingSuccess> = {}): CeilingSuccess {
  return {
    ok: true,
    result: 'ADD X0, X0, X1',
    attempts: 1,
    gates: [
      { gate: 'static', ok: true, details: '1 non-blank line(s), no malformed branch mnemonics' },
      { gate: 'fuzz', ok: true, details: 'all 3 register token(s) are valid ARM64 registers' },
      { gate: 'symbolic', ok: true, details: 'Z3 proved "ADD RAX, RBX" and "ADD X0, X0, X1" are register-equivalent for all 64-bit values' },
    ],
    history: [],
    ...overrides,
  }
}

describe('formatEngineResponse: Layer 5 Meta-Kernel hit (PASS)', () => {
  test('reports PASS with resolvedLayer layer5-meta-kernel and an empty diff when there was no prior failure to compare', () => {
    const outcome: EngineOutcome = { ok: true, success: makeSuccess(), resolvedLayer: 'layer5-meta-kernel' }
    const response = formatEngineResponse(outcome)

    expect(response.summary.outcome).toBe('PASS')
    expect(response.summary.resolvedLayer).toBe('layer5-meta-kernel')
    expect(response.summary.attempts).toBe(1)
  })

  test('a meta-kernel bypass following a real prior failure produces a real diff between the failed and fixed candidate', () => {
    const success = makeSuccess({
      attempts: 2,
      history: [{ attempt: 1, candidate: 'ADD X0, X1, X0', failedGate: { gate: 'symbolic', ok: false, details: 'expected "ADD X0, X0, X1", got "ADD X0, X1, X0"' } }],
    })
    const outcome: EngineOutcome = { ok: true, success, resolvedLayer: 'layer5-meta-kernel' }
    const response = formatEngineResponse(outcome)

    expect(response.structuralDiff).toEqual([
      { type: 'remove', text: 'ADD X0, X1, X0' },
      { type: 'add', text: 'ADD X0, X0, X1' },
    ])
  })
})

describe('formatEngineResponse: floor failures (verificationTraces + diagnostics)', () => {
  test('an itemized verificationTraces entry exists per gate, with the exact diagnostic string preserved', () => {
    const outcome: EngineOutcome = { ok: true, success: makeSuccess(), resolvedLayer: 'layer1-floor' }
    const response = formatEngineResponse(outcome)

    expect(response.verificationTraces).toHaveLength(3)
    expect(response.verificationTraces).toContainEqual({
      gate: 'symbolic',
      passed: true,
      diagnostics: 'Z3 proved "ADD RAX, RBX" and "ADD X0, X0, X1" are register-equivalent for all 64-bit values',
    })
  })

  test('a FAIL outcome (exhausted) reports FAIL, no resolvedLayer, and one verificationTraces entry per failed attempt', () => {
    const report: CeilingFailureReport = {
      request: { kind: 'instruction', description: 'MOV RAX, RBX' },
      attempts: 2,
      history: [
        { attempt: 1, candidate: 'garbage', failedGate: { gate: 'symbolic', ok: false, details: 'first failure detail' } },
        { attempt: 2, candidate: 'garbage2', failedGate: { gate: 'symbolic', ok: false, details: 'second failure detail' } },
      ],
    }
    const outcome: EngineOutcome = { ok: false, failure: report }
    const response = formatEngineResponse(outcome)

    expect(response.summary.outcome).toBe('FAIL')
    expect(response.summary.resolvedLayer).toBeUndefined()
    expect(response.summary.attempts).toBe(2)
    expect(response.verificationTraces).toEqual([
      { gate: 'symbolic', passed: false, diagnostics: 'first failure detail' },
      { gate: 'symbolic', passed: false, diagnostics: 'second failure detail' },
    ])
  })

  test('a FAIL outcome diffs the first and last failed attempts, showing overall self-correction drift', () => {
    const report: CeilingFailureReport = {
      request: { kind: 'instruction', description: 'MOV RAX, RBX' },
      attempts: 2,
      history: [
        { attempt: 1, candidate: 'attempt-one', failedGate: { gate: 'symbolic', ok: false, details: 'd1' } },
        { attempt: 2, candidate: 'attempt-two', failedGate: { gate: 'symbolic', ok: false, details: 'd2' } },
      ],
    }
    const response = formatEngineResponse({ ok: false, failure: report })
    expect(response.structuralDiff).toEqual([
      { type: 'remove', text: 'attempt-one' },
      { type: 'add', text: 'attempt-two' },
    ])
  })

  test('a FAIL outcome with only one attempt has an empty diff (nothing to compare)', () => {
    const report: CeilingFailureReport = {
      request: { kind: 'instruction', description: 'MOV RAX, RBX' },
      attempts: 1,
      history: [{ attempt: 1, candidate: 'only-attempt', failedGate: { gate: 'symbolic', ok: false, details: 'd1' } }],
    }
    const response = formatEngineResponse({ ok: false, failure: report })
    expect(response.structuralDiff).toEqual([])
  })
})

describe('formatEngineResponse: telemetry reference', () => {
  test('when a tracer is supplied, telemetry carries the real traceId/rootSpanId and real span/event counts', () => {
    const tracer = new EngineTracer()
    tracer.startTrace('req-1', 'instruction')
    tracer.recordFloorGate('static', true, 1)
    tracer.recordFloorGate('fuzz', true, 1)
    tracer.recordMetaKernelCheck(false)

    const outcome: EngineOutcome = { ok: true, success: makeSuccess(), resolvedLayer: 'layer1-floor' }
    const response = formatEngineResponse(outcome, tracer)

    const exported = tracer.exportSpanJson()
    const rootSpan = exported.resourceSpans[0].scopeSpans[0].spans[0]
    expect(response.telemetry.traceId).toBe(rootSpan.traceId)
    expect(response.telemetry.rootSpanId).toBe(rootSpan.spanId)
    expect(response.telemetry.gateSpanCount).toBe(2)
    expect(response.telemetry.eventCount).toBe(1)
  })

  test('without a tracer, telemetry is honestly empty (no fabricated IDs)', () => {
    const outcome: EngineOutcome = { ok: true, success: makeSuccess(), resolvedLayer: 'layer1-floor' }
    const response = formatEngineResponse(outcome)

    expect(response.telemetry.traceId).toBeUndefined()
    expect(response.telemetry.gateSpanCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Renderers: toAnsiText / toMarkdown / toJson
// ---------------------------------------------------------------------------

describe('toAnsiText', () => {
  test('colors add/remove diff lines and includes the PASS/FAIL summary', () => {
    const success = makeSuccess({
      attempts: 2,
      history: [{ attempt: 1, candidate: 'ADD X0, X1, X0', failedGate: { gate: 'symbolic', ok: false, details: 'x' } }],
    })
    const response = formatEngineResponse({ ok: true, success, resolvedLayer: 'layer4-healing' })
    const text = toAnsiText(response)

    expect(text).toContain('PASS')
    expect(text).toContain('layer4-healing')
    // ANSI escape codes for green (add) and red (remove) are present.
    expect(text).toContain('[32m')
    expect(text).toContain('[31m')
    expect(text).toContain('ADD X0, X0, X1')
  })

  test('a FAIL response renders without throwing and contains FAIL', () => {
    const report: CeilingFailureReport = {
      request: { kind: 'instruction', description: 'x' },
      attempts: 1,
      history: [{ attempt: 1, candidate: 'x', failedGate: { gate: 'symbolic', ok: false, details: 'd' } }],
    }
    const text = toAnsiText(formatEngineResponse({ ok: false, failure: report }))
    expect(text).toContain('FAIL')
  })
})

describe('toMarkdown', () => {
  test('renders a diff fenced code block and a verification traces section', () => {
    const success = makeSuccess({
      attempts: 2,
      history: [{ attempt: 1, candidate: 'ADD X0, X1, X0', failedGate: { gate: 'symbolic', ok: false, details: 'x' } }],
    })
    const md = toMarkdown(formatEngineResponse({ ok: true, success, resolvedLayer: 'layer3-sampler' }))

    expect(md).toContain('```diff')
    expect(md).toContain('-ADD X0, X1, X0')
    expect(md).toContain('+ADD X0, X0, X1')
    expect(md).toContain('symbolic')
  })
})

describe('toJson', () => {
  test('produces valid, parseable JSON matching the structured response', () => {
    const response = formatEngineResponse({ ok: true, success: makeSuccess(), resolvedLayer: 'layer1-floor' })
    const json = toJson(response)
    expect(() => JSON.parse(json)).not.toThrow()
    expect(JSON.parse(json)).toEqual(response)
  })
})
