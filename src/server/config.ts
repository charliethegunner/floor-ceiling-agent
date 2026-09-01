// Phase 24.0: environment-variable parsing for the HTTP runtime wrapper
// (./index.ts). Every worker-pool/retry field below resolves to `undefined`
// when its env var is unset, rather than a duplicated numeric literal - the
// real defaults (MAX_RETRIES_DEFAULT=5, WorkerPoolEvaluator's
// os.cpus().length-1/512MB, BRepWorkerPoolEvaluator's 1/900MB) already live
// as the single source of truth in src/CeilingAgent.ts, src/layer1/worker-pool.ts,
// and src/layer1/brep/brep-worker-pool.ts (see docs/DEPLOYMENT.md's
// source-of-truth appendix) - `options.x ?? DEFAULT` at each constructor
// already does the right thing for `undefined`, so duplicating those numbers
// here would only create a second place they could drift out of sync.

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/

function parsePositiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    throw new Error(`Invalid ${name}: "${raw}" is not a positive integer`)
  }
  return Number(raw)
}

function parseRssThresholdBytes(name: string, rawMb: string | undefined): number | undefined {
  const mb = parsePositiveInt(name, rawMb)
  return mb === undefined ? undefined : mb * 1024 * 1024
}

export interface ServerConfig {
  /** HTTP port the wrapper listens on. Not part of docs/DEPLOYMENT.md §2.2's
   *  worker-pool/retry table - this wrapper owns it directly since a server
   *  must bind somewhere. */
  port: number
  /** `MAX_RETRIES` -> runCeilingAgent's `options.maxRetries`. Unset -> engine
   *  default (`MAX_RETRIES_DEFAULT`, src/CeilingAgent.ts). */
  maxRetries: number | undefined
  /** `WORKER_POOL_SIZE` -> `WorkerPoolOptions.poolSize`. Unset -> engine
   *  default (`os.cpus().length - 1`, src/layer1/worker-pool.ts). */
  workerPoolSize: number | undefined
  /** `BREP_WORKER_POOL_SIZE` -> `BRepWorkerPoolOptions.poolSize`. Unset ->
   *  engine default (`1`, src/layer1/brep/brep-worker-pool.ts). */
  brepWorkerPoolSize: number | undefined
  /** `WORKER_RSS_THRESHOLD_MB` (megabytes) -> `WorkerPoolOptions.maxWorkerRssBytes`
   *  (bytes). Unset -> engine default (512MB, src/layer1/worker-pool.ts). */
  workerRssThresholdBytes: number | undefined
  /** `BREP_RSS_THRESHOLD_MB` (megabytes) -> `BRepWorkerPoolOptions.maxWorkerRssBytes`
   *  (bytes). Unset -> engine default (900MB, src/layer1/brep/brep-worker-pool.ts). */
  brepRssThresholdBytes: number | undefined
  /** `LLM_TIMEOUT_MS` -> `OpenAiCompatibleClientOptions.timeoutMs`. Unset ->
   *  engine default (120000ms, src/CeilingAgent.ts). */
  llmTimeoutMs: number | undefined
  /** `LLM_BASE_URL` -> `OpenAiCompatibleClientOptions.baseUrl`. Required -
   *  there is no safe default endpoint to guess (docs/DEPLOYMENT.md §2.2). */
  llmBaseUrl: string
  /** `LLM_MODEL` -> `OpenAiCompatibleClientOptions.model`. Required for the
   *  same reason as `llmBaseUrl`. */
  llmModel: string
  /** `LLM_API_KEY` -> `OpenAiCompatibleClientOptions.apiKey`. Optional - a
   *  local Ollama/vLLM endpoint typically has no auth. */
  llmApiKey: string | undefined
}

const DEFAULT_PORT = 8080

/** Fails closed at startup - never falls back to an in-code default for a
 *  variable the operator explicitly set but got wrong, and never guesses an
 *  LLM endpoint (docs/DEPLOYMENT.md §2.2/§2.4). */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const llmBaseUrl = env.LLM_BASE_URL
  if (!llmBaseUrl) throw new Error('LLM_BASE_URL is required (e.g. http://localhost:11434/v1 for a local Ollama endpoint)')

  const llmModel = env.LLM_MODEL
  if (!llmModel) throw new Error('LLM_MODEL is required')

  return {
    port: parsePositiveInt('PORT', env.PORT) ?? DEFAULT_PORT,
    maxRetries: parsePositiveInt('MAX_RETRIES', env.MAX_RETRIES),
    workerPoolSize: parsePositiveInt('WORKER_POOL_SIZE', env.WORKER_POOL_SIZE),
    brepWorkerPoolSize: parsePositiveInt('BREP_WORKER_POOL_SIZE', env.BREP_WORKER_POOL_SIZE),
    workerRssThresholdBytes: parseRssThresholdBytes('WORKER_RSS_THRESHOLD_MB', env.WORKER_RSS_THRESHOLD_MB),
    brepRssThresholdBytes: parseRssThresholdBytes('BREP_RSS_THRESHOLD_MB', env.BREP_RSS_THRESHOLD_MB),
    llmTimeoutMs: parsePositiveInt('LLM_TIMEOUT_MS', env.LLM_TIMEOUT_MS),
    llmBaseUrl,
    llmModel,
    llmApiKey: env.LLM_API_KEY,
  }
}
