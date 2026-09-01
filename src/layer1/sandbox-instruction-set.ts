// Phase 12.1: the CLOSED, provably-safe instruction subset the Isolated
// Sandboxed Runner Floor actually executes - the exact same
// register-transfer ALU set instruction-floor.ts's symbolic Z3 gate
// already models (MOV/ADD/SUB/AND/ORR/EOR/LSL/LSR/CMP over the SAME fixed
// register set, ARM64_REGISTERS below). "Payload isolation" here isn't an
// OS permission being revoked at execution time - it's structural: this
// interpreter has no memory address space, no syscall surface, no
// filesystem/network/subprocess API in scope at all, so there is
// categorically nothing an executed instruction could do beyond "compute a
// new 64-bit value for one of 8 registers." A real memory load/store,
// branch, or syscall-triggering instruction is refused by
// validateExecutableProgram BEFORE a sandbox worker is ever spawned - see
// sandbox-runner.ts.
//
// parseArm64Line/ARM64_REGISTERS are deliberately DUPLICATED from
// instruction-floor.ts (6 lines of stable logic), not imported - this file
// is loaded inside the sandbox worker (sandbox-runner-worker.ts), and
// instruction-floor.ts transitively imports FloorEngine.ts's z3-solver
// WASM module. Empirically confirmed before this was written: importing it
// pushed a normal, single-instruction sandbox execution past a 32MB V8
// heap ceiling on worker boot alone, before any interpretation even ran -
// exactly the kind of hidden cost a tightly-memory-bounded sandbox exists
// to avoid. This mirrors worker-pool-worker.ts's own precedent for
// duplicating stripJsonFences for the identical reason.
//
// CMP mutates no register here, matching instruction-floor.ts's own
// existing semantic model for CMP (see checkSymbolicEquivalence's
// isValidCmpShape) - this interpreter doesn't invent NZCV flag tracking
// that's modeled nowhere else in this project.

const ARM64_REGISTERS = new Set(['X0', 'X1', 'X2', 'X3', 'X4', 'X9', 'SP', 'FP'])

function parseArm64Line(line: string): { opcode: string; operands: string[] } {
  const trimmed = line.trim()
  const firstSpace = trimmed.indexOf(' ')
  if (firstSpace === -1) return { opcode: trimmed, operands: [] }
  return {
    opcode: trimmed.slice(0, firstSpace),
    operands: trimmed
      .slice(firstSpace + 1)
      .split(',')
      .map((operand) => operand.trim()),
  }
}

export const SANDBOX_SUPPORTED_OPCODES = new Set(['MOV', 'ADD', 'SUB', 'AND', 'ORR', 'EOR', 'LSL', 'LSR', 'CMP'])

const MASK64 = (1n << 64n) - 1n

export interface SandboxValidationError {
  line: string
  reason: string
}

/**
 * Pure opcode/operand SHAPE validation - never computes a value, never
 * "executes" anything, so it is safe to run in the parent process as
 * admission control before a sandbox worker is spawned.
 */
export function validateExecutableProgram(lines: string[]): SandboxValidationError | null {
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    const { opcode, operands } = parseArm64Line(line)
    const op = opcode.toUpperCase()
    if (!SANDBOX_SUPPORTED_OPCODES.has(op)) {
      return { line, reason: `unsupported/unsafe instruction "${opcode}" - only ${[...SANDBOX_SUPPORTED_OPCODES].sort().join(', ')} are executable in the sandbox` }
    }

    const expectedOperandCount = op === 'MOV' || op === 'CMP' ? 2 : 3
    if (operands.length !== expectedOperandCount) {
      return { line, reason: `"${op}" expects ${expectedOperandCount} operand(s), got ${operands.length}` }
    }
    for (const operand of operands) {
      if (!ARM64_REGISTERS.has(operand)) {
        return { line, reason: `unrecognized register "${operand}" - only ${[...ARM64_REGISTERS].sort().join(', ')} are executable` }
      }
    }
  }
  return null
}

export interface InterpretedProgramResult {
  registers: Record<string, bigint>
  instructionsExecuted: number
}

/**
 * The REAL interpreter - only ever invoked from inside the isolated sandbox
 * worker (sandbox-runner-worker.ts), never in the parent process. Assumes
 * `lines` already passed validateExecutableProgram; still defends against
 * being called directly with something that didn't (defense in depth, not
 * redundant - see sandbox-runner.ts's header comment).
 */
export function interpretArm64Program(lines: string[], initialRegisters: Record<string, bigint>): InterpretedProgramResult {
  const validation = validateExecutableProgram(lines)
  if (validation) {
    throw new Error(`${validation.reason} (in "${validation.line}")`)
  }

  const registers = new Map<string, bigint>(Object.entries(initialRegisters))
  const get = (r: string): bigint => (registers.get(r) ?? 0n) & MASK64
  let instructionsExecuted = 0

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    const { opcode, operands } = parseArm64Line(line)
    const op = opcode.toUpperCase()

    if (op === 'CMP') {
      instructionsExecuted++
      continue
    }
    if (op === 'MOV') {
      const [d, s] = operands
      registers.set(d, get(s))
      instructionsExecuted++
      continue
    }

    const [d, n, m] = operands
    const a = get(n)
    const b = get(m)
    let result: bigint
    switch (op) {
      case 'ADD':
        result = a + b
        break
      case 'SUB':
        // Unsigned 64-bit wraparound on underflow: add back a full 65th-bit
        // "borrow" before masking, so e.g. 0 - 1 lands on 2^64-1, matching
        // real ARM64 register truncation semantics rather than a negative
        // JS BigInt.
        result = a - b + (1n << 64n)
        break
      case 'AND':
        result = a & b
        break
      case 'ORR':
        result = a | b
        break
      case 'EOR':
        result = a ^ b
        break
      case 'LSL':
        result = a << (b % 64n)
        break
      case 'LSR':
        // a is already masked to an unsigned 64-bit value, so >> here is a
        // logical (zero-filling) shift - matches ARM64 LSR / this project's
        // existing .lshr() note in instruction-floor.ts.
        result = a >> (b % 64n)
        break
      default:
        throw new Error(`interpretArm64Program: opcode "${op}" passed validation but has no interpreter case - this is a real bug, not a candidate problem`)
    }
    registers.set(d, result & MASK64)
    instructionsExecuted++
  }

  return { registers: Object.fromEntries(registers), instructionsExecuted }
}
