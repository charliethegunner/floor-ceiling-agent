import { Project, SyntaxKind } from 'ts-morph'
import fc from 'fast-check'
import { init } from 'z3-solver'
import { translateX86ToArm64 } from '../lib/index'
import { X86Register, registerMap, parseInstruction, parseX86MemoryOperand } from '../lib/translator'

// z3-solver's init() instantiates a fresh WASM module (allocating its own
// linear memory) on every call. runSymbolicGate can invoke a dozen+ checks
// in one run, and repeated fresh instantiations exhaust available WASM
// memory under Node - so the (expensive) module init is memoized once per
// process, while Context(name) - proven safe to call repeatedly with the
// same name across many independent checks - stays fresh per check.
let z3Module: ReturnType<typeof init> | undefined

export function getZ3(): ReturnType<typeof init> {
  if (z3Module === undefined) {
    z3Module = init()
  }
  return z3Module
}

export interface GateResult {
  gate: 'static' | 'fuzz' | 'symbolic'
  ok: boolean
  details: string
}

export interface FloorEngineReport {
  ok: boolean
  gates: GateResult[]
}

// ---------------------------------------------------------------------------
// Gate 1 (Static): ts-morph loads lib/ in-memory and checks compilation plus
// two AST-level invariants CLAUDE.md already mandates in prose: no explicit
// `any`, and a stable public entrypoint signature.
// ---------------------------------------------------------------------------

export function runStaticGate(): GateResult {
  const project = new Project({ tsConfigFilePath: 'tsconfig.json' })
  project.addSourceFilesAtPaths('lib/**/*.ts')
  const diagnostics = project.getPreEmitDiagnostics()

  if (diagnostics.length > 0) {
    const messages = diagnostics.map((d) => d.getMessageText()).join('; ')
    return { gate: 'static', ok: false, details: `compilation diagnostics: ${messages}` }
  }

  const indexFile = project.getSourceFile('lib/index.ts')
  const entrypoint = indexFile?.getFunction('translateX86ToArm64')
  if (!entrypoint || !entrypoint.isExported()) {
    return { gate: 'static', ok: false, details: 'translateX86ToArm64 is not an exported function in lib/index.ts' }
  }

  const params = entrypoint.getParameters()
  const paramTypeText = params[0]?.getTypeNode()?.getText()
  if (params.length !== 1 || paramTypeText !== 'string') {
    return { gate: 'static', ok: false, details: 'translateX86ToArm64 must take exactly one string parameter' }
  }

  const returnTypeText = entrypoint.getReturnTypeNode()?.getText()
  if (returnTypeText !== 'TranslationResult') {
    return { gate: 'static', ok: false, details: 'translateX86ToArm64 must return TranslationResult' }
  }

  const anyUsages = project.getSourceFiles().flatMap((file) => file.getDescendantsOfKind(SyntaxKind.AnyKeyword))
  if (anyUsages.length > 0) {
    const locations = anyUsages.map((n) => `${n.getSourceFile().getBaseName()}:${n.getStartLineNumber()}`).join(', ')
    return { gate: 'static', ok: false, details: `explicit "any" usage found at ${locations}` }
  }

  return {
    gate: 'static',
    ok: true,
    details: `${project.getSourceFiles().length} files compiled, 0 diagnostics, 0 "any" usages, entrypoint signature verified`,
  }
}

// ---------------------------------------------------------------------------
// Gate 2 (Fuzzing): property-test the ACTUAL emitted ARM64 output of the
// real pipeline for invariants no single unit test enumerates by hand:
// determinism, register-token validity, and label-reference integrity
// (every branch/jump/call-to-label target has a matching definition line).
// ---------------------------------------------------------------------------

const ARM64_REGISTERS = new Set(['X0', 'X1', 'X2', 'X3', 'X4', 'X9', 'SP', 'FP'])

const LABELS = ['start', 'loop', 'done', 'exit', 'a1', 'b2'] as const
const REGISTERS = ['RAX', 'RBX', 'RCX', 'RDX', 'RSP', 'RBP', 'RDI']
const CONDITIONAL_JUMPS = ['JE', 'JNE', 'JG', 'JL', 'JGE', 'JLE']

const labelArb = fc.constantFrom(...LABELS)
const registerArb = fc.constantFrom(...REGISTERS)

const lineArb = fc.oneof(
  { weight: 3, arbitrary: labelArb.map((l) => `${l}:`) },
  { weight: 2, arbitrary: labelArb.map((l) => `JMP ${l}`) },
  { weight: 2, arbitrary: fc.tuple(fc.constantFrom(...CONDITIONAL_JUMPS), labelArb).map(([op, l]) => `${op} ${l}`) },
  { weight: 2, arbitrary: fc.oneof(labelArb.map((l) => `CALL ${l}`), registerArb.map((r) => `CALL ${r}`)) },
  { weight: 1, arbitrary: fc.constant('RET') },
  { weight: 3, arbitrary: fc.tuple(registerArb, registerArb).map(([d, s]) => `MOV ${d}, ${s}`) },
  { weight: 1, arbitrary: fc.tuple(registerArb, registerArb).map(([d, s]) => `ADD ${d}, ${s}`) },
  { weight: 1, arbitrary: fc.tuple(registerArb, registerArb).map(([d, s]) => `CMP ${d}, ${s}`) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(registerArb, registerArb, registerArb, fc.constantFrom('1', '2', '4', '8'))
      .map(([d, b, idx, scale]) => `MOV ${d}, [${b} + ${idx}*${scale}]`),
  },
  { weight: 2, arbitrary: fc.constantFrom('', '   ', '\t') },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `???${s}???`) }
)

const programArb = fc.array(lineArb, { minLength: 0, maxLength: 30 }).map((lines) => lines.join('\n'))

function extractRegisterTokens(program: string): string[] {
  return program.match(/\bX[0-9]+\b|\bSP\b|\bFP\b/g) ?? []
}

function extractBranchTargets(program: string): string[] {
  const targets: string[] = []
  for (const line of program.split('\n')) {
    const match = /^(?:B|BL|B\.[A-Z]+) (\S+)$/.exec(line.trim())
    if (match && !ARM64_REGISTERS.has(match[1])) {
      targets.push(match[1])
    }
  }
  return targets
}

export function runFuzzGate(numRuns = 1000): GateResult {
  try {
    fc.assert(
      fc.property(programArb, (source) => {
        const first = translateX86ToArm64(source)
        const second = translateX86ToArm64(source)
        if (JSON.stringify(first) !== JSON.stringify(second)) {
          throw new Error(`non-deterministic result for source: ${JSON.stringify(source)}`)
        }
        if (!first.ok) return

        for (const token of extractRegisterTokens(first.instruction)) {
          if (!ARM64_REGISTERS.has(token)) {
            throw new Error(`unexpected ARM64 register token "${token}" in output for: ${JSON.stringify(source)}`)
          }
        }

        const definedLabels = new Set(
          first.instruction
            .split('\n')
            .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*:$/.test(line))
            .map((line) => line.slice(0, -1))
        )
        for (const target of extractBranchTargets(first.instruction)) {
          if (!definedLabels.has(target)) {
            throw new Error(`branch target "${target}" has no matching label definition for: ${JSON.stringify(source)}`)
          }
        }
      }),
      { numRuns }
    )
  } catch (error) {
    return { gate: 'fuzz', ok: false, details: error instanceof Error ? error.message : String(error) }
  }
  return {
    gate: 'fuzz',
    ok: true,
    details: `${numRuns} property runs passed: determinism, register-token validity, label-reference integrity`,
  }
}

// ---------------------------------------------------------------------------
// Gate 3 (Symbolic): Z3 proves register-file equivalence between an x86
// instruction and the REAL emitted ARM64 output for MOV/ADD/CMP over
// register-register operands, and (Phase 1, below) PUSH/POP with explicit
// RSP/SP tracking over the SMT theory of arrays. This proves the translation
// rules for these opcodes are correct for every possible 64-bit value (not
// just example inputs) — it does not model SIB addressing, CALL's stack
// effect, or flags, which remain out of scope (see SPEC-012's scoping
// precedent: this is translation validation of value-transfer and
// stack-transition semantics, not a full formal model of either ISA).
// ---------------------------------------------------------------------------

const SYMBOLIC_REGISTERS: X86Register[] = ['RAX', 'RBX', 'RCX', 'RDX']

const EQUIVALENCE_CASES = [
  'MOV RAX, RBX',
  'MOV RDX, RCX',
  'ADD RCX, RAX',
  'ADD RBX, RDX',
  'CMP RAX, RBX',
  'CMP RDX, RCX',
]

function parseArm64Line(line: string): { opcode: string; operands: string[] } {
  const trimmed = line.trim()
  const firstSpace = trimmed.indexOf(' ')
  const opcode = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
  const operands =
    firstSpace === -1
      ? []
      : trimmed
          .slice(firstSpace + 1)
          .split(',')
          .map((operand) => operand.trim())
  return { opcode, operands }
}

// ---------------------------------------------------------------------------
// Gate 3, Phase 1: PUSH/POP and RSP tracking.
//
// Memory is modeled as a Z3 Array from BitVec(64) to BitVec(64) - one 64-bit
// word per stack slot, matching the 8-byte increments PUSH/POP already use
// throughout this codebase. Ground truth is x86's fixed, ISA-defined
// behavior (PUSH always moves RSP by exactly 8; the read/write addresses are
// dictated by PUSH/POP's own semantics, not the candidate's). The
// candidate's own claimed offset is extracted from its ARM64 text via regex
// and compared against that ground truth, so a wrong constant (e.g. #-4
// instead of #-8) is a genuine Z3 disagreement, not a string-shape mismatch.
//
// Each check takes an optional `candidateOverride` so it can be exercised
// directly - with both a correct and a deliberately-wrong candidate - by
// unit tests, without needing to mock the real translation pipeline.
// ---------------------------------------------------------------------------

const PUSH_ARM64_PATTERN = /^STR\s+(\S+),\s*\[SP,\s*#(-?\d+)\]!$/
const POP_ARM64_PATTERN = /^LDR\s+(\S+),\s*\[SP\],\s*#(-?\d+)$/

type CandidateResolution = { ok: true; text: string } | { ok: false; details: string }

// ARM64 register names and mnemonics are case-insensitive in real assembly;
// normalizing here (rather than trusting every caller to pre-uppercase)
// means every check below sees consistent-case text regardless of which
// case a candidate override was written in. The real-pipeline path
// (translateX86ToArm64) is already uppercase, so this is a harmless no-op
// there - it only matters for arbitrary candidate text, e.g. from an LLM.
function resolveCandidate(x86Line: string, candidateOverride: string | undefined): CandidateResolution {
  if (candidateOverride !== undefined) return { ok: true, text: candidateOverride.toUpperCase() }
  const translated = translateX86ToArm64(x86Line)
  if (!translated.ok) return { ok: false, details: `pipeline failed to translate "${x86Line}": ${translated.error}` }
  return { ok: true, text: translated.instruction.toUpperCase() }
}

export async function checkPushEquivalence(x86Line: string, candidateOverride?: string): Promise<GateResult> {
  const parsedX86 = parseInstruction(x86Line)
  if (!parsedX86 || parsedX86.opcode !== 'PUSH' || parsedX86.operands.length !== 1) {
    return { gate: 'symbolic', ok: false, details: `expected a single-operand PUSH instruction, got "${x86Line}"` }
  }
  const [regTok] = parsedX86.operands as [X86Register]
  const armReg = registerMap[regTok]

  const resolved = resolveCandidate(x86Line, candidateOverride)
  if (!resolved.ok) return { gate: 'symbolic', ok: false, details: resolved.details }

  const match = PUSH_ARM64_PATTERN.exec(resolved.text.trim())
  if (!match) {
    return { gate: 'symbolic', ok: false, details: `expected "STR ${armReg}, [SP, #-8]!" shape, got "${resolved.text}"` }
  }
  const [, candReg, offsetText] = match
  if (candReg !== armReg) {
    return { gate: 'symbolic', ok: false, details: `expected destination register ${armReg}, got ${candReg}` }
  }

  const { Context } = await getZ3()
  const { Solver, BitVec, Array: Z3Array, Or } = Context('floor-engine-stack')
  const rsp = BitVec.const('rsp', 64)
  const regVal = BitVec.const('regVal', 64)
  const mem = Z3Array.const('mem', BitVec.sort(64), BitVec.sort(64))

  const x86RspPost = rsp.sub(8)
  const x86MemPost = mem.store(x86RspPost, regVal)

  const candRspPost = rsp.add(Number(offsetText))
  const candMemPost = mem.store(candRspPost, regVal)

  const solver = new Solver()
  solver.add(Or(x86RspPost.neq(candRspPost), x86MemPost.neq(candMemPost)))
  const result = await solver.check()

  if (result !== 'unsat') {
    return { gate: 'symbolic', ok: false, details: `Z3 disproved PUSH equivalence for "${x86Line}" -> "${resolved.text}" (${result})` }
  }
  return {
    gate: 'symbolic',
    ok: true,
    details: `Z3 proved "${x86Line}" -> "${resolved.text}" correctly decrements RSP by 8 and stores at the new top of stack`,
  }
}

export async function checkPopEquivalence(x86Line: string, candidateOverride?: string): Promise<GateResult> {
  const parsedX86 = parseInstruction(x86Line)
  if (!parsedX86 || parsedX86.opcode !== 'POP' || parsedX86.operands.length !== 1) {
    return { gate: 'symbolic', ok: false, details: `expected a single-operand POP instruction, got "${x86Line}"` }
  }
  const [regTok] = parsedX86.operands as [X86Register]
  const armReg = registerMap[regTok]

  const resolved = resolveCandidate(x86Line, candidateOverride)
  if (!resolved.ok) return { gate: 'symbolic', ok: false, details: resolved.details }

  const match = POP_ARM64_PATTERN.exec(resolved.text.trim())
  if (!match) {
    return { gate: 'symbolic', ok: false, details: `expected "LDR ${armReg}, [SP], #8" shape, got "${resolved.text}"` }
  }
  const [, candReg, offsetText] = match
  if (candReg !== armReg) {
    return { gate: 'symbolic', ok: false, details: `expected destination register ${armReg}, got ${candReg}` }
  }

  const { Context } = await getZ3()
  const { Solver, BitVec, Array: Z3Array, Or } = Context('floor-engine-stack')
  const rsp = BitVec.const('rsp', 64)
  const mem = Z3Array.const('mem', BitVec.sort(64), BitVec.sort(64))

  // Post-indexed LDR always reads at the pre-update address, regardless of
  // the offset - only the resulting RSP can disagree with a wrong offset.
  const x86DstPost = mem.select(rsp)
  const x86RspPost = rsp.add(8)
  const candDstPost = mem.select(rsp)
  const candRspPost = rsp.add(Number(offsetText))

  const solver = new Solver()
  solver.add(Or(x86DstPost.neq(candDstPost), x86RspPost.neq(candRspPost)))
  const result = await solver.check()

  if (result !== 'unsat') {
    return { gate: 'symbolic', ok: false, details: `Z3 disproved POP equivalence for "${x86Line}" -> "${resolved.text}" (${result})` }
  }
  return {
    gate: 'symbolic',
    ok: true,
    details: `Z3 proved "${x86Line}" -> "${resolved.text}" correctly loads from the top of stack and increments RSP by 8`,
  }
}

export async function checkPushPopRoundTrip(register: X86Register, candidateOverride?: string): Promise<GateResult> {
  const armReg = registerMap[register]
  const resolved = resolveCandidate(`PUSH ${register}\nPOP ${register}`, candidateOverride)
  if (!resolved.ok) return { gate: 'symbolic', ok: false, details: resolved.details }

  const lines = resolved.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length !== 2) {
    return { gate: 'symbolic', ok: false, details: `expected a 2-line PUSH+POP program, got: "${resolved.text}"` }
  }

  const pushMatch = PUSH_ARM64_PATTERN.exec(lines[0])
  const popMatch = POP_ARM64_PATTERN.exec(lines[1])
  if (!pushMatch || !popMatch) {
    return {
      gate: 'symbolic',
      ok: false,
      details: `expected "STR ${armReg}, [SP, #-8]!" then "LDR ${armReg}, [SP], #8", got: "${resolved.text}"`,
    }
  }
  const [, pushReg, pushOffsetText] = pushMatch
  const [, popReg, popOffsetText] = popMatch
  if (pushReg !== armReg || popReg !== armReg) {
    return { gate: 'symbolic', ok: false, details: `expected both lines to reference ${armReg}, got push=${pushReg} pop=${popReg}` }
  }

  const { Context } = await getZ3()
  const { Solver, BitVec, Array: Z3Array, Or } = Context('floor-engine-stack')
  const rsp = BitVec.const('rsp', 64)
  const regVal = BitVec.const('regVal', 64)
  const mem = Z3Array.const('mem', BitVec.sort(64), BitVec.sort(64))

  const rspAfterPush = rsp.add(Number(pushOffsetText))
  const memAfterPush = mem.store(rspAfterPush, regVal)
  const dstAfterPop = memAfterPush.select(rspAfterPush)
  const rspAfterPop = rspAfterPush.add(Number(popOffsetText))

  const solver = new Solver()
  // Valid stack discipline: popping what you just pushed returns the
  // original value and restores RSP to exactly where it started.
  solver.add(Or(dstAfterPop.neq(regVal), rspAfterPop.neq(rsp)))
  const result = await solver.check()

  if (result !== 'unsat') {
    return { gate: 'symbolic', ok: false, details: `Z3 disproved the PUSH/POP round trip for ${register} -> "${resolved.text}" (${result})` }
  }
  return {
    gate: 'symbolic',
    ok: true,
    details: `Z3 proved PUSH ${register} then POP ${register} restores both ${armReg} and RSP for all possible values`,
  }
}

// ---------------------------------------------------------------------------
// Gate 3, Phase 1b: SIB addressing (base + index*scale + displacement) and
// plain memory displacements for MOV load/store.
//
// The interesting bug surface here is address computation, not memory
// theory, so the proof target is address equivalence: the x86 ground-truth
// address is base + index*scale + disp using x86's own SIB definition
// (scale as a multiplier); the ARM64 candidate's address is reconstructed
// from its own text using ARM64's actual instruction (LSL as a shift, plus
// - for the SIB-with-displacement case - the scratch-register ADD SPEC-008
// introduced). Proving `index.mul(scale) == index.shl(shift)` for the
// correct shift is exactly re-verifying SPEC-008's SCALE_TO_SHIFT table
// symbolically, not just against the fixed examples in translator.test.ts.
// Both are then folded into a Select/Store equivalence proof (matching the
// Phase 1 PUSH/POP style) so a wrong address is a genuine Z3 disagreement,
// not a string comparison.
// ---------------------------------------------------------------------------

const LOAD_STORE_SIB_PATTERN = /^(LDR|STR)\s+(\S+),\s*\[(\S+),\s*(\S+),\s*LSL\s*#(\d+)\]$/
const LOAD_STORE_PLAIN_PATTERN = /^(LDR|STR)\s+(\S+),\s*\[(\S+)(?:,\s*#(-?\d+))?\]$/
const ADD_SCRATCH_PATTERN = /^ADD\s+(\S+),\s*(\S+),\s*#(-?\d+)$/
const SIB_SCRATCH_REGISTER = 'X9'

interface CandidateMemoryAddress {
  opcode: 'LDR' | 'STR'
  reg: string
  base: string
  index?: string
  shift?: number
  disp: number
}

function parseCandidateMemoryLines(lines: string[]): { ok: true; value: CandidateMemoryAddress } | { ok: false; details: string } {
  if (lines.length === 1) {
    const sibMatch = LOAD_STORE_SIB_PATTERN.exec(lines[0])
    if (sibMatch) {
      const [, opcode, reg, base, index, shift] = sibMatch
      return { ok: true, value: { opcode: opcode as 'LDR' | 'STR', reg, base, index, shift: Number(shift), disp: 0 } }
    }
    const plainMatch = LOAD_STORE_PLAIN_PATTERN.exec(lines[0])
    if (plainMatch) {
      const [, opcode, reg, base, dispText] = plainMatch
      return { ok: true, value: { opcode: opcode as 'LDR' | 'STR', reg, base, disp: dispText ? Number(dispText) : 0 } }
    }
    return { ok: false, details: `could not parse memory instruction shape: "${lines[0]}"` }
  }
  if (lines.length === 2) {
    const addMatch = ADD_SCRATCH_PATTERN.exec(lines[0])
    const sibMatch = LOAD_STORE_SIB_PATTERN.exec(lines[1])
    if (!addMatch || !sibMatch) {
      return { ok: false, details: `expected a scratch-register ADD followed by a SIB LDR/STR, got: "${lines.join(' | ')}"` }
    }
    const [, scratchDst, addBase, addDisp] = addMatch
    const [, opcode, reg, sibBase, index, shift] = sibMatch
    if (scratchDst !== SIB_SCRATCH_REGISTER || sibBase !== SIB_SCRATCH_REGISTER) {
      return { ok: false, details: `expected the scratch register to be ${SIB_SCRATCH_REGISTER}, got: "${lines.join(' | ')}"` }
    }
    return {
      ok: true,
      value: { opcode: opcode as 'LDR' | 'STR', reg, base: addBase, index, shift: Number(shift), disp: Number(addDisp) },
    }
  }
  return { ok: false, details: `expected 1 or 2 lines for a memory instruction, got ${lines.length}: "${lines.join(' | ')}"` }
}

function isKnownX86Register(name: string): name is X86Register {
  return name in registerMap
}

export async function checkMemoryEquivalence(x86Instruction: string, candidateOverride?: string): Promise<GateResult> {
  const parsedX86 = parseInstruction(x86Instruction)
  if (!parsedX86 || parsedX86.opcode !== 'MOV' || parsedX86.operands.length !== 2) {
    return { gate: 'symbolic', ok: false, details: `expected a 2-operand MOV instruction, got "${x86Instruction}"` }
  }

  const [op0, op1] = parsedX86.operands
  const dstMem = parseX86MemoryOperand(op0)
  const srcMem = parseX86MemoryOperand(op1)
  if ((dstMem === null) === (srcMem === null)) {
    return { gate: 'symbolic', ok: false, details: `expected exactly one memory operand in "${x86Instruction}"` }
  }
  const isStore = dstMem !== null
  const memOperand = isStore ? dstMem : srcMem
  const regTok = isStore ? op1 : op0
  if (!isKnownX86Register(regTok)) {
    return { gate: 'symbolic', ok: false, details: `expected a register operand alongside the memory operand in "${x86Instruction}"` }
  }
  if (!memOperand) {
    return { gate: 'symbolic', ok: false, details: `internal error: memory operand missing for "${x86Instruction}"` }
  }

  const resolved = resolveCandidate(x86Instruction, candidateOverride)
  if (!resolved.ok) return { gate: 'symbolic', ok: false, details: resolved.details }

  const lines = resolved.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const parsedCand = parseCandidateMemoryLines(lines)
  if (!parsedCand.ok) return { gate: 'symbolic', ok: false, details: parsedCand.details }
  const cand = parsedCand.value

  const expectedOpcode = isStore ? 'STR' : 'LDR'
  if (cand.opcode !== expectedOpcode) {
    return { gate: 'symbolic', ok: false, details: `expected ${expectedOpcode}, got ${cand.opcode} in "${resolved.text}"` }
  }
  const armReg = registerMap[regTok]
  if (cand.reg !== armReg) {
    return { gate: 'symbolic', ok: false, details: `expected register ${armReg}, got ${cand.reg} in "${resolved.text}"` }
  }
  const armBase = registerMap[memOperand.base]
  if (cand.base !== armBase) {
    return { gate: 'symbolic', ok: false, details: `expected base register ${armBase}, got ${cand.base} in "${resolved.text}"` }
  }
  if (memOperand.index !== undefined) {
    const armIndex = registerMap[memOperand.index]
    if (cand.index !== armIndex) {
      return { gate: 'symbolic', ok: false, details: `expected index register ${armIndex}, got ${cand.index ?? '(none)'} in "${resolved.text}"` }
    }
  } else if (cand.index !== undefined) {
    return { gate: 'symbolic', ok: false, details: `unexpected index register ${cand.index} in "${resolved.text}"` }
  }

  const { Context } = await getZ3()
  const { Solver, BitVec, Array: Z3Array } = Context('floor-engine-memory')
  const base = BitVec.const('base', 64)
  const regVal = BitVec.const('regVal', 64)
  const mem = Z3Array.const('mem', BitVec.sort(64), BitVec.sort(64))
  const index = memOperand.index !== undefined ? BitVec.const('index', 64) : undefined

  let x86Addr = base
  if (index !== undefined && memOperand.scale !== undefined) x86Addr = x86Addr.add(index.mul(memOperand.scale))
  if (memOperand.displacement !== 0) x86Addr = x86Addr.add(memOperand.displacement)

  let candAddr = base
  if (index !== undefined && cand.shift !== undefined) candAddr = candAddr.add(index.shl(cand.shift))
  if (cand.disp !== 0) candAddr = candAddr.add(cand.disp)

  const solver = new Solver()
  const result = await (async () => {
    if (isStore) {
      solver.add(mem.store(x86Addr, regVal).neq(mem.store(candAddr, regVal)))
    } else {
      solver.add(mem.select(x86Addr).neq(mem.select(candAddr)))
    }
    return solver.check()
  })()

  if (result !== 'unsat') {
    return {
      gate: 'symbolic',
      ok: false,
      details: `Z3 disproved memory ${isStore ? 'store' : 'load'} equivalence for "${x86Instruction}" -> "${resolved.text}" (${result})`,
    }
  }
  return {
    gate: 'symbolic',
    ok: true,
    details: `Z3 proved "${x86Instruction}" -> "${resolved.text}" computes the same effective address and ${isStore ? 'resulting memory state' : 'loaded value'} for all possible register values`,
  }
}

const STACK_CASES = ['PUSH RAX', 'PUSH RDI', 'POP RBX', 'POP RCX']
const ROUND_TRIP_REGISTERS: X86Register[] = ['RAX', 'RDI']
const MEMORY_CASES = [
  'MOV RAX, [RBX]',
  'MOV [RBX], RAX',
  'MOV RAX, [RBX + 16]',
  'MOV [RBX + 16], RAX',
  'MOV RAX, [RBX + RCX*4]',
  'MOV [RBX + RCX*4], RAX',
  'MOV RAX, [RBX + RCX*4 + 32]',
  'MOV [RBX + RCX*4 + 32], RAX',
]

export async function runSymbolicGate(): Promise<GateResult> {
  const { Context } = await getZ3()
  const { Solver, BitVec, Or } = Context('floor-engine')
  const WIDTH = 64

  for (const x86Line of EQUIVALENCE_CASES) {
    const translated = translateX86ToArm64(x86Line)
    if (!translated.ok) {
      return { gate: 'symbolic', ok: false, details: `pipeline failed to translate "${x86Line}": ${translated.error}` }
    }

    const parsedX86 = parseInstruction(x86Line)
    if (!parsedX86) {
      return { gate: 'symbolic', ok: false, details: `internal error: could not parse test case "${x86Line}"` }
    }

    const sym = Object.fromEntries(SYMBOLIC_REGISTERS.map((r) => [r, BitVec.const(r, WIDTH)])) as Record<
      X86Register,
      ReturnType<typeof BitVec.const>
    >

    const x86Post: Record<X86Register, ReturnType<typeof BitVec.const>> = { ...sym }
    const [dst, src] = parsedX86.operands as [X86Register, X86Register]
    if (parsedX86.opcode === 'MOV') x86Post[dst] = sym[src]
    else if (parsedX86.opcode === 'ADD') x86Post[dst] = sym[dst].add(sym[src])
    // CMP: register file unchanged (flags are not modeled, per SPEC-006)

    const armPre = Object.fromEntries(
      SYMBOLIC_REGISTERS.map((r) => [registerMap[r], sym[r]])
    ) as Record<string, ReturnType<typeof BitVec.const>>

    const parsedArm = parseArm64Line(translated.instruction)
    const armPost: Record<string, ReturnType<typeof BitVec.const>> = { ...armPre }
    if (parsedArm.opcode === 'MOV') {
      armPost[parsedArm.operands[0]] = armPre[parsedArm.operands[1]]
    } else if (parsedArm.opcode === 'ADD') {
      armPost[parsedArm.operands[0]] = armPre[parsedArm.operands[1]].add(armPre[parsedArm.operands[2]])
    }
    // CMP: register file unchanged

    const solver = new Solver()
    const disagreements = SYMBOLIC_REGISTERS.map((r) => x86Post[r].neq(armPost[registerMap[r]]))
    solver.add(Or(...disagreements))
    const result = await solver.check()

    if (result !== 'unsat') {
      return {
        gate: 'symbolic',
        ok: false,
        details: `equivalence disproven for "${x86Line}" -> "${translated.instruction}" (z3 found a counterexample: ${result})`,
      }
    }
  }

  for (const x86Line of STACK_CASES) {
    const result = x86Line.startsWith('PUSH') ? await checkPushEquivalence(x86Line) : await checkPopEquivalence(x86Line)
    if (!result.ok) return result
  }
  for (const register of ROUND_TRIP_REGISTERS) {
    const result = await checkPushPopRoundTrip(register)
    if (!result.ok) return result
  }
  for (const x86Line of MEMORY_CASES) {
    const result = await checkMemoryEquivalence(x86Line)
    if (!result.ok) return result
  }

  return {
    gate: 'symbolic',
    ok: true,
    details:
      `Z3 proved register-file equivalence for ${EQUIVALENCE_CASES.length} MOV/ADD/CMP cases, ` +
      `${STACK_CASES.length} PUSH/POP stack transitions, ${ROUND_TRIP_REGISTERS.length} PUSH/POP round trips, and ` +
      `${MEMORY_CASES.length} SIB/displacement memory load-store cases, all across every possible 64-bit value`,
  }
}

// ---------------------------------------------------------------------------

export async function runFloorEngine(): Promise<FloorEngineReport> {
  const gates: GateResult[] = [runStaticGate(), runFuzzGate(), await runSymbolicGate()]
  return { ok: gates.every((g) => g.ok), gates }
}
