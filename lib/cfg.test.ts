import { describe, expect, test } from 'vitest'
import { buildControlFlowGraph } from './cfg'

describe('buildControlFlowGraph', () => {
  test('a straight-line program with no labels or branches is a single fallthrough block', () => {
    const result = buildControlFlowGraph('MOV RAX, RBX\nADD RAX, RCX\nCMP RAX, RDX')
    if (!result.ok) throw new Error(result.error)

    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]).toMatchObject({
      id: 0,
      label: null,
      instructions: ['MOV RAX, RBX', 'ADD RAX, RCX', 'CMP RAX, RDX'],
      terminator: { kind: 'fallthrough' },
    })
    expect(result.successors).toEqual({ 0: [] })
    expect(result.predecessors).toEqual({ 0: [] })
  })

  test('a conditional branch produces three blocks with taken-first successor order', () => {
    const source = ['CMP RAX, RBX', 'JE target', 'MOV RAX, RCX', 'target:', 'MOV RBX, RDX'].join('\n')
    const result = buildControlFlowGraph(source)
    if (!result.ok) throw new Error(result.error)

    expect(result.blocks).toHaveLength(3)
    expect(result.blocks[0].terminator).toEqual({ kind: 'branch', target: 'target' })
    expect(result.successors[0]).toEqual([2, 1])
    expect(result.successors[1]).toEqual([2])
    expect(result.successors[2]).toEqual([])
    expect(result.predecessors[2]).toEqual([0, 1])
    expect(result.predecessors[1]).toEqual([0])
  })

  test('an unconditional JMP resolves to its label block, independent of fallthrough order', () => {
    const source = ['JMP skip', 'MOV RAX, RBX', 'skip:', 'MOV RCX, RDX'].join('\n')
    const result = buildControlFlowGraph(source)
    if (!result.ok) throw new Error(result.error)

    expect(result.blocks).toHaveLength(3)
    expect(result.blocks[0].terminator).toEqual({ kind: 'jump', target: 'skip' })
    expect(result.successors[0]).toEqual([2])
    expect(result.successors[1]).toEqual([2])
    expect(result.predecessors[2]).toEqual([0, 1])
  })

  test('CALL with a register target ends its block with a single fallthrough successor', () => {
    const source = ['CALL RAX', 'MOV RAX, RBX'].join('\n')
    const result = buildControlFlowGraph(source)
    if (!result.ok) throw new Error(result.error)

    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0].terminator).toEqual({ kind: 'call' })
    expect(result.successors[0]).toEqual([1])
    expect(result.successors[1]).toEqual([])
  })

  test('CALL with a label target validates the label but adds no callee edge', () => {
    const source = ['CALL helper', 'RET', 'helper:', 'RET'].join('\n')
    const result = buildControlFlowGraph(source)
    if (!result.ok) throw new Error(result.error)

    expect(result.blocks).toHaveLength(3)
    expect(result.successors[0]).toEqual([1])
    expect(result.predecessors[2]).toEqual([])
  })

  test('RET produces a terminal block with no successors', () => {
    const result = buildControlFlowGraph('RET')
    if (!result.ok) throw new Error(result.error)

    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].terminator).toEqual({ kind: 'return' })
    expect(result.successors[0]).toEqual([])
  })

  test('a loop header accumulates a linear predecessor and a back-edge predecessor, sorted', () => {
    const source = ['MOV RAX, RBX', 'loop:', 'ADD RAX, RCX', 'CMP RAX, RDX', 'JNE loop', 'RET'].join('\n')
    const result = buildControlFlowGraph(source)
    if (!result.ok) throw new Error(result.error)

    expect(result.blocks).toHaveLength(3)
    expect(result.blocks[1].label).toBe('loop')
    expect(result.successors[1]).toEqual([1, 2])
    expect(result.predecessors[1]).toEqual([0, 1])
  })

  test('a label immediately followed by another label produces an empty, distinct block', () => {
    const source = ['a:', 'b:', 'MOV RAX, RBX'].join('\n')
    const result = buildControlFlowGraph(source)
    if (!result.ok) throw new Error(result.error)

    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0]).toMatchObject({ label: 'a', instructions: [] })
    expect(result.blocks[1]).toMatchObject({ label: 'b', instructions: ['MOV RAX, RBX'] })
  })

  test('branching to an undefined label returns a CfgError', () => {
    const result = buildControlFlowGraph('JMP nowhere')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('unresolved label target: nowhere')
  })

  test('duplicate label definitions return a CfgError', () => {
    const source = ['dup:', 'MOV RAX, RBX', 'dup:', 'MOV RCX, RDX'].join('\n')
    const result = buildControlFlowGraph(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('duplicate label definition: dup')
  })

  test('an unrecognized bare mnemonic is treated as a valid zero-operand instruction (opcode-agnostic)', () => {
    const result = buildControlFlowGraph(['MOV RAX, RBX', 'GARBAGE'].join('\n'))
    if (!result.ok) throw new Error(result.error)

    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].instructions).toEqual(['MOV RAX, RBX', 'GARBAGE'])
  })

  test('a terminator opcode with the wrong operand arity returns a CfgError referencing the source line', () => {
    const source = ['MOV RAX, RBX', 'JE'].join('\n')
    const result = buildControlFlowGraph(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('invalid instruction format at line 2: "JE"')
  })

  test('empty input returns an empty, well-formed CfgResult', () => {
    expect(buildControlFlowGraph('')).toEqual({ ok: true, blocks: [], successors: {}, predecessors: {} })
    expect(buildControlFlowGraph('   \n\t\n')).toEqual({ ok: true, blocks: [], successors: {}, predecessors: {} })
  })
})
