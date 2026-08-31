import { describe, expect, test } from 'vitest'
import { translateX86ToArm64 } from './index'

function lines(instruction: string) {
  return instruction.split('\n')
}

describe('translateX86ToArm64: multi-block control flow', () => {
  test('a conditional branch with a label target translates end-to-end', () => {
    const source = ['CMP RAX, RBX', 'JE target', 'MOV RAX, RCX', 'target:', 'MOV RBX, RDX'].join('\n')
    const result = translateX86ToArm64(source)
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.instruction)).toEqual(['CMP X0, X1', 'B.EQ target', 'MOV X0, X2', 'target:', 'MOV X1, X3'])
  })
})

describe('translateX86ToArm64: loops', () => {
  test('a self-looping block with a conditional back-edge translates end-to-end', () => {
    const source = ['loop:', 'ADD RAX, RBX', 'JNE loop'].join('\n')
    const result = translateX86ToArm64(source)
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.instruction)).toEqual(['loop:', 'ADD X0, X0, X1', 'B.NE loop'])
  })
})

describe('translateX86ToArm64: function calls with liveness-driven spills', () => {
  test('a call with RBX live afterward is wrapped in the AAPCS64 spill/reload sequence', () => {
    const source = ['MOV RBX, RAX', 'CALL RCX', 'ADD RDI, RBX'].join('\n')
    const result = translateX86ToArm64(source)
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.instruction)).toEqual([
      'MOV X1, X0',
      'SUB SP, SP, #16',
      'STR X1, [SP]',
      'BLR X2',
      'LDR X1, [SP]',
      'ADD SP, SP, #16',
      'ADD X4, X4, X1',
    ])
  })

  test('a call with no live registers afterward emits no spill wrapping', () => {
    const source = ['CALL RCX', 'RET'].join('\n')
    const result = translateX86ToArm64(source)
    if (!result.ok) throw new Error(result.error)

    expect(lines(result.instruction)).toEqual(['BLR X2', 'RET'])
  })
})

describe('translateX86ToArm64: malformed-input error paths', () => {
  test('a branch to an undefined label returns a TranslationError, not a thrown exception', () => {
    const result = translateX86ToArm64('JMP nowhere')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('unresolved label target: nowhere')
  })

  test('a duplicate label definition returns a TranslationError', () => {
    const source = ['dup:', 'MOV RAX, RBX', 'dup:', 'MOV RCX, RDX'].join('\n')
    const result = translateX86ToArm64(source)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('duplicate label definition: dup')
  })
})

describe('translateX86ToArm64: unmapped-opcode error path', () => {
  test('an opcode translateInstruction does not support returns a TranslationError referencing it', () => {
    const source = ['MOV RAX, RBX', 'GARBAGE RAX, RBX'].join('\n')
    const result = translateX86ToArm64(source)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('block 0, instruction "GARBAGE RAX, RBX": unsupported opcode: GARBAGE')
  })
})

describe('translateX86ToArm64: empty input', () => {
  test('an empty source string is a successful, empty translation, not an error', () => {
    const result = translateX86ToArm64('')

    expect(result).toEqual({ ok: true, instruction: '' })
  })
})
