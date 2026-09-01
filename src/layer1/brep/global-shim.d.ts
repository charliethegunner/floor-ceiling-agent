// The glue module opencascade-wasm.d.ts declares unconditionally reads the
// bare `__dirname` identifier during its own Node-environment setup
// (confirmed empirically - not gated behind any option), which does not
// exist under plain ESM. oc-loader.ts shims it onto globalThis before
// importing; this declares that shim's shape so the assignment
// type-checks.

declare global {
  var __dirname: string | undefined
}

export {}
