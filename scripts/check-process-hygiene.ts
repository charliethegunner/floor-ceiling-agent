import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Phase 16.1: a REPORT-ONLY diagnostic utility for local test execution -
// this project's own worker_threads (WorkerPoolEvaluator,
// BRepWorkerPoolEvaluator) are real OS threads, not separate processes,
// so they never show up here at all; what THIS script looks for is a
// different, real problem an earlier investigation in this project found
// empirically: a `tsx <spike-script>.ts` invocation (this project's own
// established pattern for throwaway verification scripts, run directly
// via Bash/PowerShell rather than through vitest) that never exited -
// e.g. because it spawned a worker pool and never called shutdown() - and
// is still sitting there afterward, consuming real CPU/RAM.
//
// Deliberately does NOT kill anything itself. An earlier attempt to do
// exactly that (Stop-Process on a confirmed-orphaned process chain) was
// correctly blocked by this environment's own permission classifier -
// process termination is a genuinely destructive action that belongs to
// the person running this script, not something a "process hygiene"
// utility should do unprompted. This reports candidates and the exact
// command to remove them; nothing more.
//
// Windows-only for now (this project's actual development environment) -
// shells out to Get-CimInstance via PowerShell, since Node has no
// built-in cross-platform "list processes with their full command line"
// API and this project has a standing bias against adding a new
// dependency (e.g. a ps-list package) for something a single platform
// tool already does. A POSIX equivalent (`ps -eo pid,ppid,args`) would be
// a small, separate addition if this project's development environment
// ever needs it - not fabricated here without being able to verify it.

interface ProcessInfo {
  ProcessId: number
  ParentProcessId: number
  CreationDate: string
  CommandLine: string
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function listNodeProcesses(): ProcessInfo[] {
  const psCommand = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { encoding: 'utf8' })
  const parsed: unknown = JSON.parse(raw)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.filter((row): row is ProcessInfo => typeof row === 'object' && row !== null && 'ProcessId' in row)
}

// Known-legitimate, ongoing infrastructure this project's own development
// environment runs - never flagged as an "orphan," regardless of how long
// it's been running. Confirmed via a real investigation, not guessed:
// these are MCP tool servers the host application manages, restarted
// periodically - a completely different lifecycle from a one-shot spike
// script that should have exited after its own work finished.
const KNOWN_LEGITIMATE_PATTERNS = [/npx-cli\.js/i, /vitest/i, /@modelcontextprotocol/i, /\bmcp\b/i]

function isLikelyOrphanedProjectScript(proc: ProcessInfo): boolean {
  const cmd = proc.CommandLine ?? ''
  if (!cmd.includes(projectRoot) && !cmd.toLowerCase().includes(path.basename(projectRoot).toLowerCase())) return false
  return !KNOWN_LEGITIMATE_PATTERNS.some((pattern) => pattern.test(cmd))
}

function main(): void {
  const processes = listNodeProcesses()
  // Exclude this script's own process and its immediate launcher (the
  // `tsx` CLI wrapper) - both trivially match "references this project"
  // while this script is itself still running, and neither is orphaned.
  const ownPids = new Set([process.pid, process.ppid])
  const candidates = processes.filter((proc) => !ownPids.has(proc.ProcessId) && isLikelyOrphanedProjectScript(proc))

  if (candidates.length === 0) {
    console.log('No candidate orphaned processes found for this project.')
    return
  }

  console.log(`Found ${candidates.length} candidate process(es) referencing this project that are not recognized dev-server infrastructure:\n`)
  for (const proc of candidates) {
    console.log(`  PID ${proc.ProcessId} (parent ${proc.ParentProcessId}, started ${proc.CreationDate})`)
    console.log(`    ${proc.CommandLine}\n`)
  }
  console.log('This script does not terminate anything. To stop these yourself, review the command lines above, then run:')
  console.log(`  Stop-Process -Id ${candidates.map((p) => p.ProcessId).join(',')} -Force`)
}

main()
