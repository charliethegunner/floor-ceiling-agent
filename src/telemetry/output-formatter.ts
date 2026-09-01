import type { CeilingSuccess, CeilingFailureReport } from '../CeilingAgent'
import type { EngineTracer } from './tracer'

// Phase 11.4: Structured Presentation & Output Delivery Engine. One
// canonical structured representation (FormattedEngineResponse), computed
// ONCE by formatEngineResponse, then rendered THREE ways (toAnsiText/
// toMarkdown/toJson) - not three independent formatters each re-deriving
// the same diff/summary, and not a change to runCeilingAgent's core return
// type (426 existing tests depend on CeilingSuccess/CeilingFailureReport's
// exact shape; this is a purely additive, opt-in presentation layer on top).
//
// structuralDiff is a REAL line-based LCS diff (Node builtins only, no new
// dependency) between the failing candidate that immediately preceded
// success/exhaustion and the final candidate - not a fabricated "before
// vs after" placeholder. resolvedLayer is NEVER inferred from the trace
// after the fact (multiple retry rounds can each independently record a
// meta_kernel_check event, including ones that matched but didn't verify -
// see tryMetaKernelBypass - so reconstructing "which layer actually
// resolved this" from the aggregated event log is genuinely ambiguous);
// callers that know the ground truth (runCeilingAgent's own control flow)
// pass it in directly instead.

export type ResolvedLayer = 'layer5-meta-kernel' | 'layer3-sampler' | 'layer4-healing' | 'layer1-floor'

export interface DiffLine {
  type: 'context' | 'add' | 'remove'
  text: string
}

export interface FormattedSummary {
  outcome: 'PASS' | 'FAIL'
  /** Only present on PASS - nothing "resolved" a FAIL. */
  resolvedLayer?: ResolvedLayer
  attempts: number
}

export interface VerificationTraceEntry {
  gate: string
  passed: boolean
  diagnostics: string
}

export interface TelemetryReference {
  traceId?: string
  rootSpanId?: string
  gateSpanCount: number
  eventCount: number
}

export interface FormattedEngineResponse {
  summary: FormattedSummary
  structuralDiff: DiffLine[]
  verificationTraces: VerificationTraceEntry[]
  telemetry: TelemetryReference
}

export type EngineOutcome =
  | { ok: true; success: CeilingSuccess; resolvedLayer: ResolvedLayer }
  | { ok: false; failure: CeilingFailureReport }

// ---------------------------------------------------------------------------
// computeUnifiedDiff: a real LCS-based line diff. Candidate texts here are
// always short (a handful of lines: one ARM64 instruction, a JSON blob, a
// small TS snippet), so the O(n*m) DP table is trivially cheap - there is
// no scalability concern to optimize for, and adding a diff library
// dependency for this would be unjustified.
// ---------------------------------------------------------------------------

export function computeUnifiedDiff(before: string, after: string): DiffLine[] {
  if (before === after) {
    return before.split('\n').map((text) => ({ type: 'context', text }))
  }

  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const n = beforeLines.length
  const m = afterLines.length

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = beforeLines[i] === afterLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ type: 'context', text: beforeLines[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: 'remove', text: beforeLines[i] })
      i++
    } else {
      result.push({ type: 'add', text: afterLines[j] })
      j++
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: beforeLines[i] })
    i++
  }
  while (j < m) {
    result.push({ type: 'add', text: afterLines[j] })
    j++
  }

  return result
}

function telemetryFrom(tracer?: EngineTracer): TelemetryReference {
  if (!tracer) return { gateSpanCount: 0, eventCount: 0 }

  const exported = tracer.exportSpanJson()
  const spans = exported.resourceSpans[0].scopeSpans[0].spans
  const [rootSpan, ...gateSpans] = spans
  return {
    traceId: rootSpan.traceId,
    rootSpanId: rootSpan.spanId,
    gateSpanCount: gateSpans.length,
    eventCount: rootSpan.events.length,
  }
}

export function formatEngineResponse(outcome: EngineOutcome, tracer?: EngineTracer): FormattedEngineResponse {
  if (outcome.ok) {
    const { success, resolvedLayer } = outcome
    const lastFailure = success.history[success.history.length - 1]
    return {
      summary: { outcome: 'PASS', resolvedLayer, attempts: success.attempts },
      structuralDiff: lastFailure ? computeUnifiedDiff(lastFailure.candidate, success.result) : [],
      verificationTraces: success.gates.map((g) => ({ gate: g.gate, passed: g.ok, diagnostics: g.details })),
      telemetry: telemetryFrom(tracer),
    }
  }

  const { failure } = outcome
  const first = failure.history[0]
  const last = failure.history[failure.history.length - 1]
  return {
    summary: { outcome: 'FAIL', attempts: failure.attempts },
    structuralDiff: first && last && first !== last ? computeUnifiedDiff(first.candidate, last.candidate) : [],
    verificationTraces: failure.history.map((a) => ({ gate: a.failedGate.gate, passed: false, diagnostics: a.failedGate.details })),
    telemetry: telemetryFrom(tracer),
  }
}

// ---------------------------------------------------------------------------
// Renderers - each consumes the ALREADY-COMPUTED FormattedEngineResponse,
// never re-deriving the diff/summary itself.
// ---------------------------------------------------------------------------

const ANSI = { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }

export function toAnsiText(response: FormattedEngineResponse): string {
  const lines: string[] = []
  const outcomeColor = response.summary.outcome === 'PASS' ? ANSI.green : ANSI.red
  lines.push(`${ANSI.bold}${outcomeColor}${response.summary.outcome}${ANSI.reset} (attempts: ${response.summary.attempts})`)
  if (response.summary.resolvedLayer) lines.push(`  resolved via: ${response.summary.resolvedLayer}`)

  if (response.structuralDiff.length > 0) {
    lines.push('', 'diff:')
    for (const line of response.structuralDiff) {
      if (line.type === 'add') lines.push(`${ANSI.green}+ ${line.text}${ANSI.reset}`)
      else if (line.type === 'remove') lines.push(`${ANSI.red}- ${line.text}${ANSI.reset}`)
      else lines.push(`${ANSI.dim}  ${line.text}${ANSI.reset}`)
    }
  }

  lines.push('', 'verification:')
  for (const trace of response.verificationTraces) {
    const badge = trace.passed ? `${ANSI.green}PASS${ANSI.reset}` : `${ANSI.red}FAIL${ANSI.reset}`
    lines.push(`  [${badge}] ${trace.gate}: ${trace.diagnostics}`)
  }

  if (response.telemetry.traceId) {
    lines.push('', `${ANSI.dim}trace: ${response.telemetry.traceId} (${response.telemetry.gateSpanCount} gate span(s), ${response.telemetry.eventCount} event(s))${ANSI.reset}`)
  }

  return lines.join('\n')
}

export function toMarkdown(response: FormattedEngineResponse): string {
  const lines: string[] = []
  lines.push(`## ${response.summary.outcome}`, '')
  lines.push(`- **Attempts:** ${response.summary.attempts}`)
  if (response.summary.resolvedLayer) lines.push(`- **Resolved via:** \`${response.summary.resolvedLayer}\``)

  if (response.structuralDiff.length > 0) {
    lines.push('', '### Structural Diff', '', '```diff')
    for (const line of response.structuralDiff) {
      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
      lines.push(`${prefix}${line.text}`)
    }
    lines.push('```')
  }

  lines.push('', '### Verification Traces', '')
  for (const trace of response.verificationTraces) {
    lines.push(`- **${trace.gate}** (${trace.passed ? 'PASS' : 'FAIL'}): ${trace.diagnostics}`)
  }

  if (response.telemetry.traceId) {
    lines.push('', `_trace: \`${response.telemetry.traceId}\` — ${response.telemetry.gateSpanCount} gate span(s), ${response.telemetry.eventCount} event(s)_`)
  }

  return lines.join('\n')
}

export function toJson(response: FormattedEngineResponse): string {
  return JSON.stringify(response, null, 2)
}
