// Ambient module declaration for opencascade.js's internal glue module -
// there is no public, documented entry point that works under plain Node
// ESM (see oc-loader.ts's header comment for why this exact path is
// imported directly instead of the package's own index.js), and the
// package ships no types of its own for it either. Deliberately kept as a
// GLOBAL script file (no top-level import/export) - a `declare module`
// block for a fresh, untyped package only registers as a standalone
// ambient declaration from a global-scope file; inside a file that's
// itself a module (any top-level import/export, e.g. `export {}` used for
// the global.d.ts augmentation next to this one) the same block would
// instead be treated as an augmentation of an existing module, which
// requires one to already resolve - confirmed by hitting exactly that
// failure mode before splitting the two into separate files.

declare module 'opencascade.js/dist/opencascade.wasm.js' {
  import type { OpenCascadeInstance } from './oc-types'

  export default function initOpenCascade(options?: { wasmBinary?: Buffer | Uint8Array }): Promise<OpenCascadeInstance>
}
