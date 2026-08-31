export type X86Register = 'RAX' | 'RBX' | 'RCX' | 'RDX' | 'RSP' | 'RBP' | 'RDI'
export type Arm64Register = 'X0' | 'X1' | 'X2' | 'X3' | 'X4' | 'SP' | 'FP'

export const registerMap: Record<X86Register, Arm64Register> = {
  RAX: 'X0',
  RBX: 'X1',
  RCX: 'X2',
  RDX: 'X3',
  RSP: 'SP',
  RBP: 'FP',
  RDI: 'X4',
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
  | { ok: true; kind: 'memory'; base: string; offset?: string }
  | { ok: true; kind: 'label'; value: string }
  | { ok: false; error: string }

function isX86Register(name: string): name is X86Register {
  return name in registerMap
}

const MEMORY_OPERAND_PATTERN = /^\[\s*([A-Za-z0-9]+)\s*(?:([+-])\s*(\d+))?\s*\]$/

function resolveOperand(operand: string): OperandResolution {
  const upper = operand.toUpperCase()
  if (isX86Register(upper)) {
    return { ok: true, kind: 'register', value: registerMap[upper] }
  }
  if (/^-?\d+$/.test(operand)) {
    return { ok: true, kind: 'immediate', value: `#${operand}` }
  }
  if (operand.startsWith('[')) {
    const match = MEMORY_OPERAND_PATTERN.exec(operand)
    const baseName = match?.[1].toUpperCase()
    if (!match || !baseName || !isX86Register(baseName)) {
      return { ok: false, error: `invalid operand: ${operand}` }
    }
    const [, , sign, magnitude] = match
    return {
      ok: true,
      kind: 'memory',
      base: registerMap[baseName],
      offset: magnitude && magnitude !== '0' ? `${sign === '-' ? '-' : ''}${magnitude}` : undefined,
    }
  }
  return { ok: false, error: `invalid operand: ${operand}` }
}

const LABEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function resolveJumpTarget(operand: string): OperandResolution {
  const upper = operand.toUpperCase()
  if (isX86Register(upper)) {
    return { ok: false, error: `invalid jump target: ${operand}` }
  }
  if (/^-?\d+$/.test(operand)) {
    return { ok: false, error: `invalid jump target: ${operand}` }
  }
  if (operand.startsWith('[')) {
    return { ok: false, error: `invalid jump target: ${operand}` }
  }
  if (!LABEL_PATTERN.test(operand)) {
    return { ok: false, error: `invalid jump target: ${operand}` }
  }
  return { ok: true, kind: 'label', value: operand }
}

const SUPPORTED_OPCODES = ['MOV', 'ADD', 'CMP', 'PUSH', 'POP', 'CALL', 'JE', 'JNE'] as const
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
  if (!parsed) {
    return { ok: false, error: `invalid instruction format: "${input}"` }
  }

  const { opcode, operands } = parsed
  if (!isSupportedOpcode(opcode)) {
    return { ok: false, error: `unsupported opcode: ${opcode}` }
  }

  if (opcode === 'PUSH' || opcode === 'POP') {
    if (operands.length !== 1) {
      return { ok: false, error: `invalid instruction format: "${input}"` }
    }
    const operand = resolveOperand(operands[0])
    if (!operand.ok) return operand
    if (operand.kind !== 'register') {
      return { ok: false, error: `${opcode} operand must be a register: ${operands[0]}` }
    }
    return opcode === 'PUSH'
      ? { ok: true, instruction: `STR ${operand.value}, [SP, #-8]!` }
      : { ok: true, instruction: `LDR ${operand.value}, [SP], #8` }
  }

  if (opcode === 'CALL') {
    if (operands.length !== 1) {
      return { ok: false, error: `invalid instruction format: "${input}"` }
    }
    const target = operands[0]
    if (target.startsWith('[')) {
      return { ok: false, error: `memory operand not supported for opcode: ${opcode}` }
    }
    const upperTarget = target.toUpperCase()
    if (isX86Register(upperTarget)) {
      return { ok: true, instruction: `BLR ${registerMap[upperTarget]}` }
    }
    return { ok: true, instruction: `BL ${target}` }
  }

  if (opcode === 'JE' || opcode === 'JNE') {
    if (operands.length !== 1) {
      return { ok: false, error: `invalid instruction format: "${input}"` }
    }
    const target = resolveJumpTarget(operands[0])
    if (!target.ok) return target
    if (target.kind !== 'label') {
      return { ok: false, error: `invalid jump target: ${operands[0]}` }
    }
    return { ok: true, instruction: `${opcode === 'JE' ? 'B.EQ' : 'B.NE'} ${target.value}` }
  }

  if (operands.length !== 2) {
    return { ok: false, error: `invalid instruction format: "${input}"` }
  }

  const dst = resolveOperand(operands[0])
  if (!dst.ok) return dst

  if (dst.kind === 'memory') {
    if (opcode !== 'MOV') {
      return { ok: false, error: `memory operand not supported for opcode: ${opcode}` }
    }
    const src = resolveOperand(operands[1])
    if (!src.ok) return src
    if (src.kind !== 'register') {
      return { ok: false, error: `source must be a register for a memory store: ${operands[1]}` }
    }
    const offset = dst.offset ? `, #${dst.offset}` : ''
    return { ok: true, instruction: `STR ${src.value}, [${dst.base}${offset}]` }
  }

  if (dst.kind !== 'register') {
    return { ok: false, error: `destination must be a register: ${operands[0]}` }
  }

  const src = resolveOperand(operands[1])
  if (!src.ok) return src

  if (src.kind === 'memory') {
    if (opcode !== 'MOV') {
      return { ok: false, error: `memory operand not supported for opcode: ${opcode}` }
    }
    const offset = src.offset ? `, #${src.offset}` : ''
    return { ok: true, instruction: `LDR ${dst.value}, [${src.base}${offset}]` }
  }

  if (opcode === 'MOV') {
    return { ok: true, instruction: `MOV ${dst.value}, ${src.value}` }
  }

  if (opcode === 'ADD') {
    return { ok: true, instruction: `ADD ${dst.value}, ${dst.value}, ${src.value}` }
  }

  return { ok: true, instruction: `CMP ${dst.value}, ${src.value}` }
}
