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
      RDI: 'X4',
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

describe('translateInstruction with stack push/pop operations', () => {
  test('translates PUSH RAX to a pre-indexed STR', () => {
    const result = translateInstruction('PUSH RAX')

    expect(result).toEqual({ ok: true, instruction: 'STR X0, [SP, #-8]!' })
  })

  test('translates PUSH RBP to a pre-indexed STR', () => {
    const result = translateInstruction('PUSH RBP')

    expect(result).toEqual({ ok: true, instruction: 'STR FP, [SP, #-8]!' })
  })

  test('translates POP RBX to a post-indexed LDR', () => {
    const result = translateInstruction('POP RBX')

    expect(result).toEqual({ ok: true, instruction: 'LDR X1, [SP], #8' })
  })

  test('translates POP RAX to a post-indexed LDR', () => {
    const result = translateInstruction('POP RAX')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [SP], #8' })
  })

  test('returns an error for PUSH with an immediate operand', () => {
    const result = translateInstruction('PUSH 42')

    expect(result).toEqual({ ok: false, error: 'PUSH operand must be a register: 42' })
  })

  test('returns an error for PUSH with an indirect memory operand', () => {
    const result = translateInstruction('PUSH [RAX]')

    expect(result).toEqual({ ok: false, error: 'PUSH operand must be a register: [RAX]' })
  })

  test('returns an error for PUSH with no operands', () => {
    const result = translateInstruction('PUSH')

    expect(result).toEqual({ ok: false, error: 'invalid instruction format: "PUSH"' })
  })

  test('returns an error for POP with too many operands', () => {
    const result = translateInstruction('POP RAX, RBX')

    expect(result).toEqual({
      ok: false,
      error: 'invalid instruction format: "POP RAX, RBX"',
    })
  })
})

describe('translateInstruction with CALL', () => {
  test('translates a direct call to a label into BL', () => {
    const result = translateInstruction('CALL _my_function')

    expect(result).toEqual({ ok: true, instruction: 'BL _my_function' })
  })

  test('translates an indirect call through RAX into BLR', () => {
    const result = translateInstruction('CALL RAX')

    expect(result).toEqual({ ok: true, instruction: 'BLR X0' })
  })

  test('translates an indirect call through RDI into BLR', () => {
    const result = translateInstruction('CALL RDI')

    expect(result).toEqual({ ok: true, instruction: 'BLR X4' })
  })

  test('does not alias RAX and RDI to the same ARM64 register', () => {
    const result = translateInstruction('MOV RAX, RDI')

    expect(result).toEqual({ ok: true, instruction: 'MOV X0, X4' })
  })

  test('returns an error for a memory-indirect call', () => {
    const result = translateInstruction('CALL [RAX]')

    expect(result).toEqual({
      ok: false,
      error: 'memory operand not supported for opcode: CALL',
    })
  })

  test('returns an error for a call with multiple operands', () => {
    const result = translateInstruction('CALL RAX, RBX')

    expect(result).toEqual({
      ok: false,
      error: 'invalid instruction format: "CALL RAX, RBX"',
    })
  })
})

describe('translateInstruction with CMP and conditional branches', () => {
  test('translates a register-to-register CMP', () => {
    const result = translateInstruction('CMP RAX, RBX')

    expect(result).toEqual({ ok: true, instruction: 'CMP X0, X1' })
  })

  test('translates a CMP with an immediate operand', () => {
    const result = translateInstruction('CMP RCX, 5')

    expect(result).toEqual({ ok: true, instruction: 'CMP X2, #5' })
  })

  test('translates JE to B.EQ', () => {
    const result = translateInstruction('JE loop_start')

    expect(result).toEqual({ ok: true, instruction: 'B.EQ loop_start' })
  })

  test('translates JNE to B.NE', () => {
    const result = translateInstruction('JNE done')

    expect(result).toEqual({ ok: true, instruction: 'B.NE done' })
  })

  test('is case-insensitive for the opcode but preserves label case verbatim', () => {
    const result = translateInstruction('je Loop')

    expect(result).toEqual({ ok: true, instruction: 'B.EQ Loop' })
  })

  test('rejects a CMP with a memory operand', () => {
    const result = translateInstruction('CMP RAX, [RBX]')

    expect(result).toEqual({
      ok: false,
      error: 'memory operand not supported for opcode: CMP',
    })
  })

  test('rejects a register as a jump target', () => {
    const result = translateInstruction('JE RAX')

    expect(result).toEqual({ ok: false, error: 'invalid jump target: RAX' })
  })

  test('rejects an immediate as a jump target', () => {
    const result = translateInstruction('JE 5')

    expect(result).toEqual({ ok: false, error: 'invalid jump target: 5' })
  })

  test('rejects a memory operand as a jump target', () => {
    const result = translateInstruction('JE [RAX]')

    expect(result).toEqual({ ok: false, error: 'invalid jump target: [RAX]' })
  })

  test('rejects JE with no operand', () => {
    const result = translateInstruction('JE')

    expect(result).toEqual({
      ok: false,
      error: 'invalid instruction format: "JE"',
    })
  })

  test('rejects JE with too many operands', () => {
    const result = translateInstruction('JE label1, label2')

    expect(result).toEqual({
      ok: false,
      error: 'invalid instruction format: "JE label1, label2"',
    })
  })

  test('regression: ADD still dispatches to ADD, not CMP', () => {
    const result = translateInstruction('ADD RAX, RBX')

    expect(result).toEqual({ ok: true, instruction: 'ADD X0, X0, X1' })
  })
})

describe('translateInstruction with signed relational Jcc', () => {
  test('translates JG to B.GT', () => {
    const result = translateInstruction('JG greater')

    expect(result).toEqual({ ok: true, instruction: 'B.GT greater' })
  })

  test('translates JL to B.LT', () => {
    const result = translateInstruction('JL less')

    expect(result).toEqual({ ok: true, instruction: 'B.LT less' })
  })

  test('translates JGE to B.GE', () => {
    const result = translateInstruction('JGE greater_or_equal')

    expect(result).toEqual({ ok: true, instruction: 'B.GE greater_or_equal' })
  })

  test('translates JLE to B.LE', () => {
    const result = translateInstruction('JLE less_or_equal')

    expect(result).toEqual({ ok: true, instruction: 'B.LE less_or_equal' })
  })

  test('is case-insensitive for the opcode but preserves label case verbatim', () => {
    const result = translateInstruction('jge Loop')

    expect(result).toEqual({ ok: true, instruction: 'B.GE Loop' })
  })

  test('rejects a register as a jump target for JG', () => {
    const result = translateInstruction('JG RAX')

    expect(result).toEqual({ ok: false, error: 'invalid jump target: RAX' })
  })

  test('rejects JLE with no operand', () => {
    const result = translateInstruction('JLE')

    expect(result).toEqual({
      ok: false,
      error: 'invalid instruction format: "JLE"',
    })
  })

  test('rejects JG with too many operands', () => {
    const result = translateInstruction('JG label1, label2')

    expect(result).toEqual({
      ok: false,
      error: 'invalid instruction format: "JG label1, label2"',
    })
  })
})

describe('translateInstruction with SIB memory operands', () => {
  test('decodes a scale-1 SIB load with LSL #0', () => {
    const result = translateInstruction('MOV RAX, [RBX + RCX*1]')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [X1, X2, LSL #0]' })
  })

  test('decodes a scale-2 SIB load with LSL #1', () => {
    const result = translateInstruction('MOV RAX, [RBX + RCX*2]')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [X1, X2, LSL #1]' })
  })

  test('decodes a scale-4 SIB load with LSL #2', () => {
    const result = translateInstruction('MOV RAX, [RBX + RCX*4]')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [X1, X2, LSL #2]' })
  })

  test('decodes a scale-8 SIB load with LSL #3', () => {
    const result = translateInstruction('MOV RAX, [RBX + RCX*8]')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [X1, X2, LSL #3]' })
  })

  test('decodes a SIB store', () => {
    const result = translateInstruction('MOV [RBX + RCX*4], RAX')

    expect(result).toEqual({ ok: true, instruction: 'STR X0, [X1, X2, LSL #2]' })
  })

  test('lowers a SIB load with a decimal displacement to a two-instruction sequence', () => {
    const result = translateInstruction('MOV RAX, [RBX + RCX*4 + 32]')

    expect(result).toEqual({
      ok: true,
      instruction: 'ADD X9, X1, #32\nLDR X0, [X9, X2, LSL #2]',
    })
  })

  test('normalizes a hex displacement to decimal', () => {
    const result = translateInstruction('MOV RAX, [RBX + RCX*4 + 0x20]')

    expect(result).toEqual({
      ok: true,
      instruction: 'ADD X9, X1, #32\nLDR X0, [X9, X2, LSL #2]',
    })
  })

  test('lowers a negative SIB displacement', () => {
    const result = translateInstruction('MOV RAX, [RBX + RCX*4 - 8]')

    expect(result).toEqual({
      ok: true,
      instruction: 'ADD X9, X1, #-8\nLDR X0, [X9, X2, LSL #2]',
    })
  })

  test('lowers a displaced SIB store to a two-instruction sequence', () => {
    const result = translateInstruction('MOV [RBX + RCX*2 + 16], RAX')

    expect(result).toEqual({
      ok: true,
      instruction: 'ADD X9, X1, #16\nSTR X0, [X9, X2, LSL #1]',
    })
  })

  test('is case-insensitive for registers inside a SIB operand', () => {
    const result = translateInstruction('mov rax, [rbx + rcx*4]')

    expect(result).toEqual({ ok: true, instruction: 'LDR X0, [X1, X2, LSL #2]' })
  })

  test('rejects RSP as the index register', () => {
    const result = translateInstruction('MOV RAX, [RBX + RSP*2]')

    expect(result).toEqual({ ok: false, error: 'invalid index register: [RBX + RSP*2]' })
  })

  test('rejects an invalid scale factor', () => {
    const result = translateInstruction('MOV RAX, [RBX + RCX*3]')

    expect(result).toEqual({ ok: false, error: 'invalid operand: [RBX + RCX*3]' })
  })

  test('rejects an invalid base register in a SIB operand', () => {
    const result = translateInstruction('MOV RAX, [RZZ + RCX*4]')

    expect(result).toEqual({ ok: false, error: 'invalid operand: [RZZ + RCX*4]' })
  })

  test('rejects SIB operands for a non-MOV opcode', () => {
    const result = translateInstruction('ADD RAX, [RBX + RCX*4]')

    expect(result).toEqual({
      ok: false,
      error: 'memory operand not supported for opcode: ADD',
    })
  })

  test('rejects a non-register source for a SIB store', () => {
    const result = translateInstruction('MOV [RBX + RCX*4], 5')

    expect(result).toEqual({
      ok: false,
      error: 'source must be a register for a memory store: 5',
    })
  })
})
