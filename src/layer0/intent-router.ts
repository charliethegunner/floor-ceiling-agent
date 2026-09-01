import { stripJsonFences, type CeilingRequest, type CeilingRequestKind, type LlmClient } from '../CeilingAgent'
import { defaultConfirm, type ExecutionMode } from '../layer1/action-floor'

// Phase 13.4: Intent Classification & Request Normalization ("Layer 0" -
// it precedes Layer 1's verification floors entirely, following this
// codebase's existing Layer-N naming convention). Closes a real, specific
// gap: CeilingRequest.kind must already be known and correctly supplied by
// the caller before runCeilingAgent is ever invoked - every existing test,
// script, and CLI call hardcodes it. This module is the front door that
// takes a genuinely open-ended request and produces a well-formed
// CeilingRequest for the UNMODIFIED runCeilingAgent entry point.
//
// CeilingRequestKind is actually five values - 'instruction' | 'patch' |
// 'topology' | 'claim' | 'spatial' - not the four the original design
// discussion covered ('patch' was missing). All five are handled here.
//
// Two signals, never one blind LLM call trusted outright - the same
// fail-closed posture this project applies everywhere else:
//   1. computeHeuristicSignal: a pure, LLM-free pattern scorer, exported
//      and independently unit-testable (Phase 13.4.1).
//   2. classifyIntent's LLM call, reusing the existing LlmClient interface
//      - no new LLM integration surface.
// classifyIntent proceeds automatically only when both signals agree, or
// the heuristic had no clear winner AND the LLM reports high confidence.
// Otherwise it returns a SINGLE clarifying-question string and the
// candidate kinds it couldn't distinguish between - never a rendered
// options UI (a real risk of scope creep back toward an earlier, withdrawn
// "Interactive Clarifier renders technical choices as plain-English
// product options" design - keep this narrow).
//
// Autonomy mode (Phase 13.4.4) reuses action-floor.ts's ExecutionMode
// directly - no parallel "AutonomyMode" enum, and the SAME defaultConfirm
// implementation ActionExecutor already uses, so a caller wires one
// confirm implementation across every checkpoint instead of one per phase.
// 'auto'/'auto-commit' proceed without confirmation once signals agree;
// 'interactive' asks for confirmation before returning a classified
// request. 'dry-run' is deliberately treated the same as 'interactive' at
// THIS checkpoint: no autonomy preset in the v2.0 blueprint ever assigns
// 'dry-run' to intent classification (only to the downstream action-
// execution checkpoint, unchanged from Phase 11.7), so this is a stated
// simplification, not a silently-guessed behavior.
//
// Implementing the confirm-gated path surfaced a real gap the original
// two-variant IntentClassification sketch didn't have an answer for: a
// confidently-classified request a human DECLINES is a different outcome
// from a genuinely ambiguous one (there's a real CeilingRequest to report
// in the first case; there isn't in the second). IntentClassification
// below adds a `reason` discriminant to distinguish them.

const ALL_KINDS: CeilingRequestKind[] = ['instruction', 'patch', 'topology', 'claim', 'spatial']

export interface IntentRouterOptions {
  /** Default 'auto' - matches today's implicit (mode-less) behavior exactly. */
  executionMode?: ExecutionMode
  /** 'interactive'/'dry-run' only - same confirm-callback shape ActionExecutor
   *  already has. Defaults to the SAME real stdin/readline prompt
   *  ActionExecutor falls back to - tests MUST inject a fake here. */
  confirm?: (message: string) => boolean | Promise<boolean>
}

export type IntentClassification =
  | { ok: true; request: CeilingRequest }
  | { ok: false; reason: 'ambiguous'; clarifyingQuestion: string; candidates: CeilingRequestKind[] }
  | { ok: false; reason: 'declined'; request: CeilingRequest }

// ---------------------------------------------------------------------------
// Heuristic pattern signal (Phase 13.4.1) - pure, synchronous, no LLM call.
// Patterns are deliberately shape-based, not bare keywords, where a bare
// keyword would be a real false-positive risk: "OR"/"AND"/"CALL" are
// common English words, so the instruction signal requires the WHOLE
// request to match assembly-line shape ("OPCODE OPERAND, OPERAND"), not
// just contain an opcode-shaped substring.
// ---------------------------------------------------------------------------

const INSTRUCTION_OPCODE_ALTERNATION = 'MOV|ADD|SUB|AND|OR|XOR|SHL|SHR|CMP|PUSH|POP|CALL|JE|JNE|JG|JL|JGE|JLE'
const INSTRUCTION_LINE_PATTERN = new RegExp(`^(${INSTRUCTION_OPCODE_ALTERNATION})\\s+[A-Za-z0-9[\\],\\s+*-]+$`, 'i')
const X86_REGISTER_PATTERN = /\b(RAX|RBX|RCX|RDX|RSP|RBP|RDI)\b/i

const HEURISTIC_PATTERNS: Record<CeilingRequestKind, RegExp[]> = {
  instruction: [INSTRUCTION_LINE_PATTERN, X86_REGISTER_PATTERN],
  patch: [/\bwrite a (typescript )?function\b/i, /\bimplement(ing)? a function\b/i, /\bexported function\b/i, /\breturns? a (number|string|boolean)\b/i],
  topology: [/\bmodule\b/i, /\bexports?\b/i, /\bimports? from\b/i, /\breachab(le|ility)\b/i, /\.tsx?\b/],
  claim: [/\bclaim\b/i, /\bassert(ion)?\b/i, /\bverify that\b/i, /\bprove that\b/i, /\bshould (return|equal)\b/i],
  spatial: [/\bsphere\b/i, /\btorus\b/i, /\b(union|intersection|subtraction)\b/i, /\bsdf\b/i, /\bcsg\b/i, /\bbounding box\b/i],
}

export interface HeuristicSignal {
  /** The clear winner (score > 0 and strictly higher than the runner-up), or null if none. */
  winner: CeilingRequestKind | null
  scores: Record<CeilingRequestKind, number>
}

export function computeHeuristicSignal(rawText: string): HeuristicSignal {
  const scores = Object.fromEntries(ALL_KINDS.map((kind) => [kind, HEURISTIC_PATTERNS[kind].filter((pattern) => pattern.test(rawText)).length])) as Record<
    CeilingRequestKind,
    number
  >

  const ranked = [...ALL_KINDS].sort((a, b) => scores[b] - scores[a])
  const [top, runnerUp] = ranked
  const winner = scores[top] > 0 && scores[top] > scores[runnerUp] ? top : null

  return { winner, scores }
}

// ---------------------------------------------------------------------------
// Bare-instruction extraction (fixes a real gap a live orchestration
// benchmark surfaced): CeilingRequest.description for kind 'instruction' is
// defined as "the x86 instruction text to translate" - a bare line like
// "ADD RAX, RBX" - but the LLM classification call is only asked to
// "rewrite as a clear, self-contained description," and a real local model
// doesn't reliably reduce a full sentence ("Translate the x86-64
// instruction ADD RAX, RBX into its ARM64 equivalent.") down to that bare
// form. Left as-is, instruction-floor.ts's parseInstruction takes the
// FIRST WORD as the opcode unconditionally - it found "TRANSLATE", which
// has no modeled semantics, so the Z3 symbolic gate reported "skipped, not
// a failure" rather than genuinely proving anything. The fix belongs here,
// not in instruction-floor.ts: that parser is a narrow, precise, heavily-
// tested oracle used by every existing 'instruction' call site, and
// loosening it to guess at embedded instructions would contaminate it with
// exactly the fuzzy substring-scraping this project has avoided everywhere
// else (the same reason INSTRUCTION_LINE_PATTERN above is anchored, not a
// bare keyword search).
//
// Extraction re-uses the SAME opcode alternation as the heuristic pattern
// (single source, no duplicated/drifting opcode list) and the real operand
// grammar lib/translator.ts's own resolveOperand accepts (a register name,
// a signed integer, or a bracketed memory/SIB expression) - not "any
// letters," which would happily swallow trailing prose ("ADD RAX, RBX
// into its ARM64 equivalent" is all letters and spaces). Only an
// UNAMBIGUOUS single match is trusted; zero or multiple matches return
// null so the caller can fail closed rather than guess which one was
// meant.
// ---------------------------------------------------------------------------

const OPERAND_TOKEN = '(?:RAX|RBX|RCX|RDX|RSP|RBP|RDI|-?\\d+|\\[[^\\]]*\\])'
const BARE_INSTRUCTION_EXTRACT_PATTERN = new RegExp(
  `\\b(?:${INSTRUCTION_OPCODE_ALTERNATION})\\s+${OPERAND_TOKEN}(?:\\s*,\\s*${OPERAND_TOKEN})*`,
  'gi'
)

export function extractBareInstruction(rawText: string): string | null {
  const matches = [...rawText.matchAll(BARE_INSTRUCTION_EXTRACT_PATTERN)]
  return matches.length === 1 ? matches[0][0].trim() : null
}

// ---------------------------------------------------------------------------
// LLM classification signal
// ---------------------------------------------------------------------------

function buildClassificationPrompt(rawText: string): string {
  return [
    'You are classifying a request into exactly one of five verification domains for an automated engineering verification system.',
    '',
    'Domains:',
    '- "instruction": a single x86-64 instruction to translate to ARM64 assembly (e.g. "MOV RAX, RBX").',
    '- "patch": a description of a single TypeScript function to generate.',
    '- "topology": a description of a TypeScript module/codebase layout (exports, types, cross-file reachability).',
    '- "claim": a description of a claim to verify empirically against real exported function behavior.',
    '- "spatial": a description of a 3D signed-distance-function (SDF) / CSG solid surface (spheres, boxes, tori, boolean operations).',
    '',
    `Request: "${rawText}"`,
    '',
    'Respond with ONLY a JSON object: { "kind": "instruction"|"patch"|"topology"|"claim"|"spatial", "description": "<the request, rewritten as a clear, self-contained description appropriate for that domain>", "confidence": "high"|"low" }',
    'No explanation, no markdown fences.',
  ].join('\n')
}

interface LlmSignal {
  kind: CeilingRequestKind
  description: string
  confidence: 'high' | 'low'
}

function isCeilingRequestKind(value: unknown): value is CeilingRequestKind {
  return typeof value === 'string' && (ALL_KINDS as string[]).includes(value)
}

/** Strict JSON-only parsing (fence-tolerant, via the same stripJsonFences this codebase already uses elsewhere) - never fuzzy text-scraped, matching this project's "never fabricate a confident answer" posture. */
function parseLlmSignal(raw: string): LlmSignal | null {
  try {
    const parsed = JSON.parse(stripJsonFences(raw)) as Partial<Record<keyof LlmSignal, unknown>>
    if (
      isCeilingRequestKind(parsed.kind) &&
      typeof parsed.description === 'string' &&
      parsed.description.trim().length > 0 &&
      (parsed.confidence === 'high' || parsed.confidence === 'low')
    ) {
      return { kind: parsed.kind, description: parsed.description, confidence: parsed.confidence }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Agreement + ambiguity reporting
// ---------------------------------------------------------------------------

function buildAmbiguousResult(heuristic: HeuristicSignal, llmSignal: LlmSignal | null, rawText: string): IntentClassification {
  const candidateSet = new Set<CeilingRequestKind>()
  for (const kind of ALL_KINDS) {
    if (heuristic.scores[kind] > 0) candidateSet.add(kind)
  }
  if (llmSignal) candidateSet.add(llmSignal.kind)
  const candidates = candidateSet.size > 0 ? [...candidateSet] : [...ALL_KINDS]

  const reasonText = !llmSignal
    ? 'the classifier response could not be parsed as a structured answer'
    : heuristic.winner && heuristic.winner !== llmSignal.kind
      ? `the request's shape looks like "${heuristic.winner}", but the classifier suggested "${llmSignal.kind}"`
      : 'the classifier was not confident enough without a clearer signal'

  return {
    ok: false,
    reason: 'ambiguous',
    clarifyingQuestion: `I couldn't confidently classify this request (${reasonText}). Which of these did you mean: ${candidates.join(', ')}? Original request: "${rawText}"`,
    candidates,
  }
}

async function gateOnAutonomy(request: CeilingRequest, options: IntentRouterOptions): Promise<IntentClassification> {
  const mode = options.executionMode ?? 'auto'
  if (mode === 'auto' || mode === 'auto-commit') {
    return { ok: true, request }
  }

  const approved = await (options.confirm ?? defaultConfirm)(`Classified as "${request.kind}": "${request.description}" - proceed?`)
  return approved ? { ok: true, request } : { ok: false, reason: 'declined', request }
}

// ---------------------------------------------------------------------------
// classifyIntent
// ---------------------------------------------------------------------------

export async function classifyIntent(rawText: string, llm: LlmClient, options: IntentRouterOptions = {}): Promise<IntentClassification> {
  const heuristic = computeHeuristicSignal(rawText)
  const llmRaw = await llm.complete(buildClassificationPrompt(rawText))
  const llmSignal = parseLlmSignal(llmRaw)

  if (!llmSignal) {
    return buildAmbiguousResult(heuristic, null, rawText)
  }

  const signalsAgree = heuristic.winner === null ? llmSignal.confidence === 'high' : heuristic.winner === llmSignal.kind
  if (!signalsAgree) {
    return buildAmbiguousResult(heuristic, llmSignal, rawText)
  }

  if (llmSignal.kind === 'instruction') {
    const bareInstruction = extractBareInstruction(rawText)
    if (!bareInstruction) {
      return {
        ok: false,
        reason: 'ambiguous',
        clarifyingQuestion:
          `This looks like an instruction-translation request, but I couldn't unambiguously extract a single bare x86 instruction ` +
          `(e.g. "ADD RAX, RBX") from it. Please provide just the instruction line. Original request: "${rawText}"`,
        candidates: ['instruction'],
      }
    }
    return gateOnAutonomy({ kind: 'instruction', description: bareInstruction }, options)
  }

  return gateOnAutonomy({ kind: llmSignal.kind, description: llmSignal.description }, options)
}
