import { TranslationResult } from './translator'
import { buildControlFlowGraph } from './cfg'
import { analyzeLiveness } from './liveness'
import { emitArm64 } from './emitter'

export function translateX86ToArm64(source: string): TranslationResult {
  const cfg = buildControlFlowGraph(source)
  if (!cfg.ok) return { ok: false, error: cfg.error }

  const liveness = analyzeLiveness(cfg)
  const emitted = emitArm64(cfg, liveness)
  if (!emitted.ok) return { ok: false, error: emitted.error }

  return { ok: true, instruction: emitted.program }
}
