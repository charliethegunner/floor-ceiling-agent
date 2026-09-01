import { describe, test, expect } from 'vitest'
import { validateExecutableProgram, interpretArm64Program, SANDBOX_SUPPORTED_OPCODES } from './sandbox-instruction-set'

describe('validateExecutableProgram: admission control (shape-only, never computes a value)', () => {
  test('accepts every supported opcode with the correct operand count', () => {
    const lines = [
      'MOV X0, X1',
      'ADD X0, X1, X2',
      'SUB X0, X1, X2',
      'AND X0, X1, X2',
      'ORR X0, X1, X2',
      'EOR X0, X1, X2',
      'LSL X0, X1, X2',
      'LSR X0, X1, X2',
      'CMP X0, X1',
    ]
    expect(validateExecutableProgram(lines)).toBeNull()
  })

  test('SANDBOX_SUPPORTED_OPCODES is exactly the closed 9-opcode register-transfer ALU set', () => {
    expect([...SANDBOX_SUPPORTED_OPCODES].sort()).toEqual(['ADD', 'AND', 'CMP', 'EOR', 'LSL', 'LSR', 'MOV', 'ORR', 'SUB'])
  })

  test('rejects an unsupported/unsafe opcode (e.g. a memory load) with a clear reason', () => {
    const result = validateExecutableProgram(['LDR X0, [X1]'])
    expect(result?.line).toBe('LDR X0, [X1]')
    expect(result?.reason).toContain('unsupported/unsafe instruction "LDR"')
  })

  test('rejects a branch/syscall-shaped instruction the same way', () => {
    expect(validateExecutableProgram(['SVC 0'])?.reason).toContain('unsupported/unsafe instruction "SVC"')
    expect(validateExecutableProgram(['BL somewhere'])?.reason).toContain('unsupported/unsafe instruction "BL"')
  })

  test('rejects the wrong operand count for a 2-operand opcode', () => {
    const result = validateExecutableProgram(['MOV X0, X1, X2'])
    expect(result?.reason).toContain('"MOV" expects 2 operand(s), got 3')
  })

  test('rejects the wrong operand count for a 3-operand opcode', () => {
    const result = validateExecutableProgram(['ADD X0, X1'])
    expect(result?.reason).toContain('"ADD" expects 3 operand(s), got 2')
  })

  test('rejects an unrecognized register token', () => {
    const result = validateExecutableProgram(['MOV X0, X99'])
    expect(result?.reason).toContain('unrecognized register "X99"')
  })

  test('blank lines are skipped, not rejected', () => {
    expect(validateExecutableProgram(['MOV X0, X1', '', '   ', 'ADD X0, X0, X1'])).toBeNull()
  })

  test('validates a multi-line program and reports the FIRST offending line', () => {
    const result = validateExecutableProgram(['MOV X0, X1', 'LDR X2, [X0]', 'ADD X0, X0, X1'])
    expect(result?.line).toBe('LDR X2, [X0]')
  })
})

describe('interpretArm64Program: real register-transfer ALU semantics', () => {
  test('MOV copies a register value', () => {
    const { registers, instructionsExecuted } = interpretArm64Program(['MOV X0, X1'], { X1: 42n })
    expect(registers.X0).toBe(42n)
    expect(instructionsExecuted).toBe(1)
  })

  test('a register with no initial value defaults to 0', () => {
    const { registers } = interpretArm64Program(['MOV X0, X1'], {})
    expect(registers.X0).toBe(0n)
  })

  test('ADD computes the real 64-bit sum', () => {
    const { registers } = interpretArm64Program(['ADD X0, X1, X2'], { X1: 3n, X2: 4n })
    expect(registers.X0).toBe(7n)
  })

  test('SUB wraps around on unsigned underflow, matching real 64-bit register truncation', () => {
    const { registers } = interpretArm64Program(['SUB X0, X1, X2'], { X1: 0n, X2: 1n })
    expect(registers.X0).toBe((1n << 64n) - 1n)
  })

  test('AND / ORR / EOR compute real bitwise results', () => {
    const initial = { X1: 0b1100n, X2: 0b1010n }
    expect(interpretArm64Program(['AND X0, X1, X2'], initial).registers.X0).toBe(0b1000n)
    expect(interpretArm64Program(['ORR X0, X1, X2'], initial).registers.X0).toBe(0b1110n)
    expect(interpretArm64Program(['EOR X0, X1, X2'], initial).registers.X0).toBe(0b0110n)
  })

  test('LSL / LSR shift and mask to 64 bits, with a logical (unsigned) LSR', () => {
    expect(interpretArm64Program(['LSL X0, X1, X2'], { X1: 1n, X2: 4n }).registers.X0).toBe(16n)
    expect(interpretArm64Program(['LSR X0, X1, X2'], { X1: (1n << 64n) - 1n, X2: 60n }).registers.X0).toBe(0xfn)
  })

  test('CMP executes without mutating any register, matching this project\'s existing CMP model', () => {
    const { registers, instructionsExecuted } = interpretArm64Program(['CMP X0, X1'], { X0: 5n, X1: 9n })
    expect(registers.X0).toBe(5n)
    expect(registers.X1).toBe(9n)
    expect(instructionsExecuted).toBe(1)
  })

  test('a multi-instruction program threads register state sequentially', () => {
    const { registers, instructionsExecuted } = interpretArm64Program(['MOV X0, X1', 'ADD X0, X0, X2', 'SUB X0, X0, X1'], { X1: 10n, X2: 5n })
    expect(registers.X0).toBe(5n) // 10 + 5 - 10
    expect(instructionsExecuted).toBe(3)
  })

  test('rejects (throws) a program that would fail validateExecutableProgram - defense in depth for a direct call that bypassed it', () => {
    expect(() => interpretArm64Program(['LDR X0, [X1]'], {})).toThrow(/unsupported\/unsafe instruction "LDR"/)
  })
})
