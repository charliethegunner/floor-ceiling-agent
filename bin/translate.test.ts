import { describe, expect, test } from 'vitest'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeSource, parseArgs } from './translate'

const execAsync = promisify(exec)

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

// exec runs through a real shell, so each argument must be quoted explicitly -
// an args array passed with {shell: true} is NOT safely escaped by Node (only
// concatenated with spaces), which silently breaks any argument containing a
// space or a shell metacharacter like the `;` this CLI's own input format
// uses. Confirmed empirically: without this, "mov rax, rbx; add rax, rcx"
// was split by the shell into multiple arguments and an extra command.
function quoteArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`
}

async function runCli(args: string[]): Promise<CliResult> {
  const command = `npx tsx bin/translate.ts ${args.map(quoteArg).join(' ')}`
  try {
    const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() })
    return { stdout, stderr, exitCode: 0 }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.code ?? 1 }
  }
}

describe('normalizeSource', () => {
  test('splits on semicolons and rejoins with newlines', () => {
    expect(normalizeSource('mov rax, rbx; add rax, rcx')).toBe('mov rax, rbx\nadd rax, rcx')
  })

  test('trims whitespace around each segment and drops empty segments', () => {
    expect(normalizeSource('  mov rax, rbx ;  add rax, rcx ; ; ')).toBe('mov rax, rbx\nadd rax, rcx')
  })

  test('passes through a single instruction with no semicolons unchanged', () => {
    expect(normalizeSource('mov rax, rbx')).toBe('mov rax, rbx')
  })
})

describe('parseArgs', () => {
  test('parses a source string with no flags', () => {
    expect(parseArgs(['mov rax, rbx'])).toEqual({ source: 'mov rax, rbx', verify: false })
  })

  test('parses a source string with --verify in either position', () => {
    expect(parseArgs(['mov rax, rbx', '--verify'])).toEqual({ source: 'mov rax, rbx', verify: true })
    expect(parseArgs(['--verify', 'mov rax, rbx'])).toEqual({ source: 'mov rax, rbx', verify: true })
  })

  test('returns null when no positional source argument is given', () => {
    expect(parseArgs([])).toBeNull()
    expect(parseArgs(['--verify'])).toBeNull()
  })
})

describe('CLI integration: bin/translate.ts', () => {
  test('translates a semicolon-separated instruction sequence and prints the ARM64 result', async () => {
    const result = await runCli(['mov rax, rbx; add rax, rcx'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('MOV X0, X1\nADD X0, X0, X2')
  }, 20000)

  test('--verify runs CeilingAgent gates per instruction and reports all passing, including a case-insensitive symbolic proof', async () => {
    const result = await runCli(['mov rax, rbx; add rax, rcx', '--verify'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('MOV X0, X1')
    expect(result.stdout).toContain('[PASS] static')
    expect(result.stdout).toContain('[PASS] fuzz')
    expect(result.stdout).toContain('Z3 proved "mov rax, rbx" and "MOV X0, X1" are register-equivalent')
    expect(result.stdout).toContain('All gates passed.')
  }, 20000)

  test('exits non-zero and reports the pipeline error for malformed input', async () => {
    const result = await runCli(['jmp nowhere'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('unresolved label target: nowhere')
  }, 20000)

  test('exits non-zero with usage instructions when no source argument is given', async () => {
    const result = await runCli([])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Usage: translate')
  }, 20000)
})
