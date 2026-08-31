import { describe, expect, test } from 'vitest'
import { registerMap, translateInstruction } from './translator'

describe('registerMap', () => {
  test('maps all supported x86-64 registers to their ARM64 equivalents', () => {
    expect(registerMap).toEqual({
      RAX: 'X0',
      RBX: 'X1',
      RCX: 'X2',
      RDX: 'X3',
      RSP: 'SP',
      RBP: 'FP',
    })
  })
})

describe('translateInstruction', () => {
  test('translates a register-to-register MOV', () => {
    const result = translateInstruction('MOV RAX, RBX')

    expect(result).toEqual({ ok: true, instruction: 'MOV X0, X1' })
  })

  test('translates an ADD with an immediate operand', () => {
    const result = translateInstruction('ADD RAX, 5')

    expect(result).toEqual({ ok: true, instruction: 'ADD X0, X0, #5' })
  })

  test('translates an ADD with a register operand', () => {
    const result = translateInstruction('ADD RAX, RBX')

    expect(result).toEqual({ ok: true, instruction: 'ADD X0, X0, X1' })
  })

  test('translates a MOV with an immediate operand', () => {
    const result = translateInstruction('MOV RCX, 42')

    expect(result).toEqual({ ok: true, instruction: 'MOV X2, #42' })
  })

  test('translates RSP and RBP to SP and FP', () => {
    expect(translateInstruction('MOV RSP, RBP')).toEqual({
      ok: true,
      instruction: 'MOV SP, FP',
    })
  })

  test('handles negative immediates', () => {
    const result = translateInstruction('ADD RDX, -5')

    expect(result).toEqual({ ok: true, instruction: 'ADD X3, X3, #-5' })
  })

  test('is case-insensitive for opcodes and registers', () => {
    const result = translateInstruction('mov rax, rbx')

    expect(result).toEqual({ ok: true, instruction: 'MOV X0, X1' })
  })

  test('tolerates extra whitespace around operands', () => {
    const result = translateInstruction('MOV   RAX ,   RBX')

    expect(result).toEqual({ ok: true, instruction: 'MOV X0, X1' })
  })

  test('returns an error for an unsupported opcode', () => {
    const result = translateInstruction('XOR RAX, RBX')

    expect(result).toEqual({ ok: false, error: 'unsupported opcode: XOR' })
  })

  test('returns an error for an invalid source register', () => {
    const result = translateInstruction('MOV RAX, RXX')

    expect(result).toEqual({ ok: false, error: 'invalid operand: RXX' })
  })

  test('returns an error for an invalid destination register', () => {
    const result = translateInstruction('MOV RZZ, RAX')

    expect(result).toEqual({ ok: false, error: 'invalid operand: RZZ' })
  })

  test('returns an error when the destination is an immediate', () => {
    const result = translateInstruction('MOV 5, RAX')

    expect(result).toEqual({ ok: false, error: 'destination must be a register: 5' })
  })

  test('returns an error for a malformed instruction missing an operand', () => {
    const result = translateInstruction('MOV RAX')

    expect(result).toEqual({
      ok: false,
      error: 'invalid instruction format: "MOV RAX"',
    })
  })

  test('returns an error for an opcode with no operands at all', () => {
    const result = translateInstruction('MOV')

    expect(result).toEqual({
      ok: false,
      error: 'invalid instruction format: "MOV"',
    })
  })

  test('returns an error for an empty instruction string', () => {
    const result = translateInstruction('')

    expect(result).toEqual({
      ok: false,
      error: 'invalid instruction format: ""',
    })
  })

  test('returns an error for too many operands', () => {
    const result = translateInstruction('MOV RAX, RBX, RCX')

    expect(result).toEqual({
      ok: false,
      error: 'invalid instruction format: "MOV RAX, RBX, RCX"',
    })
  })
})

describe('translateInstruction with indirect memory operands', () => {
  test('translates an indirect load with no offset to LDR', () => {
    const result = translateInstruction('MOV RAX, [RBX]')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [X1]' })
  })

  test('translates an indirect load with a positive offset to LDR', () => {
    const result = translateInstruction('MOV RAX, [RBX + 8]')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [X1, #8]' })
  })

  test('translates an indirect load with no spaces around the offset', () => {
    const result = translateInstruction('MOV RAX, [RBX+8]')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [X1, #8]' })
  })

  test('translates an indirect load with a negative offset', () => {
    const result = translateInstruction('MOV RAX, [RBX - 8]')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [X1, #-8]' })
  })

  test('is case-insensitive for registers inside a memory operand', () => {
    const result = translateInstruction('mov rax, [rbx + 8]')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [X1, #8]' })
  })

  test('returns an error for an invalid base register in a memory operand', () => {
    const result = translateInstruction('MOV RAX, [RZZ]')

    expect(result).toEqual({ ok: false, error: 'invalid operand: [RZZ]' })
  })

  test('returns an error for a malformed memory operand', () => {
    const result = translateInstruction('MOV RAX, [RBX +]')

    expect(result).toEqual({ ok: false, error: 'invalid operand: [RBX +]' })
  })

  test('returns an error for an unclosed memory operand', () => {
    const result = translateInstruction('MOV RAX, [RBX')

    expect(result).toEqual({ ok: false, error: 'invalid operand: [RBX' })
  })

  test('returns an error when the destination is an immediate and the source is memory', () => {
    const result = translateInstruction('MOV 5, [RAX]')

    expect(result).toEqual({ ok: false, error: 'destination must be a register: 5' })
  })

  test('returns an error when a memory operand is used with an unsupported opcode', () => {
    const result = translateInstruction('ADD RAX, [RBX]')

    expect(result).toEqual({
      ok: false,
      error: 'memory operand not supported for opcode: ADD',
    })
  })
})

describe('translateInstruction with indirect memory store operands', () => {
  test('translates a store with no offset to STR', () => {
    const result = translateInstruction('MOV [RAX], RBX')

    expect(result).toEqual({ ok: true, instruction: 'STR X1, [X0]' })
  })

  test('translates a store with a positive offset to STR', () => {
    const result = translateInstruction('MOV [RBX + 16], RAX')

    expect(result).toEqual({ ok: true, instruction: 'STR X0, [X1, #16]' })
  })

  test('translates a store with a negative offset to STR', () => {
    const result = translateInstruction('MOV [RBP - 8], RCX')

    expect(result).toEqual({ ok: true, instruction: 'STR X2, [FP, #-8]' })
  })

  test('omits a zero offset in the translated STR', () => {
    const result = translateInstruction('MOV [RAX + 0], RBX')

    expect(result).toEqual({ ok: true, instruction: 'STR X1, [X0]' })
  })

  test('returns an error for a memory source with a memory destination', () => {
    const result = translateInstruction('MOV [RAX], [RBX]')

    expect(result).toEqual({
      ok: false,
      error: 'source must be a register for a memory store: [RBX]',
    })
  })

  test('returns an error for an immediate source with a memory destination', () => {
    const result = translateInstruction('MOV [RAX], 10')

    expect(result).toEqual({
      ok: false,
      error: 'source must be a register for a memory store: 10',
    })
  })

  test('returns an error when a memory destination is used with an unsupported opcode', () => {
    const result = translateInstruction('ADD [RAX], RBX')

    expect(result).toEqual({
      ok: false,
      error: 'memory operand not supported for opcode: ADD',
    })
  })
})
