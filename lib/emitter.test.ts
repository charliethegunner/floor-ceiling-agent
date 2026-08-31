import { describe, expect, test } from 'vitest'
import { buildControlFlowGraph } from './cfg'
import { analyzeLiveness } from './liveness'
import { emitArm64 } from './emitter'

function emit(source: string) {
  const cfg = buildControlFlowGraph(source)
  if (!cfg.ok) throw new Error(cfg.error)
  const liveness = analyzeLiveness(cfg)
  return emitArm64(cfg, liveness)
}

function lines(program: string) {
  return program.split('\n')
}

describe('emitProgram: simple blocks reuse translateInstruction directly', () => {
  test('a straight-line block emits each translated instruction in order', () => {
    const result = emit('MOV RAX, RBX\nADD RAX, RCX')
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.program)).toEqual(['MOV X0, X1', 'ADD X0, X0, X2'])
  })
})

describe('emitProgram: labels and terminators', () => {
  test('a branch target label is emitted as a definition line', () => {
    const source = ['CMP RAX, RBX', 'JE target', 'MOV RAX, RCX', 'target:', 'MOV RBX, RDX'].join('\n')
    const result = emit(source)
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.program)).toEqual(['CMP X0, X1', 'B.EQ target', 'MOV X0, X2', 'target:', 'MOV X1, X3'])
  })

  test('an unconditional JMP emits ARM64 B, bypassing translateInstruction', () => {
    const source = ['JMP skip', 'MOV RAX, RBX', 'skip:', 'MOV RCX, RDX'].join('\n')
    const result = emit(source)
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.program)).toEqual(['B skip', 'MOV X0, X1', 'skip:', 'MOV X2, X3'])
  })

  test('RET emits a bare ARM64 RET, bypassing translateInstruction', () => {
    const result = emit('RET')
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.program)).toEqual(['RET'])
  })

  test('an empty block (label with no instructions) still emits its label line', () => {
    const source = ['a:', 'b:', 'MOV RAX, RBX'].join('\n')
    const result = emit(source)
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.program)).toEqual(['a:', 'b:', 'MOV X0, X1'])
  })
})

describe('emitProgram: CALL spill/reload driven by liveness', () => {
  test('RBX not live across the call: BLR is emitted with no spill wrapping', () => {
    const result = emit(['CALL RCX', 'RET'].join('\n'))
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.program)).toEqual(['BLR X2', 'RET'])
  })

  test('RBX live across the call: wrapped in a 16-byte-aligned spill/reload sequence', () => {
    const source = ['MOV RBX, RAX', 'CALL RCX', 'ADD RDI, RBX'].join('\n')
    const result = emit(source)
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.program)).toEqual([
      'MOV X1, X0',
      'SUB SP, SP, #16',
      'STR X1, [SP]',
      'BLR X2',
      'LDR X1, [SP]',
      'ADD SP, SP, #16',
      'ADD X4, X4, X1',
    ])
  })

  test('RBP live across a call is never spilled: FP is callee-saved on both ISAs', () => {
    const source = ['MOV RBP, RAX', 'CALL RCX', 'ADD RDI, RBP'].join('\n')
    const result = emit(source)
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.program)).toEqual(['MOV FP, X0', 'BLR X2', 'ADD X4, X4, FP'])
  })
})

describe('emitProgram: error propagation', () => {
  test('an untranslatable instruction fails the whole emit, unlike buildControlFlowGraph/analyzeLiveness tolerance', () => {
    const result = emit(['MOV RAX, RBX', 'GARBAGE RAX, RBX'].join('\n'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('GARBAGE')
  })
})
