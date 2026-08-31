import { X86Register, X86OperandClass, classifyX86Operand, parseInstruction, JCC_CONDITIONS } from './translator'
import { BasicBlock, CfgSuccess } from './cfg'

export interface LivenessResult {
  liveIn: Record<number, X86Register[]>
  liveOut: Record<number, X86Register[]>
}

const CALLER_SAVED_REGISTERS: X86Register[] = ['RAX', 'RCX', 'RDX', 'RDI']
const CONDITIONAL_JUMP_OPCODES = new Set(Object.keys(JCC_CONDITIONS))
const REGISTER_UNIVERSE_SIZE = 7

interface UseDef {
  use: X86Register[]
  def: X86Register[]
}

function registersOf(operandClass: X86OperandClass): X86Register[] {
  if (operandClass.kind === 'register') return [operandClass.name]
  if (operandClass.kind === 'memory') {
    return operandClass.index ? [operandClass.base, operandClass.index] : [operandClass.base]
  }
  return []
}

function classify(operand: string | undefined): X86OperandClass {
  return operand === undefined ? { kind: 'unresolved' } : classifyX86Operand(operand)
}

function instructionUseDef(text: string): UseDef {
  const parsed = parseInstruction(text)
  if (!parsed) return { use: [], def: [] }
  const { opcode, operands } = parsed

  if (opcode === 'JMP' || CONDITIONAL_JUMP_OPCODES.has(opcode)) {
    return { use: [], def: [] }
  }

  if (opcode === 'RET') {
    return { use: ['RAX', 'RSP'], def: ['RSP'] }
  }

  if (opcode === 'CALL') {
    const targetClass = classify(operands[0])
    return { use: ['RSP', ...registersOf(targetClass)], def: ['RSP', ...CALLER_SAVED_REGISTERS] }
  }

  if (opcode === 'PUSH') {
    const srcClass = classify(operands[0])
    return { use: [...registersOf(srcClass), 'RSP'], def: ['RSP'] }
  }

  if (opcode === 'POP') {
    const dstClass = classify(operands[0])
    if (dstClass.kind === 'register') {
      return { use: ['RSP'], def: [dstClass.name, 'RSP'] }
    }
    return { use: [...registersOf(dstClass), 'RSP'], def: ['RSP'] }
  }

  if (opcode === 'MOV') {
    const dstClass = classify(operands[0])
    const srcClass = classify(operands[1])
    if (dstClass.kind === 'register') {
      return { use: registersOf(srcClass), def: [dstClass.name] }
    }
    return { use: [...registersOf(dstClass), ...registersOf(srcClass)], def: [] }
  }

  if (opcode === 'ADD') {
    const dstClass = classify(operands[0])
    const srcClass = classify(operands[1])
    if (dstClass.kind === 'register') {
      return { use: [dstClass.name, ...registersOf(srcClass)], def: [dstClass.name] }
    }
    return { use: [...registersOf(dstClass), ...registersOf(srcClass)], def: [] }
  }

  if (opcode === 'CMP') {
    const dstClass = classify(operands[0])
    const srcClass = classify(operands[1])
    return { use: [...registersOf(dstClass), ...registersOf(srcClass)], def: [] }
  }

  return { use: operands.flatMap((op) => registersOf(classifyX86Operand(op))), def: [] }
}

function blockUseDef(block: BasicBlock): UseDef {
  const useSet = new Set<X86Register>()
  const defSet = new Set<X86Register>()
  for (const instructionText of block.instructions) {
    const { use, def } = instructionUseDef(instructionText)
    for (const reg of use) {
      if (!defSet.has(reg)) useSet.add(reg)
    }
    for (const reg of def) {
      defSet.add(reg)
    }
  }
  return { use: [...useSet], def: [...defSet] }
}

function sortedArray(set: Set<X86Register>): X86Register[] {
  return [...set].sort()
}

export function analyzeLiveness(cfg: CfgSuccess): LivenessResult {
  const blocks = cfg.blocks
  const useDefByBlock = blocks.map(blockUseDef)

  const liveInSets: Set<X86Register>[] = blocks.map(() => new Set())
  const liveOutSets: Set<X86Register>[] = blocks.map(() => new Set())

  const queue: number[] = blocks.map((b) => b.id).reverse()
  const queued = new Set<number>(queue)

  const maxIterations = blocks.length * REGISTER_UNIVERSE_SIZE * 4 + 16
  let iterations = 0

  while (queue.length > 0) {
    iterations++
    if (iterations > maxIterations) {
      throw new Error('liveness analysis exceeded defensive iteration bound; def/use monotonicity may be violated')
    }

    const blockId = queue.shift()
    if (blockId === undefined) break
    queued.delete(blockId)

    const newLiveOut = new Set<X86Register>()
    for (const succId of cfg.successors[blockId] ?? []) {
      for (const reg of liveInSets[succId]) newLiveOut.add(reg)
    }

    const { use, def } = useDefByBlock[blockId]
    const defSet = new Set(def)
    const newLiveIn = new Set<X86Register>(use)
    for (const reg of newLiveOut) {
      if (!defSet.has(reg)) newLiveIn.add(reg)
    }

    liveOutSets[blockId] = newLiveOut

    const oldLiveIn = liveInSets[blockId]
    const changed = oldLiveIn.size !== newLiveIn.size || [...newLiveIn].some((reg) => !oldLiveIn.has(reg))

    if (changed) {
      liveInSets[blockId] = newLiveIn
      for (const predId of cfg.predecessors[blockId] ?? []) {
        if (!queued.has(predId)) {
          queued.add(predId)
          queue.push(predId)
        }
      }
    }
  }

  const liveIn: Record<number, X86Register[]> = {}
  const liveOut: Record<number, X86Register[]> = {}
  for (const block of blocks) {
    liveIn[block.id] = sortedArray(liveInSets[block.id])
    liveOut[block.id] = sortedArray(liveOutSets[block.id])
  }

  return { liveIn, liveOut }
}
