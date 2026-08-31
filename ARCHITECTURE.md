# SPEC-014: System Architecture & Verification Floor Reference

This document is SPEC-014 in this project's spec lineage. Unlike SPEC-006 through
SPEC-013, it doesn't introduce new code via a RED/GREEN TDD cycle — it's a reference
describing the system as it exists after SPEC-013 (the end-to-end pipeline) and the
Deterministic Verification Floor built immediately after it. Keep it up to date when
the architecture changes; treat a stale section here as a bug.

## 1. Overview

This project is a stateless x86-64 → ARM64 **instruction-string translator**. It does
not execute, JIT, or assemble to machine code — every layer operates on and produces
plain text. The pipeline:

```
x86 source (string)
      │
      ▼
buildControlFlowGraph   (lib/cfg.ts)       — partition into basic blocks + CFG edges
      │
      ▼
analyzeLiveness         (lib/liveness.ts)  — backward dataflow: liveIn/liveOut per block
      │
      ▼
emitArm64               (lib/emitter.ts)   — assemble the final ARM64 listing
      │
      ▼
ARM64 program (string) or a structured error
```

`lib/index.ts` composes exactly this into one public entrypoint,
`translateX86ToArm64`. A separate, orthogonal concern — `src/FloorEngine.ts` — verifies
the pipeline itself (its source code, its runtime behavior, and its translation
semantics) rather than being part of the pipeline.

`lib/healer.ts` is an unrelated, pre-existing module (a generic self-healing
diagnostic/retry loop) that predates this translator work and shares no code with it.
It is not part of this architecture.

## 2. Translation Pipeline, Layer by Layer

### 2.1 `lib/translator.ts` — per-instruction lowering

The foundation every other layer builds on. Pure, stateless, single-instruction in,
single-instruction (or a `\n`-joined multi-instruction sequence, for SIB-with-
displacement) out.

- **`translateInstruction(input: string): TranslationResult`** — the core lowering
  function. Supports `MOV`, `ADD`, `CMP`, `PUSH`, `POP`, `CALL`, and the six `Jcc`
  variants (`JE`/`JNE`/`JG`/`JL`/`JGE`/`JLE`). Deliberately does **not** support `JMP`
  or `RET` — see §2.3.
- **`registerMap: Record<X86Register, Arm64Register>`** — the fixed, static register
  assignment (`RAX→X0, RBX→X1, RCX→X2, RDX→X3, RSP→SP, RBP→FP, RDI→X4`) every other
  layer relies on. There is no dynamic register allocator anywhere in this system —
  see SPEC-012's finding in §3.3 for why one was never needed.
- **`X86Register` / `Arm64Register`** — the two closed register-name unions.
- **`TranslationResult` / `TranslationSuccess` / `TranslationError`** — the
  `{ok:true, instruction}` / `{ok:false, error}` discriminated union used, verbatim or
  by convention, at every layer above this one.
- **`classifyX86Operand(operand): X86OperandClass`** — an x86-level sibling to the
  internal `resolveOperand`, added in SPEC-011 for `liveness.ts`'s use. Classifies an
  operand as `register`/`immediate`/`memory` (covering both plain and SIB addressing)/
  `unresolved`, returning x86 register names rather than `resolveOperand`'s ARM64 ones.
- **`parseInstruction`, `LABEL_PATTERN`, `JCC_CONDITIONS`** — additive exports (added
  in SPEC-009) reused by `cfg.ts` and `liveness.ts` rather than being reimplemented.

Lowering rules implemented, roughly in the order they were added: register-register
`MOV`/`ADD`, indirect memory load/store (`[base+disp]`), `PUSH`/`POP` (pre/post-indexed
`SP`), `CALL`→`BL`/`BLR`, lazy-EFLAGS `CMP`+`Jcc`→native `CMP`+`B.cond` (no software
flags model — ARM64's own NZCV register carries flag state at runtime), and SIB
addressing (`[base+index*scale+disp]`, scale `1/2/4/8`→`LSL #0/#1/#2/#3`, with a fixed
`X9` scratch register for the displaced-SIB two-instruction case).

### 2.2 `lib/cfg.ts` — basic blocks & control flow graph (SPEC-009 / SPEC-010)

- **`buildControlFlowGraph(source: string): CfgResult`** — partitions multi-line x86
  source into basic blocks bound by labels and terminators (`JMP`/`Jcc`/`CALL`/`RET`),
  then builds explicit `successors`/`predecessors` edge maps.
- **`BasicBlock`** — `{ id, label, startLine, instructions: string[], terminator }`.
  Block `id`s are strictly ascending, zero-indexed, contiguous — a property fuzz-tested
  500 runs in `lib/cfg.invariants.test.ts` (SPEC-010), alongside determinism,
  bidirectional edge integrity, predecessor dedup/sort, and per-terminator edge
  cardinality.
- **`TerminatorKind`** — `jump | branch | call | return | fallthrough`. `branch`
  successors are always `[taken, fallthrough]` in that order (taken-first convention).
- Deliberately **opcode-agnostic**: an unrecognized mnemonic partitions fine (as a
  `fallthrough` instruction) — recognition/translatability is a downstream concern, not
  this layer's.
- Key invariant several later layers depend on: `CALL` is *always* a block terminator,
  so a block's `liveOut` (SPEC-011) or `successors` entry (here) is exactly "what
  happens immediately after this call," with no approximation.

### 2.3 `lib/liveness.ts` — register liveness analysis (SPEC-011)

- **`analyzeLiveness(cfg: CfgSuccess): LivenessResult`** — backward fixed-point
  worklist dataflow, producing `{ liveIn, liveOut }: Record<number, X86Register[]>`
  (sorted, deduplicated arrays — never raw `Set`s, to keep output order-independent).
- Per-opcode `use`/`def` policy: `ADD dst,src` is read-modify-write (`dst` is both used
  and defined); `CALL` defines `{RSP} ∪ {RAX,RCX,RDX,RDI}` (the caller-saved clobber
  set) and uses `{RSP}` plus a register-form target; `RET` uses `{RAX, RSP}` (implicit
  return-value register and stack pointer); `Jcc`/`JMP` touch no general-purpose
  register at all (flags are unmodeled, per §2.1's lazy-EFLAGS note). An unrecognized
  opcode conservatively assumes `def = {}` but `use` = every register-shaped operand
  present — safe in the direction that can't hide a real dependency.
- Requires a precondition, not an input check: takes an already-built `CfgSuccess`
  (never a raw source string, never a `CfgError`) — TypeScript enforces this at the
  call site.

### 2.4 `lib/emitter.ts` — ARM64 code generation (SPEC-012)

- **`emitArm64(cfg: CfgSuccess, liveness: LivenessResult): EmitterResult`** — walks
  `cfg.blocks` in deterministic order, emitting `${label}:` definition lines (nothing
  upstream produces these) and lowering each instruction via `translateInstruction`.
- `JMP`/`RET` bypass `translateInstruction` entirely, emitted directly from
  `block.terminator` (`B ${target}` / bare `RET`) — the two opcodes `cfg.ts` recognizes
  structurally but `translator.ts` was never asked to support.
- **AAPCS64 spill/reload**: SPEC-012's central finding is that `RBX` (x86 callee-saved)
  maps to ARM64 `X1`, which is **caller-saved** under the real AAPCS64 calling
  convention — the one register where our fixed mapping disagrees with x86 semantics.
  When `'RBX' ∈ liveOut(block)` for a call-terminated block, the emitted `BL`/`BLR` is
  wrapped in a 16-byte-aligned spill/reload (`SUB SP,SP,#16` / `STR X1,[SP]` / … /
  `LDR X1,[SP]` / `ADD SP,SP,#16` — 16, not 8, bytes even though only one register is
  stored, to preserve AAPCS64's 16-byte `SP` alignment requirement at any `BL`/`BLR`).
  `RBP`/`FP` is never spilled — it's callee-saved on both ISAs, so no mismatch exists.
- Unlike `cfg.ts`/`liveness.ts`, this layer is **not** opcode-agnostic: a
  `translateInstruction` failure propagates as `EmitError` immediately, since code
  generation cannot proceed without knowing what an instruction means.

### 2.5 `lib/index.ts` — public pipeline entrypoint (SPEC-013)

- **`translateX86ToArm64(source: string): TranslationResult`** — the entire public API
  surface for the translation pipeline. Three sequential calls, two early-returns:
  `buildControlFlowGraph` → (on `CfgError`, return `{ok:false, error}`) →
  `analyzeLiveness` → `emitArm64` → (on `EmitError`, return `{ok:false, error}`) →
  `{ok:true, instruction: emitted.program}`.
- Reuses `translator.ts`'s original `TranslationResult` type rather than inventing a
  new one — a deliberate consistency choice (see the type's doc comment in
  `translator.ts` for the trade-off this implies: `instruction` now holds a whole
  program, not one line).
- **No top-level `try/catch`.** The two modeled failure modes (`CfgError`, `EmitError`)
  are the only "your input was invalid" paths. An unexpected exception — concretely,
  `liveness.ts`'s defensive iteration-bound guard — signals an internal-invariant
  violation in *our own* code, not a user-input problem, and must propagate rather than
  be laundered into an indistinguishable `TranslationError`.

## 3. The Deterministic Verification Floor (`src/FloorEngine.ts`)

Built immediately after SPEC-013, before SPEC-014. Lives under `src/`, not `lib/` — the
one deliberate departure from this project's otherwise consistent `lib/`-only layout,
per explicit instruction when it was commissioned. Verifies the pipeline from three
independent angles; none of the three gates re-implements or duplicates what another
gate checks.

### 3.1 Gate 1 — Static (`ts-morph`)

**`runStaticGate(): GateResult`** loads `lib/**/*.ts` in-memory against the real
`tsconfig.json` and checks:
- zero pre-emit compile diagnostics,
- `translateX86ToArm64` is exported from `lib/index.ts` with the exact signature
  `(source: string): TranslationResult`,
- zero explicit `any` usages anywhere in `lib/`'s AST.

This turns two things `CLAUDE.md` already mandates in prose (strict typing, a stable
public API) into an enforced, machine-checked gate — distinct from running `tsc
--noEmit` at the shell, in that it's callable in-process and asserts *structural*
properties, not just "does it compile."

### 3.2 Gate 2 — Fuzzing (`fast-check`, 1000 runs)

**`runFuzzGate(numRuns = 1000): GateResult`** generates randomized x86 programs
(labels, jumps, branches, calls, `RET`, register and SIB operands, blank lines,
garbage tokens) and checks three invariants on `translateX86ToArm64`'s *actual*
output:
1. **Determinism** — the same source translated twice yields byte-identical results.
2. **Register-token validity** — every register token in a successful translation is
   one of the eight ARM64 registers this system ever emits (`X0,X1,X2,X3,X4,X9,SP,FP`).
3. **Label-reference integrity** — every `B`/`BL`/`B.cond` target that names a label
   (not a register, e.g. distinguishing `BL foo` from `BLR X2`) has a matching
   `label:` definition line somewhere in the same emitted program.

### 3.3 Gate 3 — Symbolic (`z3-solver`)

**`runSymbolicGate(): Promise<GateResult>`** proves, via the Z3 SMT solver, that the
*real* emitted ARM64 for a set of `MOV`/`ADD`/`CMP` register-register cases is
register-file-equivalent to its x86 source **for all possible 64-bit values** — not
just the example inputs a unit test would use. Mechanism: both sides are encoded as
symbolic bitvector transformations over an aliased register file (ARM64 registers are
literally the same Z3 constants as their mapped x86 counterparts, not fresh free
variables), and the negated equivalence formula is checked `unsat` (no counterexample
exists ⇒ proven equal).

Explicitly scoped to value-transfer semantics only: no memory/SIB addressing, no
`PUSH`/`POP`/`CALL` stack effects, no flags modeling. Extending this to those would
require a real memory/stack model — a materially larger, separate undertaking. This
gate was verified non-theater before being built into the codebase: a deliberately
broken translation (swapped operand order) was smoke-tested first and correctly
produced `sat` (a counterexample), confirming the gate can actually fail, not just
always report success.

### 3.4 Orchestration

**`runFloorEngine(): Promise<FloorEngineReport>`** runs all three gates and returns
`{ ok: boolean, gates: GateResult[] }`, `ok` being the conjunction of all three.

## 4. Public API Entrypoints

| Function | Module | Signature |
|---|---|---|
| `translateX86ToArm64` | `lib/index.ts` | `(source: string) => TranslationResult` |
| `translateInstruction` | `lib/translator.ts` | `(input: string) => TranslationResult` |
| `buildControlFlowGraph` | `lib/cfg.ts` | `(source: string) => CfgResult` |
| `analyzeLiveness` | `lib/liveness.ts` | `(cfg: CfgSuccess) => LivenessResult` |
| `emitArm64` | `lib/emitter.ts` | `(cfg: CfgSuccess, liveness: LivenessResult) => EmitterResult` |
| `runFloorEngine` | `src/FloorEngine.ts` | `() => Promise<FloorEngineReport>` |
| `runStaticGate` / `runFuzzGate` / `runSymbolicGate` | `src/FloorEngine.ts` | see §3 |

For translating x86 source end to end, `translateX86ToArm64` is the only function most
callers need — everything else is exposed for callers who need a lower-level stage
(e.g. a tool that wants the CFG structure itself, not just the final ARM64 text).

## 5. Running the Test Suite

```
npm test                              # full suite (vitest run)
npm test -- path/to/file.test.ts      # a single file, e.g. npm test -- lib/cfg.test.ts
npx tsc --noEmit                      # type-check only, no test execution
```

As of this document, the full suite is **148 tests across 9 files**, all passing:
`lib/translator.test.ts` (83), `lib/cfg.test.ts` (13), `lib/cfg.invariants.test.ts` (6,
fast-check), `lib/liveness.test.ts` (10), `lib/emitter.test.ts` (9), `lib/index.test.ts`
(8), `lib/healer.test.ts` (14, unrelated module), `sum.test.ts` (1),
`src/FloorEngine.test.ts` (4). Typical full-suite runtime is well under a second except
for `src/FloorEngine.test.ts`, which takes ~3.5s — Z3's WASM module takes ~200ms to
initialize and Gate 2's 1000 fuzz iterations plus Gate 1's in-memory `ts-morph` project
load account for the rest. Nothing here is flaky; the runtime is simply real work, not
overhead.

Neither `tsconfig.json` nor vitest needed any configuration change to pick up `src/` —
both default to including every `.ts`/`.test.ts` file in the project.

## 6. Spec & Commit Lineage

Formal `SPEC-NNN` numbering in commit messages begins at SPEC-006; earlier
foundational work predates that convention and is listed by what it added instead.

| Spec | What it added | Commit |
|---|---|---|
| — | Base parser: register-register `MOV`/`ADD` | `eb084e5` |
| — | Indirect memory store (`STR`) | `2062b72` |
| — | Stack `PUSH`/`POP` (pre/post-indexed `SP`) | `4ac9c19` |
| — | `CALL` → `BL`/`BLR` | `3a8e8d4` |
| — | Fix: `RDI`/`RAX` register aliasing | `8ebdb23` |
| SPEC-006 | Lazy EFLAGS: `CMP`/`JE`/`JNE` → native `CMP`/`B.cond` | `fe5fd23` |
| SPEC-007 | Signed `Jcc` family: `JG`/`JL`/`JGE`/`JLE` | `3bf3c82` |
| SPEC-008 | SIB memory operands (`base+index*scale[+disp]`) | `e67f64d` |
| SPEC-009 / SPEC-010 | Basic blocks, CFG, fast-check structural invariants | `319dc1e` |
| SPEC-011 | Register liveness analysis (`liveIn`/`liveOut`) | `7dbf8b3` |
| SPEC-012 | ARM64 code generation emitter + AAPCS64 spill/reload | `e57b3f3` |
| SPEC-013 | End-to-end pipeline entrypoint `translateX86ToArm64` | `c33afb2` |
| — | Deterministic Verification Floor (`src/FloorEngine.ts`) | `982e180` |
| SPEC-014 | This document | *(pending commit)* |
