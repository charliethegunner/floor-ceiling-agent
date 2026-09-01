import { describe, test, expect } from 'vitest'
import { SandboxRunner } from './sandbox-runner'

describe('SandboxRunner.execute: real isolated execution', () => {
  test('executes a verified single instruction and returns the real resulting register state', async () => {
    const runner = new SandboxRunner()
    const result = await runner.execute('ADD X0, X1, X2', { X1: 3n, X2: 4n })

    expect(result.executed).toBe(true)
    expect(result.executed && result.registers.X0).toBe(7n)
    expect(result.executed && result.instructionsExecuted).toBe(1)
  }, 15000)

  test('executes a multi-instruction program sequentially', async () => {
    const runner = new SandboxRunner()
    const result = await runner.execute('MOV X0, X1\nADD X0, X0, X2\nSUB X0, X0, X1', { X1: 10n, X2: 5n })

    expect(result.executed).toBe(true)
    expect(result.executed && result.registers.X0).toBe(5n)
    expect(result.executed && result.instructionsExecuted).toBe(3)
  }, 15000)

  test('reports a real elapsedMs on success', async () => {
    const runner = new SandboxRunner()
    const result = await runner.execute('MOV X0, X1', { X1: 1n })
    expect(result.executed && result.elapsedMs).toBeGreaterThan(0)
  }, 15000)
})

describe('SandboxRunner.execute: payload isolation (Phase 12.1)', () => {
  test('an instruction outside the closed register-transfer ALU subset is refused, with no partial execution', async () => {
    const runner = new SandboxRunner()
    const result = await runner.execute('LDR X0, [X1]')
    expect(result).toEqual({ executed: false, reason: expect.stringContaining('unsupported/unsafe instruction "LDR"') })
  })

  test('a syscall-shaped instruction is refused the same way - no path exists to a real syscall from this interpreter', async () => {
    const runner = new SandboxRunner()
    const result = await runner.execute('SVC 0')
    expect(result.executed).toBe(false)
    expect(result.executed === false && result.reason).toContain('unsupported/unsafe instruction "SVC"')
  })

  test('rejection is near-instant (admission control, no sandbox worker spawned) compared to a real execution round-trip', async () => {
    const runner = new SandboxRunner()

    const rejectStart = Date.now()
    await runner.execute('LDR X0, [X1]')
    const rejectMs = Date.now() - rejectStart

    const executeStart = Date.now()
    await runner.execute('MOV X0, X1', { X1: 1n })
    const executeMs = Date.now() - executeStart

    expect(rejectMs).toBeLessThan(executeMs)
  }, 15000)

  test('separate executions are fully isolated - no register state leaks between calls', async () => {
    const runner = new SandboxRunner()
    const first = await runner.execute('MOV X0, X1', { X1: 99n })
    expect(first.executed && first.registers.X0).toBe(99n)

    // A second, independent execution with NO initial X1 - if state leaked
    // across sandboxed runs, X0 would still end up 99. A fresh worker per
    // execution means it must default to 0 instead.
    const second = await runner.execute('MOV X0, X1', {})
    expect(second.executed && second.registers.X0).toBe(0n)
  }, 15000)
})

describe('SandboxRunner.execute: timeout enforcement (Phase 12.1)', () => {
  test('a stuck execution is terminated at the deadline with the exact required diagnostic', async () => {
    const runner = new SandboxRunner()
    const result = await runner.__testExecuteRaw({ lines: ['MOV X0, X1'], initialRegisters: { X1: 1n }, __testHangMs: 2000 }, { timeoutMs: 100 })

    expect(result).toEqual({ executed: false, reason: 'Sandbox execution deadline exceeded' })
  }, 15000)

  test('termination happens close to the configured deadline, not after the full hang duration - proving real preemption, not a wait-then-report', async () => {
    const runner = new SandboxRunner()
    const start = Date.now()
    await runner.__testExecuteRaw({ lines: ['MOV X0, X1'], initialRegisters: { X1: 1n }, __testHangMs: 5000 }, { timeoutMs: 150 })
    const elapsed = Date.now() - start

    // Real worker.terminate() kills a genuine synchronous infinite/long
    // loop within ~ms of being called (verified directly against Node's
    // actual behavior before this was written) - so this must land well
    // short of the 5000ms hang, with headroom for slow CI/contended-system
    // worker spawn overhead on top of the 150ms deadline itself.
    expect(elapsed).toBeLessThan(2500)
  }, 15000)

  test('an execution that finishes well within the deadline is unaffected (regression guard)', async () => {
    const runner = new SandboxRunner()
    const result = await runner.execute('MOV X0, X1', { X1: 1n })
    expect(result.executed).toBe(true)
  }, 15000)
})

describe('SandboxRunner.execute: memory ceiling enforcement (Phase 12.1)', () => {
  test('an execution that blows the configured V8 heap ceiling is terminated and reported, not left to crash the host process', async () => {
    const runner = new SandboxRunner()
    const result = await runner.__testExecuteRaw(
      { lines: ['MOV X0, X1'], initialRegisters: { X1: 1n }, __testAllocateMb: 200 },
      { maxOldGenerationMb: 8, maxYoungGenerationMb: 8 }
    )

    expect(result.executed).toBe(false)
    expect(result.executed === false && result.reason).toContain('memory limit')
  }, 15000)

  test('a normal execution comfortably fits within the default memory ceiling (regression guard)', async () => {
    const runner = new SandboxRunner()
    const result = await runner.execute('ADD X0, X1, X2', { X1: 3n, X2: 4n })
    expect(result.executed).toBe(true)
  }, 15000)

  test('a small allocation well under the ceiling does not spuriously fail', async () => {
    const runner = new SandboxRunner()
    const result = await runner.__testExecuteRaw(
      { lines: ['MOV X0, X1'], initialRegisters: { X1: 1n }, __testAllocateMb: 2 },
      { maxOldGenerationMb: 64, maxYoungGenerationMb: 32 }
    )
    expect(result.executed).toBe(true)
  }, 15000)
})
