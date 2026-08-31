import { describe, expect, test } from 'vitest'
import { buildControlFlowGraph } from './cfg'
import { analyzeLiveness } from './liveness'

function liveness(source: string) {
  const cfg = buildControlFlowGraph(source)
  if (!cfg.ok) throw new Error(cfg.error)
  return analyzeLiveness(cfg)
}

function sorted(regs: string[]) {
  return [...regs].sort()
}

describe('analyzeLiveness: instruction-level use/def policy', () => {
  test('a destination that is only ever written is not upward-exposed', () => {
    const result = liveness('MOV RAX, RBX')

    expect(sorted(result.liveIn[0])).toEqual(['RBX'])
    expect(result.liveOut[0]).toEqual([])
    expect(result.liveIn[0]).not.toContain('RAX')
  })

  test('a read-modify-write destination (ADD) is upward-exposed even though it is also defined', () => {
    const result = liveness('ADD RCX, RAX')

    expect(sorted(result.liveIn[0])).toEqual(['RAX', 'RCX'])
    expect(result.liveIn[0]).toContain('RCX')
    expect(result.liveOut[0]).toEqual([])
  })

  test('a memory/SIB load uses its addressing registers but never defines them', () => {
    const result = liveness('MOV RAX, [RBX + RCX*4 + 8]')

    expect(sorted(result.liveIn[0])).toEqual(['RBX', 'RCX'])
    expect(result.liveIn[0]).not.toContain('RAX')
  })

  test('a memory/SIB store uses its addressing registers and the stored value, and defines nothing', () => {
    const result = liveness('MOV [RBX + RCX*4], RAX')

    expect(sorted(result.liveIn[0])).toEqual(['RAX', 'RBX', 'RCX'])
    expect(result.liveOut[0]).toEqual([])
  })
})

describe('analyzeLiveness: branching', () => {
  const source = [
    'JE left',
    'MOV RAX, RBX',
    'JMP end',
    'left:',
    'MOV RAX, RCX',
    'end:',
    'ADD RDI, RAX',
  ].join('\n')

  test('liveOut at a branch point is the union of both successor paths liveIn', () => {
    const result = liveness(source)

    expect(sorted(result.liveOut[0])).toEqual(['RBX', 'RCX', 'RDI'])
    expect(sorted(result.liveIn[0])).toEqual(['RBX', 'RCX', 'RDI'])
  })

  test('each branch arm carries only the registers its own path needs', () => {
    const result = liveness(source)

    expect(sorted(result.liveIn[1])).toEqual(['RBX', 'RDI'])
    expect(sorted(result.liveIn[2])).toEqual(['RCX', 'RDI'])
  })
})

describe('analyzeLiveness: loops', () => {
  test('a self-looping block reaches a fixed point where the loop-carried register is both live-in and live-out', () => {
    const result = liveness(['loop:', 'ADD RAX, RBX', 'JNE loop'].join('\n'))

    expect(sorted(result.liveIn[0])).toEqual(['RAX', 'RBX'])
    expect(sorted(result.liveOut[0])).toEqual(['RAX', 'RBX'])
  })
})

describe('analyzeLiveness: function calls', () => {
  const source = ['MOV RBX, RAX', 'CALL RCX', 'ADD RDI, RBX'].join('\n')

  test('CALL clobbers caller-saved registers needed downstream, so they are not required live-in before the call', () => {
    const result = liveness(source)

    expect(result.liveIn[0]).not.toContain('RDI')
    expect(sorted(result.liveOut[0])).toEqual(['RBX', 'RDI'])
  })

  test('CALL preserves callee-saved registers, so a definition before the call still satisfies uses after it', () => {
    const result = liveness(source)

    expect(result.liveIn[0]).not.toContain('RBX')
    expect(sorted(result.liveIn[0])).toEqual(['RAX', 'RCX', 'RSP'])
  })

  test('RET implicitly uses the return-value register and the stack pointer', () => {
    const result = liveness('RET')

    expect(sorted(result.liveIn[0])).toEqual(['RAX', 'RSP'])
    expect(result.liveOut[0]).toEqual([])
  })
})
