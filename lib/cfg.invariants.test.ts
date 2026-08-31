import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { buildControlFlowGraph } from './cfg'

const LABELS = ['start', 'loop', 'done', 'exit', 'a1', 'b2'] as const
const REGISTERS = ['RAX', 'RBX', 'RCX', 'RDX', 'RSP', 'RBP', 'RDI']
const CONDITIONAL_JUMPS = ['JE', 'JNE', 'JG', 'JL', 'JGE', 'JLE']

const labelArb = fc.constantFrom(...LABELS)
const registerArb = fc.constantFrom(...REGISTERS)

const labelLineArb = labelArb.map((l) => `${l}:`)
const jumpLineArb = labelArb.map((l) => `JMP ${l}`)
const branchLineArb = fc.tuple(fc.constantFrom(...CONDITIONAL_JUMPS), labelArb).map(([op, l]) => `${op} ${l}`)
const callLineArb = fc.oneof(
  labelArb.map((l) => `CALL ${l}`),
  registerArb.map((r) => `CALL ${r}`)
)
const retLineArb = fc.constant('RET')
const movLineArb = fc.tuple(registerArb, registerArb).map(([d, s]) => `MOV ${d}, ${s}`)
const addLineArb = fc.tuple(registerArb, registerArb).map(([d, s]) => `ADD ${d}, ${s}`)
const cmpLineArb = fc.tuple(registerArb, registerArb).map(([d, s]) => `CMP ${d}, ${s}`)
const blankLineArb = fc.constantFrom('', '   ', '\t', '  \t ')
const garbageLineArb = fc.string({ minLength: 1, maxLength: 12 }).map((s) => `???${s}???`)

const lineArb = fc.oneof(
  { weight: 3, arbitrary: labelLineArb },
  { weight: 2, arbitrary: jumpLineArb },
  { weight: 2, arbitrary: branchLineArb },
  { weight: 2, arbitrary: callLineArb },
  { weight: 1, arbitrary: retLineArb },
  { weight: 3, arbitrary: movLineArb },
  { weight: 1, arbitrary: addLineArb },
  { weight: 1, arbitrary: cmpLineArb },
  { weight: 2, arbitrary: blankLineArb },
  { weight: 1, arbitrary: garbageLineArb }
)

const programArb = fc
  .array(lineArb, { minLength: 0, maxLength: 40 })
  .map((lines) => lines.join('\n'))

const NUM_RUNS = 500

describe('buildControlFlowGraph structural invariants (fuzz)', () => {
  test('never throws and always returns a well-formed CfgResult', () => {
    fc.assert(
      fc.property(programArb, (source) => {
        expect(() => buildControlFlowGraph(source)).not.toThrow()
        const result = buildControlFlowGraph(source)
        expect(typeof result.ok).toBe('boolean')
      }),
      { numRuns: NUM_RUNS }
    )
  })

  test('invariant 1: determinism and idempotency across repeated executions', () => {
    fc.assert(
      fc.property(programArb, (source) => {
        const first = buildControlFlowGraph(source)
        const second = buildControlFlowGraph(source)
        const third = buildControlFlowGraph(source)
        expect(second).toEqual(first)
        expect(third).toEqual(first)
      }),
      { numRuns: NUM_RUNS }
    )
  })

  test('invariant 2: every successor edge has a matching predecessor edge', () => {
    fc.assert(
      fc.property(programArb, (source) => {
        const result = buildControlFlowGraph(source)
        if (!result.ok) return
        for (const [fromIdKey, successorIds] of Object.entries(result.successors)) {
          const fromId = Number(fromIdKey)
          for (const toId of successorIds) {
            expect(result.predecessors[toId] ?? []).toContain(fromId)
          }
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })

  test('invariant 3: predecessor lists are deduplicated and sorted ascending by id', () => {
    fc.assert(
      fc.property(programArb, (source) => {
        const result = buildControlFlowGraph(source)
        if (!result.ok) return
        for (const preds of Object.values(result.predecessors)) {
          const sortedUnique = [...new Set(preds)].sort((a, b) => a - b)
          expect(preds).toEqual(sortedUnique)
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })

  test('invariant 4: block ids form a zero-indexed, strictly sequential range', () => {
    fc.assert(
      fc.property(programArb, (source) => {
        const result = buildControlFlowGraph(source)
        if (!result.ok) return
        const ids = result.blocks.map((b) => b.id)
        const expected = result.blocks.map((_, i) => i)
        expect(ids).toEqual(expected)
      }),
      { numRuns: NUM_RUNS }
    )
  })

  test('invariant 5: each terminator kind produces its expected successor-edge cardinality', () => {
    fc.assert(
      fc.property(programArb, (source) => {
        const result = buildControlFlowGraph(source)
        if (!result.ok) return
        const lastId = result.blocks.length - 1

        for (const block of result.blocks) {
          const successorIds = result.successors[block.id] ?? []
          const hasFallthroughBlock = block.id < lastId

          switch (block.terminator.kind) {
            case 'jump':
              expect(successorIds.length).toBe(1)
              break
            case 'return':
              expect(successorIds.length).toBe(0)
              break
            case 'branch':
              expect(successorIds.length).toBe(hasFallthroughBlock ? 2 : 1)
              if (hasFallthroughBlock) expect(successorIds[1]).toBe(block.id + 1)
              break
            case 'call':
            case 'fallthrough':
              expect(successorIds.length).toBe(hasFallthroughBlock ? 1 : 0)
              if (hasFallthroughBlock) expect(successorIds[0]).toBe(block.id + 1)
              break
          }
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })
})
