import { Project, SyntaxKind } from 'ts-morph'
import { X86Register, registerMap, parseInstruction, JCC_CONDITIONS } from '../lib/translator'
import { getZ3, checkPushEquivalence, checkPopEquivalence, checkMemoryEquivalence } from './FloorEngine'
import { type VerificationFloor, type GateOutcome, runVerificationFloor } from './verification-floor'
import { TOPOLOGY_FLOOR, type TopologyCandidate } from './topology-floor'
import { CLAIM_VERIFICATION_FLOOR, type ClaimCandidate } from './claim-floor'
import { ParallelCandidateSampler } from './layer3/sampler'
import type { TemperatureStrategy } from './layer3/types'

// ---------------------------------------------------------------------------
// LLM client. A local Ollama or vLLM server both expose an OpenAI-compatible
// chat-completions endpoint (Ollama at `/v1/chat/completions`, vLLM at the
// same path), so that shape is the common denominator this targets. The
// client is injected, not hardcoded, so runCeilingAgent stays testable
// without a live server — see CeilingAgent.test.ts for the fake used there.
// ---------------------------------------------------------------------------

export interface LlmClient {
  complete(prompt: string, temperature?: number): Promise<string>
}

export interface OpenAiCompatibleClientOptions {
  baseUrl: string // e.g. 'http://localhost:11434/v1' (Ollama) or 'http://localhost:8000/v1' (vLLM)
  model: string
  apiKey?: string
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  constructor(private readonly options: OpenAiCompatibleClientOptions) {}

  async complete(prompt: string, temperature = 0): Promise<string> {
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
      }),
    })

    if (!response.ok) {
      throw new Error(`LLM endpoint ${this.options.baseUrl} returned ${response.status}: ${await response.text()}`)
    }

    const data: unknown = await response.json()
    const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('LLM response missing choices[0].message.content')
    }
    return content.trim()
  }
}

// ---------------------------------------------------------------------------
// Request / result shapes
// ---------------------------------------------------------------------------

export type CeilingRequestKind = 'instruction' | 'patch' | 'topology' | 'claim'

export interface CeilingRequest {
  kind: CeilingRequestKind
  /** 'instruction': the x86 instruction text to translate.
   *  'patch': a prose description of the TypeScript function to generate.
   *  'topology': a prose description of the module layout to propose.
   *  'claim': a prose description of the claim to produce and verify. */
  description: string
}

export interface GateCheckResult {
  gate: string
  ok: boolean
  details: string
}

export interface CeilingAttempt {
  attempt: number
  candidate: string
  failedGate: GateCheckResult
}

export interface CeilingSuccess {
  ok: true
  result: string
  attempts: number
  gates: GateCheckResult[]
  /** Attempts rejected before the successful one, in order. Empty on a first-try success. */
  history: CeilingAttempt[]
}

export interface CeilingFailureReport {
  request: CeilingRequest
  attempts: number
  history: CeilingAttempt[]
}

export class CeilingAgentExhaustedError extends Error {
  readonly report: CeilingFailureReport

  constructor(report: CeilingFailureReport) {
    super(
      `CeilingAgent exhausted ${report.attempts} attempt(s) without a verified solution for ` +
        `${report.request.kind} "${report.request.description}". ` +
        `Last failure (gate "${report.history[report.history.length - 1]?.failedGate.gate}"): ` +
        `${report.history[report.history.length - 1]?.failedGate.details}`
    )
    this.name = 'CeilingAgentExhaustedError'
    this.report = report
  }
}

const MAX_RETRIES_DEFAULT = 5
const ARM64_REGISTERS = new Set(['X0', 'X1', 'X2', 'X3', 'X4', 'X9', 'SP', 'FP'])

// ---------------------------------------------------------------------------
// 'instruction' mode verification: the candidate is a plain ARM64 text
// string, so nothing here ever touches disk or executes generated code.
//
// The symbolic gate reuses the exact z3-solver technique from
// FloorEngine's Gate 3, generalized from its fixed MOV/ADD/CMP corpus to
// any opcode with a known register-transfer semantic — including SUB/AND/
// OR/XOR, none of which lib/translator.ts implements today. That's the
// real point of this agent: extend coverage the deterministic pipeline
// doesn't have, with a genuine proof backing the extension, not a
// re-derivation of what translateInstruction already does deterministically.
// ---------------------------------------------------------------------------

type AluSemantics = 'transfer' | 'add' | 'sub' | 'and' | 'or' | 'xor' | 'shl' | 'shr' | 'compare'

const X86_SEMANTICS: Partial<Record<string, AluSemantics>> = {
  MOV: 'transfer',
  ADD: 'add',
  SUB: 'sub',
  AND: 'and',
  OR: 'or',
  XOR: 'xor',
  SHL: 'shl',
  SHR: 'shr',
  CMP: 'compare',
}

function isKnownX86Register(name: string): name is X86Register {
  return name in registerMap
}

function extractRegisterTokens(text: string): string[] {
  return text.match(/\bX[0-9]+\b|\bSP\b|\bFP\b/g) ?? []
}

function parseArm64Line(line: string): { opcode: string; operands: string[] } {
  const trimmed = line.trim()
  const firstSpace = trimmed.indexOf(' ')
  if (firstSpace === -1) return { opcode: trimmed, operands: [] }
  return {
    opcode: trimmed.slice(0, firstSpace),
    operands: trimmed
      .slice(firstSpace + 1)
      .split(',')
      .map((operand) => operand.trim()),
  }
}

function checkRegisterTokenValidity(candidate: string): GateOutcome<'fuzz'> {
  const tokens = extractRegisterTokens(candidate)
  const invalid = [...new Set(tokens.filter((t) => !ARM64_REGISTERS.has(t)))]
  if (invalid.length > 0) {
    return { gate: 'fuzz', ok: false, details: `unexpected ARM64 register token(s): ${invalid.join(', ')}` }
  }
  return { gate: 'fuzz', ok: true, details: `all ${tokens.length} register token(s) are valid ARM64 registers` }
}

async function checkSymbolicEquivalence(x86Instruction: string, candidate: string): Promise<GateOutcome<'symbolic'>> {
  const parsedX86 = parseInstruction(x86Instruction)
  if (!parsedX86) {
    return { gate: 'symbolic', ok: false, details: `cannot verify "${x86Instruction}": could not parse instruction` }
  }

  // PUSH/POP and memory/SIB MOV have real ground-truth models too, but of a
  // different shape (stack effects, address computation) than the register-
  // transfer ALU model below - FloorEngine.ts's Gate 3 already built and
  // tested exactly these proofs (Phase 1, Phase 1b), so they're reused here
  // via their candidateOverride parameter rather than re-derived.
  if (parsedX86.opcode === 'PUSH' && parsedX86.operands.length === 1) {
    return { ...(await checkPushEquivalence(x86Instruction, candidate)), gate: 'symbolic' }
  }
  if (parsedX86.opcode === 'POP' && parsedX86.operands.length === 1) {
    return { ...(await checkPopEquivalence(x86Instruction, candidate)), gate: 'symbolic' }
  }
  if (parsedX86.opcode === 'MOV' && parsedX86.operands.length === 2 && parsedX86.operands.some((op) => op.startsWith('['))) {
    return { ...(await checkMemoryEquivalence(x86Instruction, candidate)), gate: 'symbolic' }
  }

  // Opcode-lookup must happen BEFORE the arity check: JMP/Jcc/CALL/RET are
  // 0- or 1-operand and have no ground-truth model at all, so they must
  // report "skipped" regardless of operand count - not fail arity first.
  // (Bug found live: every control-flow task failed with "expected a
  // 2-operand instruction" until this ordering was fixed - the original
  // 2-operand-only benchmark tasks never exercised this path.)
  const semantics = X86_SEMANTICS[parsedX86.opcode]
  if (!semantics) {
    return {
      gate: 'symbolic',
      ok: true,
      details: `no ground-truth semantic model for opcode "${parsedX86.opcode}" - symbolic check skipped, not a failure`,
    }
  }

  if (parsedX86.operands.length !== 2) {
    return { gate: 'symbolic', ok: false, details: `cannot verify "${x86Instruction}": expected a 2-operand instruction` }
  }

  const [dstTok, srcTok] = parsedX86.operands.map((operand) => operand.toUpperCase())
  if (!isKnownX86Register(dstTok) || !isKnownX86Register(srcTok)) {
    return { gate: 'symbolic', ok: true, details: 'operands are not both plain registers - symbolic check skipped' }
  }

  const lines = candidate
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const parsedArm = parseArm64Line(lines[lines.length - 1] ?? '')
  const armDst = registerMap[dstTok]
  const armSrc = registerMap[srcTok]

  if (semantics === 'compare') {
    const isValidCmpShape =
      parsedArm.opcode.toUpperCase() === 'CMP' &&
      parsedArm.operands.length === 2 &&
      parsedArm.operands[0] === armDst &&
      parsedArm.operands[1] === armSrc
    return isValidCmpShape
      ? { gate: 'symbolic', ok: true, details: `CMP ${armDst}, ${armSrc} mutates no register, matching x86 CMP semantics` }
      : { gate: 'symbolic', ok: false, details: `expected "CMP ${armDst}, ${armSrc}", got "${lines[lines.length - 1] ?? ''}"` }
  }

  const { Context } = await getZ3()
  const { Solver, BitVec } = Context('ceiling-agent')
  const dst = BitVec.const('dst', 64)
  const src = BitVec.const('src', 64)

  // x86 SHR is a logical (zero-filling, unsigned) shift, matching ARM64's
  // LSR exactly - so this uses .lshr(), not .shr() (which is arithmetic/
  // sign-extending in z3-solver's API, confirmed empirically: .shr(4) and
  // .lshr(4) disagree for any value with the high bit set).
  function applyAlu(op: AluSemantics, a: typeof dst, b: typeof dst): typeof dst {
    switch (op) {
      case 'transfer':
        return b
      case 'add':
        return a.add(b)
      case 'sub':
        return a.sub(b)
      case 'and':
        return a.and(b)
      case 'or':
        return a.or(b)
      case 'xor':
        return a.xor(b)
      case 'shl':
        return a.shl(b)
      case 'shr':
        return a.lshr(b)
      case 'compare':
        return a
    }
  }

  const x86Post = applyAlu(semantics, dst, src)
  const armPre: Record<string, typeof dst> = { [armDst]: dst, [armSrc]: src }

  let armPost: typeof dst
  if (semantics === 'transfer') {
    if (parsedArm.opcode.toUpperCase() !== 'MOV' || parsedArm.operands.length !== 2) {
      return { gate: 'symbolic', ok: false, details: `expected "MOV ${armDst}, ${armSrc}", got "${lines[lines.length - 1] ?? ''}"` }
    }
    const [d, s] = parsedArm.operands
    if (d !== armDst || !(s in armPre)) {
      return { gate: 'symbolic', ok: false, details: `expected "MOV ${armDst}, ${armSrc}", got "${lines[lines.length - 1] ?? ''}"` }
    }
    armPost = armPre[s]
  } else {
    const armOp = parsedArm.opcode.toUpperCase()
    // ADD/SUB/AND share their x86 mnemonic on ARM64; bitwise OR/XOR/shifts do
    // not - ARM64 spells them ORR, EOR, LSL, LSR respectively.
    const expectedOp = { add: 'ADD', sub: 'SUB', and: 'AND', or: 'ORR', xor: 'EOR', shl: 'LSL', shr: 'LSR' }[semantics]
    if (armOp !== expectedOp || parsedArm.operands.length !== 3) {
      return {
        gate: 'symbolic',
        ok: false,
        details: `expected "${expectedOp} ${armDst}, ${armDst}, ${armSrc}", got "${lines[lines.length - 1] ?? ''}"`,
      }
    }
    const [d1, d2, s] = parsedArm.operands
    if (d1 !== armDst || d2 !== armDst || !(s in armPre)) {
      return {
        gate: 'symbolic',
        ok: false,
        details: `expected "${expectedOp} ${armDst}, ${armDst}, ${armSrc}", got "${lines[lines.length - 1] ?? ''}"`,
      }
    }
    armPost = applyAlu(semantics, dst, armPre[s])
  }

  const solver = new Solver()
  solver.add(x86Post.neq(armPost))
  const result = await solver.check()

  if (result === 'unsat') {
    return {
      gate: 'symbolic',
      ok: true,
      details: `Z3 proved "${x86Instruction}" and "${lines[lines.length - 1]}" are register-equivalent for all 64-bit values`,
    }
  }

  let counterexample: string = result
  if (result === 'sat') {
    const model = solver.model()
    counterexample = model
      .decls()
      .map((d) => `${d.name()}=${model.get(d).toString()}`)
      .join(', ')
  }
  return { gate: 'symbolic', ok: false, details: `Z3 found a disagreeing case (SAT model): ${counterexample}` }
}

// ARM64 register names and mnemonics are case-insensitive in real assembly
// (weaker local models sometimes emit lowercase, e.g. "ldr x0, [x1, ...]"),
// so verification normalizes to uppercase once here before any gate parses
// or compares it - every check below sees consistent-case text. This is
// case-FOLDING for verification only: the candidate returned to the caller
// (CeilingSuccess.result, CeilingAttempt.candidate) stays exactly as the
// model produced it, so reports show what the model actually said.
const CONDITION_CODES = Object.values(JCC_CONDITIONS)

function checkStaticShape(candidate: string): GateOutcome<'static'> {
  const lines = candidate
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) {
    return { gate: 'static', ok: false, details: 'candidate is empty' }
  }

  for (const line of lines) {
    const opcode = (line.split(/\s+/)[0] ?? '').toUpperCase()
    for (const cond of CONDITION_CODES) {
      if (opcode === `B${cond}`) {
        return {
          gate: 'static',
          ok: false,
          details: `malformed conditional branch mnemonic "${opcode}" in "${line}" - ARM64 requires dot notation: "B.${cond}"`,
        }
      }
    }
  }

  return { gate: 'static', ok: true, details: `${lines.length} non-blank line(s), no malformed branch mnemonics` }
}

// Expressing the three existing checks as a concrete VerificationFloor
// proves the generic plugin contract (src/verification-floor.ts) actually
// fits a real domain, not just a paper interface - this is the ARM64
// instruction-translation floor, alongside the codebase-topology floor
// (src/topology-floor.ts, Phase 4.1) and the claim-verification floor
// (src/claim-floor.ts, Phase 4.2).
interface Arm64InstructionCandidate {
  x86Instruction: string
  candidate: string
}

type Arm64GateName = 'static' | 'fuzz' | 'symbolic'

const ARM64_INSTRUCTION_FLOOR: VerificationFloor<Arm64InstructionCandidate, Arm64GateName> = {
  domain: 'arm64-instruction-translation',
  gates: [
    { name: 'static', check: ({ candidate }) => checkStaticShape(candidate) },
    { name: 'fuzz', check: ({ candidate }) => checkRegisterTokenValidity(candidate) },
    { name: 'symbolic', check: ({ x86Instruction, candidate }) => checkSymbolicEquivalence(x86Instruction, candidate) },
  ],
}

export async function verifyInstructionCandidate(x86Instruction: string, candidate: string): Promise<GateCheckResult[]> {
  // Register names and opcodes are case-insensitive in real ARM64 assembly;
  // normalized once here (see Phase 3.1) so every gate in the floor sees
  // consistent-case text, without mutating what's returned to the caller.
  const report = await runVerificationFloor(ARM64_INSTRUCTION_FLOOR, { x86Instruction, candidate: candidate.toUpperCase() })
  return report.gates
}

// ---------------------------------------------------------------------------
// 'patch' mode verification: the candidate is a TypeScript source snippet.
// Checked with ts-morph's in-memory filesystem only — no real file is ever
// written or read, and the code is never executed. Fuzz/symbolic gates are
// explicitly not applicable here: proving anything about arbitrary generated
// code would require actually running it, and executing untrusted
// LLM-generated code is a real security concern this scope deliberately
// avoids rather than papers over.
// ---------------------------------------------------------------------------

function verifyPatchCandidate(candidate: string): GateCheckResult[] {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } })

  let file
  try {
    file = project.createSourceFile('candidate.ts', candidate)
  } catch (error) {
    return [{ gate: 'static', ok: false, details: `not parseable TypeScript: ${error instanceof Error ? error.message : String(error)}` }]
  }

  const diagnostics = project.getPreEmitDiagnostics()
  if (diagnostics.length > 0) {
    return [{ gate: 'static', ok: false, details: `compile diagnostics: ${diagnostics.map((d) => d.getMessageText()).join('; ')}` }]
  }

  const anyUsages = file.getDescendantsOfKind(SyntaxKind.AnyKeyword)
  if (anyUsages.length > 0) {
    return [
      { gate: 'static', ok: false, details: `explicit "any" usage at line(s) ${anyUsages.map((n) => n.getStartLineNumber()).join(', ')}` },
    ]
  }

  if (!file.getFunctions().some((fn) => fn.isExported())) {
    return [{ gate: 'static', ok: false, details: 'candidate must export at least one function' }]
  }

  return [
    { gate: 'static', ok: true, details: '0 diagnostics, 0 "any" usages, at least one exported function' },
    { gate: 'fuzz', ok: true, details: 'not applicable to patch candidates: would require executing untrusted code' },
    { gate: 'symbolic', ok: true, details: 'not applicable to patch candidates: would require executing untrusted code' },
  ]
}

// ---------------------------------------------------------------------------
// 'topology' and 'claim' mode verification: the candidate is JSON text
// parsed into TOPOLOGY_FLOOR's / CLAIM_VERIFICATION_FLOOR's Candidate shape
// (src/topology-floor.ts, src/claim-floor.ts) and run through that floor
// unchanged - this is the generic VerificationFloor contract (Phase 4)
// driving domains beyond ARM64 instruction translation. Malformed JSON, or
// JSON missing a required array field, is caught here and reported as a
// failure of that floor's first gate, matching verifyPatchCandidate's
// "unparseable candidate fails the first gate" precedent - never left as an
// uncaught exception that would break the retry loop.
//
// A live benchmark run (scripts/benchmark-live.ts) found real local models
// wrapping their JSON in a ```json ... ``` fence despite the prompt
// explicitly saying "no markdown fences" - every fenced attempt failed
// JSON.parse identically, and since the model kept resubmitting the same
// fenced text on each retry, self-correction never happened across the
// whole retry budget. stripJsonFences extracts the first fenced block
// (with or without a language tag) from anywhere in the response - not
// just when the ENTIRE response is exactly the fence - so a model's own
// surrounding prose ("Here's the JSON:\n```json\n{...}\n```\nLet me know!")
// doesn't defeat it either (Phase 5.1). Falls back to the raw trimmed text
// when no fence is present, so a plain unfenced JSON response is unchanged.
// ---------------------------------------------------------------------------

const JSON_FENCE_PATTERN = /```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```/

function stripJsonFences(candidateText: string): string {
  const trimmed = candidateText.trim()
  const match = JSON_FENCE_PATTERN.exec(trimmed)
  return match ? match[1].trim() : trimmed
}

export async function verifyTopologyCandidate(candidateText: string): Promise<GateCheckResult[]> {
  try {
    const parsed = JSON.parse(stripJsonFences(candidateText)) as TopologyCandidate
    const report = await runVerificationFloor(TOPOLOGY_FLOOR, parsed)
    return report.gates
  } catch (error) {
    return [{ gate: TOPOLOGY_FLOOR.gates[0].name, ok: false, details: `candidate could not be verified: ${error instanceof Error ? error.message : String(error)}` }]
  }
}

export async function verifyClaimCandidate(candidateText: string): Promise<GateCheckResult[]> {
  try {
    const parsed = JSON.parse(stripJsonFences(candidateText)) as ClaimCandidate
    const report = await runVerificationFloor(CLAIM_VERIFICATION_FLOOR, parsed)
    return report.gates
  } catch (error) {
    return [{ gate: CLAIM_VERIFICATION_FLOOR.gates[0].name, ok: false, details: `candidate could not be verified: ${error instanceof Error ? error.message : String(error)}` }]
  }
}

// ---------------------------------------------------------------------------
// Retry loop
// ---------------------------------------------------------------------------

// The self-healing correction loop's whole value depends on this being
// deterministic (same request + same rejection history -> byte-identical
// prompt, always - no Date.now()/Math.random() anywhere near it) and on
// each rejected attempt's counterexample surfacing verbatim, not summarized
// or dropped: a Z3 gate's `details` already contains its SAT model (see
// checkSymbolicEquivalence's "Z3 found a disagreeing case (SAT model): ...")
// and a fast-check-driven gate's `details` would carry its own shrunk
// counterexample the same way - buildPrompt doesn't need to know which kind
// of gate produced the failure, only to pass its details through exactly.
export function buildPrompt(request: CeilingRequest, history: CeilingAttempt[]): string {
  const feedback = history
    .map(
      (a) =>
        `Attempt ${a.attempt} was rejected - gate "${a.failedGate.gate}".\n` +
        `Counterexample/details: ${a.failedGate.details}\n` +
        `Rejected candidate:\n${a.candidate}`
    )
    .join('\n\n')

  const header = PROMPT_HEADERS[request.kind](request.description)

  return feedback ? [...header, '', 'Previous attempts were rejected:', feedback, 'Fix the issue and try again.'].join('\n') : header.join('\n')
}

const PROMPT_HEADERS: Record<CeilingRequestKind, (description: string) => string[]> = {
  instruction: (description) => [
    'Translate this single x86-64 instruction to ARM64 assembly.',
    `x86 instruction: ${description}`,
    'Register mapping: RAX=X0, RBX=X1, RCX=X2, RDX=X3, RSP=SP, RBP=FP, RDI=X4.',
    'Respond with ONLY the ARM64 instruction text - no explanation, no markdown fences.',
  ],
  patch: (description) => [
    `Write a single exported TypeScript function implementing this: ${description}`,
    'Follow strict TypeScript (no "any"). Respond with ONLY the code - no explanation, no markdown fences.',
  ],
  topology: (description) => [
    `Propose a small TypeScript module layout satisfying this: ${description}`,
    'Respond with ONLY a JSON object matching the TopologyCandidate shape: ' +
      '{ inMemoryFiles: Record<filePath, sourceText>, expectedExports: [{ filePath, exportedNames }], ' +
      'reachability: [{ from: { filePath, functionName }, to: { filePath, functionName }, expectReachable }] } - ' +
      'no explanation, no markdown fences.',
  ],
  claim: (description) => [
    `Produce a claim verification payload for this: ${description}`,
    'Respond with ONLY a JSON object matching the ClaimCandidate shape: ' +
      '{ claims: [{ statement, subject: { modulePath, exportName }, assertion: { args, expected } }] } - ' +
      'no explanation, no markdown fences.',
  ],
}

// Dynamic multi-domain routing (Phase 5): each request kind maps to the
// verifier for its VerificationFloor, so runCeilingAgent's retry loop stays
// domain-agnostic - adding a new floor means adding one entry here, not a
// new branch in the loop itself.
const VERIFIERS: Record<CeilingRequestKind, (request: CeilingRequest, candidate: string) => Promise<GateCheckResult[]> | GateCheckResult[]> = {
  instruction: (request, candidate) => verifyInstructionCandidate(request.description, candidate),
  patch: (_request, candidate) => verifyPatchCandidate(candidate),
  topology: (_request, candidate) => verifyTopologyCandidate(candidate),
  claim: (_request, candidate) => verifyClaimCandidate(candidate),
}

// ---------------------------------------------------------------------------
// Phase 6: opt-in Best-of-N parallel sampling (ROADMAP.md §2 Layer 3),
// driven through src/layer3/sampler.ts's ParallelCandidateSampler - which
// itself drives the REAL generic VerificationFloor contract
// (src/verification-floor.ts), not a bespoke one-off. Off by default
// (options.bestOfN undefined -> the original sequential single-candidate
// loop, byte-identical to before Phase 6), so every existing caller and
// every ScriptedLlmClient-based test above - which assumes exactly one LLM
// call per attempt - is completely unaffected.
//
// runBestOfNRound wraps VERIFIERS[request.kind] (the SAME per-domain
// verifier the sequential path already uses) in a throwaway single-gate
// VerificationFloor<string, string> just to satisfy evaluateBestOfN's
// signature - the real, granular GateCheckResult[] for the round's chosen
// candidate is cached by candidate text (gatesByCandidate) rather than
// re-derived from that synthetic gate, so callers still see real gate names
// ('static'/'fuzz'/'symbolic', 'exports'/'types'/'reachability', etc.), never
// the synthetic 'combined' label. When no sampled candidate passes, the
// closest-to-passing candidate's REAL failed gate is pushed into `history`
// exactly like the sequential path would - the existing closed-loop
// self-healing (buildPrompt reading `history` on the next round) is what
// actually consumes that feedback; Phase 6 only changes how many diverse
// candidates feed it per round, not the healing mechanism itself.
// ---------------------------------------------------------------------------

export interface BestOfNOptions {
  sampleSize?: number
  baseTemperature?: number
  temperatureStrategy?: TemperatureStrategy
}

async function runSingleCandidateRound(
  request: CeilingRequest,
  llm: LlmClient,
  history: CeilingAttempt[]
): Promise<{ candidate: string; gates: GateCheckResult[] }> {
  const candidate = await llm.complete(buildPrompt(request, history))
  const gates = await VERIFIERS[request.kind](request, candidate)
  return { candidate, gates }
}

async function runBestOfNRound(
  request: CeilingRequest,
  llm: LlmClient,
  history: CeilingAttempt[],
  bestOfN: BestOfNOptions
): Promise<{ candidate: string; gates: GateCheckResult[] }> {
  const gatesByCandidate = new Map<string, GateCheckResult[]>()

  const floor: VerificationFloor<string, string> = {
    domain: request.kind,
    gates: [
      {
        name: 'combined',
        check: async (candidateText) => {
          let gates = gatesByCandidate.get(candidateText)
          if (!gates) {
            gates = await VERIFIERS[request.kind](request, candidateText)
            gatesByCandidate.set(candidateText, gates)
          }
          const failed = gates.find((g) => !g.ok)
          return failed
            ? { gate: failed.gate, ok: false, details: failed.details }
            : { gate: 'combined', ok: true, details: `all ${gates.length} gate(s) passed` }
        },
      },
    ],
  }

  const sampler = new ParallelCandidateSampler<string>({
    sampleSize: bestOfN.sampleSize ?? 4,
    baseTemperature: bestOfN.baseTemperature ?? 0.2,
    temperatureStrategy: bestOfN.temperatureStrategy ?? 'stepped',
    earlyExitOnSuccess: true,
  })

  const prompt = buildPrompt(request, history)
  const result = await sampler.evaluateBestOfN((temperature) => llm.complete(prompt, temperature), floor)

  const winner = result.selected
  if (!winner) {
    throw new Error(`runBestOfNRound: sampler produced no candidates (sampleSize=${bestOfN.sampleSize ?? 4})`)
  }

  const candidate = winner.candidate.payload
  const gates = gatesByCandidate.get(candidate) ?? []
  return { candidate, gates }
}

export async function runCeilingAgent(
  request: CeilingRequest,
  llm: LlmClient,
  options: { maxRetries?: number; bestOfN?: BestOfNOptions } = {}
): Promise<CeilingSuccess> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES_DEFAULT
  const history: CeilingAttempt[] = []

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { candidate, gates } = options.bestOfN
      ? await runBestOfNRound(request, llm, history, options.bestOfN)
      : await runSingleCandidateRound(request, llm, history)

    const failedGate = gates.find((g) => !g.ok)
    if (!failedGate) {
      return { ok: true, result: candidate, attempts: attempt, gates, history: [...history] }
    }
    history.push({ attempt, candidate, failedGate })
  }

  throw new CeilingAgentExhaustedError({ request, attempts: maxRetries, history })
}
