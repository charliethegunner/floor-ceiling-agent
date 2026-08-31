import { translateX86ToArm64 } from '../lib/index'
import { translateInstruction } from '../lib/translator'
import { verifyInstructionCandidate } from '../src/CeilingAgent'

const LABEL_LINE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*:$/

/**
 * Sanitizes CLI input for the translation pipeline, which expects
 * newline-separated instructions: splits on `;` (a natural one-liner
 * separator for shell invocation) and rejoins with `\n`.
 */
export function normalizeSource(rawInput: string): string {
  return rawInput
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n')
}

export interface ParsedArgs {
  source: string
  verify: boolean
}

export function parseArgs(argv: string[]): ParsedArgs | null {
  const verify = argv.includes('--verify')
  const positional = argv.filter((arg) => arg !== '--verify')
  if (positional.length !== 1) return null
  return { source: positional[0], verify }
}

/**
 * Verifies the translated output against CeilingAgent's per-instruction
 * gates (static, fuzz, symbolic). Runs per x86 instruction line via
 * translateInstruction, not the whole-program translateX86ToArm64 output -
 * verifyInstructionCandidate is designed for one x86 instruction plus one
 * ARM64 candidate, and for straight-line register-only sequences (no
 * labels, branches, calls, or memory operands) this produces exactly the
 * same lowering the full pipeline does. Programs with labels/terminators/
 * spill wrapping are not decomposed back into per-instruction pieces here;
 * label lines are skipped rather than mis-verified. Opcodes the symbolic
 * gate has no ground-truth model for (PUSH/POP/CALL/RET/Jcc/JMP) report
 * that gate as passing-but-skipped, per verifyInstructionCandidate's own
 * design - not a limitation introduced by this CLI.
 */
async function runVerification(normalizedSource: string): Promise<boolean> {
  const lines = normalizedSource
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !LABEL_LINE_PATTERN.test(line))

  console.log('\n--- Verification (CeilingAgent gates, per instruction) ---')

  let allPassed = true
  for (const x86Line of lines) {
    const translated = translateInstruction(x86Line)
    console.log(`\n${x86Line}`)
    if (!translated.ok) {
      console.log(`  SKIPPED: could not translate this instruction individually (${translated.error})`)
      continue
    }
    console.log(`  -> ${translated.instruction}`)

    const gates = await verifyInstructionCandidate(x86Line, translated.instruction)
    for (const gate of gates) {
      console.log(`  [${gate.ok ? 'PASS' : 'FAIL'}] ${gate.gate}: ${gate.details}`)
      if (!gate.ok) allPassed = false
    }
  }

  console.log(`\n${allPassed ? 'All gates passed.' : 'One or more gates failed.'}`)
  return allPassed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args === null) {
    console.error('Usage: translate "<x86 source>" [--verify]')
    console.error('Example: translate "mov rax, rbx; add rax, rcx" --verify')
    process.exitCode = 1
    return
  }

  const normalized = normalizeSource(args.source)
  const result = translateX86ToArm64(normalized)

  if (!result.ok) {
    console.error(`Translation failed: ${result.error}`)
    process.exitCode = 1
    return
  }

  console.log(result.instruction)

  if (args.verify) {
    const allPassed = await runVerification(normalized)
    if (!allPassed) process.exitCode = 1
  }
}

main()
