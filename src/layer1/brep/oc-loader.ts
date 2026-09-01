import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import initOpenCascade from 'opencascade.js/dist/opencascade.wasm.js'
import type { OpenCascadeInstance } from './oc-types'

// Phase 15.0: opencascade.js's dist build has three real, spike-confirmed
// incompatibilities with plain Node ESM - none documented in the package's
// own README - worked around exactly once, here:
//
// 1. The package's own index.js entry point does
//    `import wasmFile from "./dist/opencascade.wasm.wasm"` - a
//    bundler-only (webpack/vite) asset-URL import, not valid Node. This
//    imports the internal dist/opencascade.wasm.js glue file directly
//    instead (an undocumented, unstable path - see opencascade-wasm.d.ts).
// 2. That glue file unconditionally reads the bare `__dirname` identifier
//    during its own Node-environment setup, before its locateFile option
//    is ever consulted - confirmed to throw "ReferenceError: __dirname is
//    not defined" under this project's ESM ("type": "module") regardless
//    of what options are passed. Strict mode (all ES modules) only forbids
//    *creating* an implicit global via assignment - *reading* one that
//    already exists on globalThis still resolves via the scope chain, so
//    shimming it before import sidesteps the crash.
// 3. Even past that shim, WASM byte-loading prefers a global fetch() when
//    present (Node 18+ exposes one) and fails against a raw filesystem
//    path ("TypeError: fetch failed" - confirmed empirically). Reading the
//    .wasm bytes directly and passing them via Module.wasmBinary bypasses
//    locateFile/fetch/readFileSync resolution entirely.
//
// Memoized at module scope: this is only ever imported from a worker
// thread's own entry point (brep-worker.ts), one per worker, so the ~600ms
// cold-init cost is paid once per worker's lifetime, not once per
// verification call.

const require = createRequire(import.meta.url)

let cachedInit: Promise<OpenCascadeInstance> | null = null

export function loadOpenCascade(): Promise<OpenCascadeInstance> {
  cachedInit ??= (() => {
    const wasmPath = require.resolve('opencascade.js/dist/opencascade.wasm.wasm')
    globalThis.__dirname ??= path.dirname(wasmPath)
    const wasmBinary = readFileSync(wasmPath)
    return initOpenCascade({ wasmBinary })
  })()
  return cachedInit
}
