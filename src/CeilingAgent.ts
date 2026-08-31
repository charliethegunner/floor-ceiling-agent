import { Project, SyntaxKind } from 'ts-morph'
import { X86Register, registerMap, parseInstruction, JCC_CONDITIONS } from '../lib/translator'
import { getZ3, checkPushEquivalence, checkPopEquivalence, checkMemoryEquivalence } from './FloorEngine'
import { type VerificationFloor, runVerificationFloor } from './verification-floor'

// ---------------------------------------------------------------------------
// LLM client. A local Ollama or vLLM server both expose an OpenAI-compatible
// chat-completions endpoint (Ollama at `/v1/chat/completions`, vLLM at the
// same path), so that shape is the common denominator this targets. The
// client is injected, not hardcoded, so runCeilingAgent stays testable
// without a live server — see CeilingAgent.test.ts for the fake used there.
// ---------------------------------------------------------------------------

export interface LlmClient {
  complete(prompt: string): Promise<string>
}

export interface OpenAiCompatibleClientOptions {
  baseUrl: string // e.g. 'http://localhost:11434/v1' (Ollama) or 'http://localhost:8000/v1' (vLLM)
  model: string
  apiKey?: string
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  constructor(private readonly options: OpenAiCompatibleClientOptions) {}

  async complete(prompt: string): Promise<string> {
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
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

export type CeilingRequestKind = 'instruction' | 'patch'

export interface CeilingRequest {
  kind: CeilingRequestKind
  /** 'instruction': the x86 instruction text to translate.
   *  'patch': a prose description of the TypeScript function to generate. */
  description: string
}

export interface GateCheckResult {
  gate: 'static' | 'fuzz' | 'symbolic'
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

function checkRegisterTokenValidity(candidate: string): GateCheckResult {
  const tokens = extractRegisterTokens(candidate)
  const invalid = [...new Set(tokens.filter((t) => !ARM64_REGISTERS.has(t)))]
  if (invalid.length > 0) {
    return { gate: 'fuzz', ok: false, details: `unexpected ARM64 register token(s): ${invalid.join(', ')}` }
  }
  return { gate: 'fuzz', ok: true, details: `all ${tokens.length} register token(s) are valid ARM64 registers` }
}

async function checkSymbolicEquivalence(x86Instruction: string, candidate: string): Promise<GateCheckResult> {
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
    return checkPushEquivalence(x86Instruction, candidate)
  }
  if (parsedX86.opcode === 'POP' && parsedX86.operands.length === 1) {
    return checkPopEquivalence(x86Instruction, candidate)
  }
  if (parsedX86.opcode === 'MOV' && parsedX86.operands.length === 2 && parsedX86.operands.some((op) => op.startsWith('['))) {
    return checkMemoryEquivalence(x86Instruction, candidate)
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

function checkStaticShape(candidate: string): GateCheckResult {
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
// (src/topology-floor.ts, Phase 4.1) and the not-yet-implemented
// ClaimVerificationFloor placeholder verification-floor.ts still defines.
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

  const header =
    request.kind === 'instruction'
      ? [
          'Translate this single x86-64 instruction to ARM64 assembly.',
          `x86 instruction: ${request.description}`,
          'Register mapping: RAX=X0, RBX=X1, RCX=X2, RDX=X3, RSP=SP, RBP=FP, RDI=X4.',
          'Respond with ONLY the ARM64 instruction text - no explanation, no markdown fences.',
        ]
      : [
          `Write a single exported TypeScript function implementing this: ${request.description}`,
          'Follow strict TypeScript (no "any"). Respond with ONLY the code - no explanation, no markdown fences.',
        ]

  return feedback ? [...header, '', 'Previous attempts were rejected:', feedback, 'Fix the issue and try again.'].join('\n') : header.join('\n')
}

export async function runCeilingAgent(request: CeilingRequest, llm: LlmClient, options: { maxRetries?: number } = {}): Promise<CeilingSuccess> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES_DEFAULT
  const history: CeilingAttempt[] = []

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const candidate = await llm.complete(buildPrompt(request, history))
    const gates = request.kind === 'instruction' ? await verifyInstructionCandidate(request.description, candidate) : verifyPatchCandidate(candidate)

    const failedGate = gates.find((g) => !g.ok)
    if (!failedGate) {
      return { ok: true, result: candidate, attempts: attempt, gates, history: [...history] }
    }
    history.push({ attempt, candidate, failedGate })
  }

  throw new CeilingAgentExhaustedError({ request, attempts: maxRetries, history })
}
