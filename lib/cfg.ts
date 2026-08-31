import { JCC_CONDITIONS, parseInstruction, registerMap } from './translator'

export type TerminatorKind =
  | { kind: 'jump'; target: string }
  | { kind: 'branch'; target: string }
  | { kind: 'call' }
  | { kind: 'return' }
  | { kind: 'fallthrough' }

export interface BasicBlock {
  id: number
  label: string | null
  startLine: number
  instructions: string[]
  terminator: TerminatorKind
}

export interface CfgSuccess {
  ok: true
  blocks: BasicBlock[]
  successors: Record<number, number[]>
  predecessors: Record<number, number[]>
}

export interface CfgError {
  ok: false
  error: string
}

export type CfgResult = CfgSuccess | CfgError

const CONDITIONAL_JUMP_OPCODES = new Set(Object.keys(JCC_CONDITIONS))
const LABEL_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*):$/

interface RawLine {
  lineNumber: number
  text: string
}

type ClassifiedLine =
  | { type: 'label'; name: string; lineNumber: number }
  | { type: 'instruction'; opcode: string; operands: string[]; lineNumber: number; text: string }

type ClassifyResult = { ok: true; lines: ClassifiedLine[] } | CfgError

function classifyLines(source: string): ClassifyResult {
  const rawLines: RawLine[] = source
    .split('\n')
    .map((text, index) => ({ lineNumber: index + 1, text: text.trim() }))
    .filter((line) => line.text.length > 0)

  const lines: ClassifiedLine[] = []
  for (const rawLine of rawLines) {
    const labelMatch = LABEL_LINE_PATTERN.exec(rawLine.text)
    if (labelMatch) {
      lines.push({ type: 'label', name: labelMatch[1], lineNumber: rawLine.lineNumber })
      continue
    }
    const parsed = parseInstruction(rawLine.text)
    if (!parsed) {
      return { ok: false, error: `invalid instruction format at line ${rawLine.lineNumber}: "${rawLine.text}"` }
    }
    lines.push({
      type: 'instruction',
      opcode: parsed.opcode,
      operands: parsed.operands,
      lineNumber: rawLine.lineNumber,
      text: rawLine.text,
    })
  }
  return { ok: true, lines }
}

function isTerminatorOpcode(opcode: string): boolean {
  return opcode === 'JMP' || opcode === 'CALL' || opcode === 'RET' || CONDITIONAL_JUMP_OPCODES.has(opcode)
}

interface TerminatorResolution {
  terminator: TerminatorKind
  callOperand?: string
}

function terminatorFor(entry: ClassifiedLine): { ok: true; value: TerminatorResolution } | { ok: false; message: string } {
  if (entry.type !== 'instruction') {
    return { ok: true, value: { terminator: { kind: 'fallthrough' } } }
  }
  const { opcode, operands, lineNumber, text } = entry

  if (opcode === 'JMP') {
    if (operands.length !== 1) return { ok: false, message: `invalid instruction format at line ${lineNumber}: "${text}"` }
    return { ok: true, value: { terminator: { kind: 'jump', target: operands[0] } } }
  }
  if (CONDITIONAL_JUMP_OPCODES.has(opcode)) {
    if (operands.length !== 1) return { ok: false, message: `invalid instruction format at line ${lineNumber}: "${text}"` }
    return { ok: true, value: { terminator: { kind: 'branch', target: operands[0] } } }
  }
  if (opcode === 'CALL') {
    if (operands.length !== 1) return { ok: false, message: `invalid instruction format at line ${lineNumber}: "${text}"` }
    return { ok: true, value: { terminator: { kind: 'call' }, callOperand: operands[0] } }
  }
  if (opcode === 'RET') {
    if (operands.length !== 0) return { ok: false, message: `invalid instruction format at line ${lineNumber}: "${text}"` }
    return { ok: true, value: { terminator: { kind: 'return' } } }
  }
  return { ok: true, value: { terminator: { kind: 'fallthrough' } } }
}

export function buildControlFlowGraph(source: string): CfgResult {
  const classified = classifyLines(source)
  if (!classified.ok) return classified
  const entries = classified.lines

  if (entries.length === 0) {
    return { ok: true, blocks: [], successors: {}, predecessors: {} }
  }

  const isLeader = new Array<boolean>(entries.length).fill(false)
  isLeader[0] = true
  let previousWasTerminator = false
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.type === 'label') isLeader[i] = true
    if (previousWasTerminator) isLeader[i] = true
    previousWasTerminator = entry.type === 'instruction' && isTerminatorOpcode(entry.opcode)
  }

  const leaderIndices: number[] = []
  for (let i = 0; i < entries.length; i++) {
    if (isLeader[i]) leaderIndices.push(i)
  }

  const blocks: BasicBlock[] = []
  const callOperandByBlockId = new Map<number, string>()
  const labelToBlockId = new Map<string, number>()

  for (let b = 0; b < leaderIndices.length; b++) {
    const start = leaderIndices[b]
    const end = b + 1 < leaderIndices.length ? leaderIndices[b + 1] : entries.length
    const blockEntries = entries.slice(start, end)

    let label: string | null = null
    let instructionEntries = blockEntries
    if (blockEntries[0].type === 'label') {
      label = blockEntries[0].name
      instructionEntries = blockEntries.slice(1)
    }

    if (label !== null) {
      if (labelToBlockId.has(label)) {
        return { ok: false, error: `duplicate label definition: ${label}` }
      }
      labelToBlockId.set(label, blocks.length)
    }

    const lastEntry = blockEntries[blockEntries.length - 1]
    const termResult = terminatorFor(lastEntry)
    if (!termResult.ok) {
      return { ok: false, error: termResult.message }
    }

    const blockId = blocks.length
    if (termResult.value.callOperand !== undefined) {
      callOperandByBlockId.set(blockId, termResult.value.callOperand)
    }

    blocks.push({
      id: blockId,
      label,
      startLine: blockEntries[0].lineNumber,
      instructions: instructionEntries
        .filter((e): e is Extract<ClassifiedLine, { type: 'instruction' }> => e.type === 'instruction')
        .map((e) => e.text),
      terminator: termResult.value.terminator,
    })
  }

  const successors: Record<number, number[]> = {}
  const predecessors: Record<number, number[]> = {}
  for (const block of blocks) {
    successors[block.id] = []
    predecessors[block.id] = []
  }

  const addEdge = (from: number, to: number) => {
    successors[from].push(to)
    predecessors[to].push(from)
  }

  for (const block of blocks) {
    const hasNext = block.id < blocks.length - 1
    const nextId = block.id + 1

    switch (block.terminator.kind) {
      case 'jump': {
        const targetId = labelToBlockId.get(block.terminator.target)
        if (targetId === undefined) {
          return { ok: false, error: `unresolved label target: ${block.terminator.target}` }
        }
        addEdge(block.id, targetId)
        break
      }
      case 'branch': {
        const targetId = labelToBlockId.get(block.terminator.target)
        if (targetId === undefined) {
          return { ok: false, error: `unresolved label target: ${block.terminator.target}` }
        }
        addEdge(block.id, targetId)
        if (hasNext) addEdge(block.id, nextId)
        break
      }
      case 'call': {
        const operand = callOperandByBlockId.get(block.id) ?? ''
        const isRegisterOperand = operand.toUpperCase() in registerMap
        if (!isRegisterOperand && !labelToBlockId.has(operand)) {
          return { ok: false, error: `unresolved label target: ${operand}` }
        }
        if (hasNext) addEdge(block.id, nextId)
        break
      }
      case 'return':
        break
      case 'fallthrough':
        if (hasNext) addEdge(block.id, nextId)
        break
    }
  }

  for (const block of blocks) {
    predecessors[block.id] = [...new Set(predecessors[block.id])].sort((a, b) => a - b)
  }

  return { ok: true, blocks, successors, predecessors }
}
