export type X86Register = 'RAX' | 'RBX' | 'RCX' | 'RDX' | 'RSP' | 'RBP'
export type Arm64Register = 'X0' | 'X1' | 'X2' | 'X3' | 'SP' | 'FP'

export const registerMap: Record<X86Register, Arm64Register> = {
  RAX: 'X0',
  RBX: 'X1',
  RCX: 'X2',
  RDX: 'X3',
  RSP: 'SP',
  RBP: 'FP',
}

export interface TranslationSuccess {
  ok: true
  instruction: string
}

export interface TranslationError {
  ok: false
  error: string
}

export type TranslationResult = TranslationSuccess | TranslationError

type OperandResolution =
  | { ok: true; kind: 'register'; value: string }
  | { ok: true; kind: 'immediate'; value: string }
  | { ok: false; error: string }

function isX86Register(name: string): name is X86Register {
  return name in registerMap
}

function resolveOperand(operand: string): OperandResolution {
  const upper = operand.toUpperCase()
  if (isX86Register(upper)) {
    return { ok: true, kind: 'register', value: registerMap[upper] }
  }
  if (/^-?\d+$/.test(operand)) {
    return { ok: true, kind: 'immediate', value: `#${operand}` }
  }
  return { ok: false, error: `invalid operand: ${operand}` }
}

const SUPPORTED_OPCODES = ['MOV', 'ADD'] as const
type SupportedOpcode = (typeof SUPPORTED_OPCODES)[number]

function isSupportedOpcode(opcode: string): opcode is SupportedOpcode {
  return (SUPPORTED_OPCODES as readonly string[]).includes(opcode)
}

interface ParsedInstruction {
  opcode: string
  operands: string[]
}

function parseInstruction(input: string): ParsedInstruction | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  const firstSpace = trimmed.indexOf(' ')
  if (firstSpace === -1) return null

  const opcode = trimmed.slice(0, firstSpace).toUpperCase()
  const operands = trimmed
    .slice(firstSpace + 1)
    .split(',')
    .map((operand) => operand.trim())
    .filter((operand) => operand.length > 0)

  return { opcode, operands }
}

export function translateInstruction(input: string): TranslationResult {
  const parsed = parseInstruction(input)
  if (!parsed || parsed.operands.length !== 2) {
    return { ok: false, error: `invalid instruction format: "${input}"` }
  }

  const { opcode, operands } = parsed
  if (!isSupportedOpcode(opcode)) {
    return { ok: false, error: `unsupported opcode: ${opcode}` }
  }

  const dst = resolveOperand(operands[0])
  if (!dst.ok) return dst
  if (dst.kind === 'immediate') {
    return { ok: false, error: `destination must be a register: ${operands[0]}` }
  }

  const src = resolveOperand(operands[1])
  if (!src.ok) return src

  if (opcode === 'MOV') {
    return { ok: true, instruction: `MOV ${dst.value}, ${src.value}` }
  }

  return { ok: true, instruction: `ADD ${dst.value}, ${dst.value}, ${src.value}` }
}
