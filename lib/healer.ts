export type DiagnosticStatus = 'healthy' | 'degraded' | 'failed'

export interface DiagnosticResult {
  status: DiagnosticStatus
  issues: string[]
  autoFixesApplied: string[]
}

export interface EnvironmentMetrics {
  heapUsedRatio: number
  memoryAllocatable: boolean
  testRunnerAvailable: boolean
}

export interface ResolutionStrategy {
  name: string
  apply: () => void
}

export interface HealerState {
  cache: Map<string, unknown>
  lotSize: number
}

export const healerState: HealerState = {
  cache: new Map(),
  lotSize: 0.02,
}

export const defaultStrategies: ResolutionStrategy[] = [
  {
    name: 'flush state cache',
    apply: () => {
      healerState.cache.clear()
    },
  },
  {
    name: 'correct environment variables',
    apply: () => {
      if (process.env.LOT_SIZE !== undefined && Number.isNaN(Number(process.env.LOT_SIZE))) {
        delete process.env.LOT_SIZE
      }
    },
  },
  {
    name: 'reset lot size to default (0.02)',
    apply: () => {
      healerState.lotSize = 0.02
    },
  },
]

function gatherDefaultMetrics(): EnvironmentMetrics {
  const mem = process.memoryUsage()
  let memoryAllocatable = true
  try {
    new Array(1024).fill(0)
  } catch {
    memoryAllocatable = false
  }

  return {
    heapUsedRatio: mem.heapTotal === 0 ? 0 : mem.heapUsed / mem.heapTotal,
    memoryAllocatable,
    testRunnerAvailable: process.env.VITEST !== undefined,
  }
}

export function probeEnvironment(metrics: EnvironmentMetrics = gatherDefaultMetrics()): DiagnosticResult {
  const issues: string[] = []

  if (metrics.heapUsedRatio > 0.9) issues.push('high memory usage detected')
  if (!metrics.memoryAllocatable) issues.push('memory allocation failure')
  if (!metrics.testRunnerAvailable) issues.push('test runner unavailable')

  const status: DiagnosticStatus =
    issues.length === 0 ? 'healthy' : issues.length === 1 ? 'degraded' : 'failed'

  return { status, issues, autoFixesApplied: [] }
}

export interface SelfHealingOptions {
  strategies?: ResolutionStrategy[]
  maxAttempts?: number
}

export function executeSelfHealingLoop(
  operation: () => void,
  options: SelfHealingOptions = {}
): DiagnosticResult {
  const strategies = options.strategies ?? defaultStrategies
  const maxAttempts = options.maxAttempts ?? 3
  const issues: string[] = []
  const autoFixesApplied: string[] = []

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      operation()
      return {
        status: autoFixesApplied.length > 0 ? 'degraded' : 'healthy',
        issues,
        autoFixesApplied,
      }
    } catch (error) {
      const trace = error instanceof Error ? error.stack ?? error.message : String(error)
      issues.push(trace)

      const strategy = strategies[attempt]
      if (strategy) {
        strategy.apply()
        autoFixesApplied.push(strategy.name)
      }
    }
  }

  return { status: 'failed', issues, autoFixesApplied }
}
