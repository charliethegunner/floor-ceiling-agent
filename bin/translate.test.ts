import { describe, expect, test, afterAll } from 'vitest'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  test('parses a source string with no flags, defaulting to the instruction domain', () => {
    expect(parseArgs(['mov rax, rbx'])).toEqual({ source: 'mov rax, rbx', verify: false, domain: 'instruction' })
  })

  test('parses a source string with --verify in either position', () => {
    expect(parseArgs(['mov rax, rbx', '--verify'])).toEqual({ source: 'mov rax, rbx', verify: true, domain: 'instruction' })
    expect(parseArgs(['--verify', 'mov rax, rbx'])).toEqual({ source: 'mov rax, rbx', verify: true, domain: 'instruction' })
  })

  test('returns null when no positional source argument is given', () => {
    expect(parseArgs([])).toBeNull()
    expect(parseArgs(['--verify'])).toBeNull()
  })

  test('parses --domain=topology and --domain=claim in either position', () => {
    expect(parseArgs(['candidate.json', '--domain=topology'])).toEqual({ source: 'candidate.json', verify: false, domain: 'topology' })
    expect(parseArgs(['--domain=claim', 'candidate.json'])).toEqual({ source: 'candidate.json', verify: false, domain: 'claim' })
  })

  test('--domain is combinable with --verify', () => {
    expect(parseArgs(['candidate.json', '--domain=topology', '--verify'])).toEqual({
      source: 'candidate.json',
      verify: true,
      domain: 'topology',
    })
  })

  test('returns null for an unrecognized --domain value', () => {
    expect(parseArgs(['candidate.json', '--domain=bogus'])).toBeNull()
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

  test('exits non-zero with usage instructions for an unrecognized --domain value', async () => {
    const result = await runCli(['candidate.json', '--domain=bogus'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Usage: translate')
  }, 20000)
})

// ---------------------------------------------------------------------------
// --domain=topology / --domain=claim: end-to-end CLI execution against the
// Topology and Claim VerificationFloors (src/topology-floor.ts,
// src/claim-floor.ts), reusing verifyTopologyCandidate/verifyClaimCandidate
// (src/CeilingAgent.ts, Phase 5). The source argument for these domains is a
// path to a JSON candidate file rather than inline text - unlike the
// instruction domain's x86 source, a TopologyCandidate/ClaimCandidate is
// structured JSON containing double quotes throughout, which would be
// unreliable to pass as a single quoted shell argument (confirmed painful
// on Windows cmd.exe); a file path sidesteps shell quoting entirely.
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'translate-cli-'))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

function writeCandidateFile(name: string, candidate: unknown): string {
  const filePath = path.join(tmpRoot, name)
  writeFileSync(filePath, JSON.stringify(candidate))
  return filePath
}

const GOOD_TOPOLOGY_CANDIDATE = {
  inMemoryFiles: {
    'a.ts': "import { b } from './b'\nexport function a(): number { return b() }",
    'b.ts': 'export function b(): number { return 42 }',
  },
  expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
  reachability: [{ from: { filePath: 'a.ts', functionName: 'a' }, to: { filePath: 'b.ts', functionName: 'b' }, expectReachable: true }],
}

const TOPOLOGY_CANDIDATE_WITH_MISSING_EXPORT = {
  inMemoryFiles: {
    'a.ts': "import { b } from './b'\nfunction a(): number { return b() }",
    'b.ts': 'export function b(): number { return 42 }',
  },
  expectedExports: [{ filePath: 'a.ts', exportedNames: ['a'] }],
  reachability: [],
}

describe('CLI integration: bin/translate.ts --domain=topology', () => {
  test('a well-formed topology candidate passes all three gates and exits 0', async () => {
    const filePath = writeCandidateFile('good-topology.json', GOOD_TOPOLOGY_CANDIDATE)
    const result = await runCli([filePath, '--domain=topology'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('[PASS] exports')
    expect(result.stdout).toContain('[PASS] types')
    expect(result.stdout).toContain('[PASS] reachability')
    expect(result.stdout).toContain('All gates passed.')
  }, 20000)

  test('a candidate missing an expected export fails the exports gate and exits non-zero', async () => {
    const filePath = writeCandidateFile('bad-topology.json', TOPOLOGY_CANDIDATE_WITH_MISSING_EXPORT)
    const result = await runCli([filePath, '--domain=topology'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('[FAIL] exports')
    expect(result.stdout).toContain('expected export "a" not found')
    expect(result.stdout).toContain('One or more gates failed.')
  }, 20000)

  test('an unreadable candidate file path reports an error to stderr and exits non-zero', async () => {
    const result = await runCli([path.join(tmpRoot, 'does-not-exist.json'), '--domain=topology'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Could not read candidate file')
  }, 20000)
})

const GOOD_CLAIM_CANDIDATE = {
  claims: [
    {
      statement: 'translateInstruction lowers MOV RAX, RBX to MOV X0, X1',
      subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
      assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X0, X1' } },
    },
  ],
}

const FALSE_CLAIM_CANDIDATE = {
  claims: [
    {
      statement: 'translateInstruction lowers MOV RAX, RBX to MOV X1, X0',
      subject: { modulePath: 'lib/translator.ts', exportName: 'translateInstruction' },
      assertion: { args: ['MOV RAX, RBX'], expected: { ok: true, instruction: 'MOV X1, X0' } },
    },
  ],
}

describe('CLI integration: bin/translate.ts --domain=claim', () => {
  test('a true claim about a real, committed repository function passes all three gates and exits 0', async () => {
    const filePath = writeCandidateFile('good-claim.json', GOOD_CLAIM_CANDIDATE)
    const result = await runCli([filePath, '--domain=claim'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('[PASS] structural')
    expect(result.stdout).toContain('[PASS] cross-reference')
    expect(result.stdout).toContain('[PASS] empirical')
    expect(result.stdout).toContain('All gates passed.')
  }, 20000)

  test('a false claim is caught by the empirical gate, by actually running the function, and exits non-zero', async () => {
    const filePath = writeCandidateFile('false-claim.json', FALSE_CLAIM_CANDIDATE)
    const result = await runCli([filePath, '--domain=claim'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('[PASS] structural')
    expect(result.stdout).toContain('[PASS] cross-reference')
    expect(result.stdout).toContain('[FAIL] empirical')
    expect(result.stdout).toContain('One or more gates failed.')
  }, 20000)
})
