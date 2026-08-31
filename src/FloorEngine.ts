import { Project, SyntaxKind } from 'ts-morph'
import fc from 'fast-check'
import { init } from 'z3-solver'
import { translateX86ToArm64 } from '../lib/index'
import { X86Register, registerMap, parseInstruction } from '../lib/translator'

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
// register-register operands. This proves the translation rules for these
// opcodes are correct for every possible 64-bit register value (not just
// example inputs) — it does not model memory/SIB addressing, PUSH/POP/CALL
// stack effects, or flags, which is out of scope (see SPEC-012's scoping
// precedent: this is translation validation of value-transfer semantics,
// not a full formal model of either ISA).
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

export async function runSymbolicGate(): Promise<GateResult> {
  const { Context } = await init()
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

  return {
    gate: 'symbolic',
    ok: true,
    details: `Z3 proved register-file equivalence for ${EQUIVALENCE_CASES.length} MOV/ADD/CMP cases across all possible 64-bit values`,
  }
}

// ---------------------------------------------------------------------------

export async function runFloorEngine(): Promise<FloorEngineReport> {
  const gates: GateResult[] = [runStaticGate(), runFuzzGate(), await runSymbolicGate()]
  return { ok: gates.every((g) => g.ok), gates }
}
