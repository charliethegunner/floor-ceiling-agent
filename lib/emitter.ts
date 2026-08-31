import { X86Register, translateInstruction } from './translator'
import { CfgSuccess } from './cfg'
import { LivenessResult } from './liveness'

export interface EmitSuccess {
  ok: true
  program: string
}

export interface EmitError {
  ok: false
  error: string
}

export type EmitterResult = EmitSuccess | EmitError

const CALL_PROTECTED_X86_REGISTER: X86Register = 'RBX'
const CALL_PROTECTED_ARM64_REGISTER = 'X1'
const SPILL_SLOT_BYTES = 16

export function emitArm64(cfg: CfgSuccess, liveness: LivenessResult): EmitterResult {
  const lines: string[] = []

  for (const block of cfg.blocks) {
    if (block.label !== null) {
      lines.push(`${block.label}:`)
    }

    const lastIndex = block.instructions.length - 1
    for (let i = 0; i < block.instructions.length; i++) {
      const text = block.instructions[i]
      const isLast = i === lastIndex

      if (isLast && block.terminator.kind === 'jump') {
        lines.push(`B ${block.terminator.target}`)
        continue
      }

      if (isLast && block.terminator.kind === 'return') {
        lines.push('RET')
        continue
      }

      const translated = translateInstruction(text)
      if (!translated.ok) {
        return { ok: false, error: `block ${block.id}, instruction "${text}": ${translated.error}` }
      }

      if (isLast && block.terminator.kind === 'call' && liveness.liveOut[block.id].includes(CALL_PROTECTED_X86_REGISTER)) {
        lines.push(`SUB SP, SP, #${SPILL_SLOT_BYTES}`)
        lines.push(`STR ${CALL_PROTECTED_ARM64_REGISTER}, [SP]`)
        lines.push(...translated.instruction.split('\n'))
        lines.push(`LDR ${CALL_PROTECTED_ARM64_REGISTER}, [SP]`)
        lines.push(`ADD SP, SP, #${SPILL_SLOT_BYTES}`)
        continue
      }

      lines.push(...translated.instruction.split('\n'))
    }
  }

  return { ok: true, program: lines.join('\n') }
}
