import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer, closeHttpServer, RecycleWindowTracker, type ServerDependencies } from './index'
import { loadServerConfig, type ServerConfig } from './config'
import { WorkerPoolEvaluator } from '../layer1/worker-pool'
import { BRepWorkerPoolEvaluator } from '../layer1/brep/brep-worker-pool'
import { registerForGracefulShutdown, runGracefulShutdown, type Terminable } from '../layer1/process-lifecycle'
import type { LlmClient } from '../CeilingAgent'

class ScriptedLlmClient implements LlmClient {
  async complete(): Promise<string> {
    throw new Error('ScriptedLlmClient: no response scripted for this test')
  }
}

function requestJson(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : undefined,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, body: text.length > 0 ? JSON.parse(text) : undefined })
        })
      }
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

const TEST_CONFIG: ServerConfig = loadServerConfig({ LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MODEL: 'test-model' })

describe('loadServerConfig: environment variable parsing (docs/DEPLOYMENT.md §2.2)', () => {
  test('with only the required LLM vars set, every worker-pool/retry field is undefined (defers to the real engine default)', () => {
    const config = loadServerConfig({ LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MODEL: 'test-model' })
    expect(config.maxRetries).toBeUndefined()
    expect(config.workerPoolSize).toBeUndefined()
    expect(config.brepWorkerPoolSize).toBeUndefined()
    expect(config.workerRssThresholdBytes).toBeUndefined()
    expect(config.brepRssThresholdBytes).toBeUndefined()
    expect(config.llmTimeoutMs).toBeUndefined()
    expect(config.port).toBe(8080)
  })

  test('parses every documented env var into its resolved field', () => {
    const config = loadServerConfig({
      LLM_BASE_URL: 'http://localhost:11434/v1',
      LLM_MODEL: 'test-model',
      LLM_API_KEY: 'secret',
      MAX_RETRIES: '3',
      WORKER_POOL_SIZE: '2',
      BREP_WORKER_POOL_SIZE: '1',
      WORKER_RSS_THRESHOLD_MB: '256',
      BREP_RSS_THRESHOLD_MB: '700',
      LLM_TIMEOUT_MS: '5000',
      PORT: '9090',
    })

    expect(config.maxRetries).toBe(3)
    expect(config.workerPoolSize).toBe(2)
    expect(config.brepWorkerPoolSize).toBe(1)
    expect(config.workerRssThresholdBytes).toBe(256 * 1024 * 1024)
    expect(config.brepRssThresholdBytes).toBe(700 * 1024 * 1024)
    expect(config.llmTimeoutMs).toBe(5000)
    expect(config.llmApiKey).toBe('secret')
    expect(config.port).toBe(9090)
  })

  test('throws when LLM_BASE_URL is missing - no safe default endpoint to guess', () => {
    expect(() => loadServerConfig({ LLM_MODEL: 'test-model' })).toThrow(/LLM_BASE_URL/)
  })

  test('throws when LLM_MODEL is missing', () => {
    expect(() => loadServerConfig({ LLM_BASE_URL: 'http://localhost:11434/v1' })).toThrow(/LLM_MODEL/)
  })

  test.each(['abc', '0', '-5', '3.5', ''])('fails closed on an invalid MAX_RETRIES value %j rather than silently falling back to the default', (raw) => {
    expect(() => loadServerConfig({ LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MODEL: 'test-model', MAX_RETRIES: raw })).toThrow(/MAX_RETRIES/)
  })
})

describe('RecycleWindowTracker: the recycledWorkerCount-growth proxy behind /ready\'s RSS-limit signal', () => {
  test('reports zero growth on the first sample', () => {
    const tracker = new RecycleWindowTracker(1000)
    expect(tracker.recordAndCountRecent(0, 0)).toBe(0)
  })

  test('reports cumulative growth while every sample stays inside the window', () => {
    const tracker = new RecycleWindowTracker(10_000)
    expect(tracker.recordAndCountRecent(0, 0)).toBe(0)
    expect(tracker.recordAndCountRecent(3, 1000)).toBe(3)
    expect(tracker.recordAndCountRecent(5, 2000)).toBe(5)
  })

  test('a sample older than the window is evicted and no longer counted toward growth', () => {
    const tracker = new RecycleWindowTracker(1000)
    tracker.recordAndCountRecent(1, 0)
    expect(tracker.recordAndCountRecent(4, 2000)).toBe(0) // the t=0 sample is now outside the [1000,2000] window
  })
})

describe('server routes: real WorkerPoolEvaluator/BRepWorkerPoolEvaluator instances (poolSize: 1)', () => {
  let workerPool: WorkerPoolEvaluator
  let brepPool: BRepWorkerPoolEvaluator
  let deps: ServerDependencies
  let server: http.Server
  let port: number

  beforeAll(async () => {
    workerPool = new WorkerPoolEvaluator({ poolSize: 1 })
    brepPool = new BRepWorkerPoolEvaluator({ poolSize: 1 })
    deps = { llmClient: new ScriptedLlmClient(), workerPool, brepPool }
    server = createServer(TEST_CONFIG, deps)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    port = (server.address() as AddressInfo).port
  }, 30_000)

  afterAll(async () => {
    if (server.listening) await closeHttpServer(server)
    await Promise.all([workerPool.shutdown(), brepPool.shutdown()])
  }, 30_000)

  describe('GET /healthz (liveness)', () => {
    test('returns 200 with a real measured event loop lag', async () => {
      const { status, body } = await requestJson(port, 'GET', '/healthz')
      expect(status).toBe(200)
      const parsed = body as { status: string; eventLoopLagMs: number }
      expect(parsed.status).toBe('ok')
      expect(typeof parsed.eventLoopLagMs).toBe('number')
      expect(parsed.eventLoopLagMs).toBeGreaterThanOrEqual(0)
    })

    test('/live is an alias for /healthz', async () => {
      const { status, body } = await requestJson(port, 'GET', '/live')
      expect(status).toBe(200)
      expect((body as { status: string }).status).toBe('ok')
    })
  })

  describe('GET /ready (readiness)', () => {
    test('returns 200 and reports both pools as responsive with real slot counts', async () => {
      const { status, body } = await requestJson(port, 'GET', '/ready')
      expect(status).toBe(200)
      const parsed = body as { status: string; workerPool: { poolSize: number; responsive: boolean }; brepWorkerPool: { poolSize: number; responsive: boolean } }
      expect(parsed.status).toBe('ready')
      expect(parsed.workerPool).toEqual(expect.objectContaining({ poolSize: 1, responsive: true }))
      expect(parsed.brepWorkerPool).toEqual(expect.objectContaining({ poolSize: 1, responsive: true }))
    }, 15_000)
  })

  describe('POST /verify', () => {
    test('returns 400 with a clear error for a malformed body, without calling the LLM', async () => {
      const { status, body } = await requestJson(port, 'POST', '/verify', { kind: 'not-a-real-domain', description: 'x' })
      expect(status).toBe(400)
      expect((body as { error: string }).error).toMatch(/"kind"/)
    })

    test('returns 400 when the request body is not valid JSON', async () => {
      const address = server.address() as AddressInfo
      const { status, body } = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/verify', headers: { 'Content-Type': 'application/json' } }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
        })
        req.on('error', reject)
        req.write('{not valid json')
        req.end()
      })
      expect(status).toBe(400)
      expect((body as { error: string }).error).toMatch(/JSON/)
    })
  })

  describe('GET /metrics', () => {
    test('reports real pool state and a request-count breakdown', async () => {
      const { status, body } = await requestJson(port, 'GET', '/metrics')
      expect(status).toBe(200)
      const parsed = body as {
        totalVerifications: number
        workerPool: { poolSize: number; recycledWorkerCount: number }
        brepWorkerPool: { poolSize: number; recycledWorkerCount: number }
      }
      // recycledWorkerCount is NOT asserted to be exactly 0: real worker RSS
      // (Z3 + ts-morph eagerly loaded per worker, see worker-pool.ts's own
      // DEFAULT_MAX_WORKER_RSS_BYTES comment) can legitimately cross the
      // 512MB default under test-harness overhead, triggering a real,
      // correct recycle - a hard "zero" assertion here would be exactly the
      // flaky-on-different-hardware failure ARCHITECTURE.md §9 already
      // declines to build for load-test-engine.ts, for the same reason.
      expect(parsed.workerPool.poolSize).toBe(1)
      expect(parsed.workerPool.recycledWorkerCount).toBeGreaterThanOrEqual(0)
      expect(parsed.brepWorkerPool.poolSize).toBe(1)
      expect(parsed.brepWorkerPool.recycledWorkerCount).toBeGreaterThanOrEqual(0)
      expect(typeof parsed.totalVerifications).toBe('number')
    })
  })

  describe('unknown route', () => {
    test('returns 404', async () => {
      const { status } = await requestJson(port, 'GET', '/not-a-real-route')
      expect(status).toBe(404)
    })
  })
})

describe('GET /ready: a pool that cannot respond (fail-open contract already tripped) reports 503, not 200', () => {
  test('a shut-down worker pool falls back on every verify() call, and /ready reports not-ready', async () => {
    const workerPool = new WorkerPoolEvaluator({ poolSize: 1 })
    const brepPool = new BRepWorkerPoolEvaluator({ poolSize: 1 })
    await workerPool.shutdown() // closed pools fall back on every verify() call (worker-pool.ts's fail-open contract) - simulates "unresponsive" without flakiness

    const deps: ServerDependencies = { llmClient: new ScriptedLlmClient(), workerPool, brepPool }
    const server = createServer(TEST_CONFIG, deps)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const { status, body } = await requestJson(port, 'GET', '/ready')
      expect(status).toBe(503)
      const parsed = body as { status: string; workerPool: { responsive: boolean } }
      expect(parsed.status).toBe('not-ready')
      expect(parsed.workerPool.responsive).toBe(false)
    } finally {
      await closeHttpServer(server)
      await brepPool.shutdown()
    }
  }, 20_000)
})

describe('graceful shutdown: the http.Server registers with the shared process-lifecycle fan-out', () => {
  test('runGracefulShutdown() closes the server via the SAME shared mechanism WorkerPoolEvaluator/BRepWorkerPoolEvaluator use (not a bespoke handler)', async () => {
    const workerPool = new WorkerPoolEvaluator({ poolSize: 1 })
    const brepPool = new BRepWorkerPoolEvaluator({ poolSize: 1 })
    const deps: ServerDependencies = { llmClient: new ScriptedLlmClient(), workerPool, brepPool }
    const server = createServer(TEST_CONFIG, deps)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port

    const terminable: Terminable = { terminate: () => closeHttpServer(server) }
    const unregister = registerForGracefulShutdown(terminable)

    expect(server.listening).toBe(true)
    const before = await requestJson(port, 'GET', '/healthz')
    expect(before.status).toBe(200)

    try {
      await runGracefulShutdown()
      expect(server.listening).toBe(false)
      await expect(requestJson(port, 'GET', '/healthz')).rejects.toThrow()
    } finally {
      unregister() // already unregistered by runGracefulShutdown, but idempotent per process-lifecycle.ts
      await Promise.all([workerPool.shutdown(), brepPool.shutdown()])
    }
  }, 20_000)

  // A Terminable that throws never blocking another Terminable's cleanup is
  // already proven generically by process-lifecycle.test.ts's own
  // Promise.allSettled test - not re-proven here with a second real
  // workerPool/brepPool pair, which would only add real worker-thread/
  // OpenCASCADE memory cost for coverage this suite already has.
})
