# SPEC-014: System Architecture & Verification Floor Reference

This document is SPEC-014 in this project's spec lineage. Unlike SPEC-006 through
SPEC-013, it doesn't introduce new code via a RED/GREEN TDD cycle — it's a reference
describing the system as it exists after SPEC-013 (the end-to-end pipeline) and the
Deterministic Verification Floor built immediately after it. Keep it up to date when
the architecture changes; treat a stale section here as a bug.

**Document scope (Phase 22.0 note):** §§1-6 below describe the original system as of
SPEC-014 and remain accurate for what they cover — the deterministic x86-64→ARM64
translator (§2) and `FloorEngine.ts`'s whole-pipeline verification (§3). A second,
additive system was built starting at Phase 4 — an LLM-verified, multi-domain
candidate-generation engine (`CeilingAgent`, five verification floors, dynamic DAG
execution, worker pools, meta-kernel rule learning) that shares no code with §§2-3 and
is documented in §7 onward. §1's "Overview" below is updated to name both; everywhere
else, §§1-6 are left as they were.

## 1. Overview

This project contains two systems that share no code:

1. A stateless x86-64 → ARM64 **instruction-string translator** (§2-§3 below). It does
   not execute, JIT, or assemble to machine code — every layer operates on and produces
   plain text.
2. An **LLM-verified, multi-domain candidate-generation engine** (§7 onward, Phase 4
   onward) — the "Ceiling/Floor" system: an LLM (Ceiling) proposes a candidate in one of
   five domains (ARM64 instructions, TypeScript module topology, empirical claims, SDF
   spatial surfaces, B-Rep CAD solids), a deterministic verification floor built on Z3,
   ts-morph, and OpenCASCADE WASM (never the LLM itself) checks it, and a self-healing
   retry loop feeds real counterexamples back to the LLM until it passes or retries are
   exhausted. `instruction-floor.ts` (part of system 2) reuses system 1's ground-truth
   equivalence checks for a few opcode shapes, but otherwise the two systems are
   independent — system 1 never calls an LLM, and system 2's `instruction` domain
   doesn't go through system 1's `lib/` pipeline at all.

§2-§6 describe system 1 (the translator). §7-§10 describe system 2. The translator
pipeline:

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

As of SPEC-014, this file set was the full suite: **148 tests across 9 files** —
`lib/translator.test.ts` (83), `lib/cfg.test.ts` (13), `lib/cfg.invariants.test.ts` (6,
fast-check), `lib/liveness.test.ts` (10), `lib/emitter.test.ts` (9), `lib/index.test.ts`
(8), `lib/healer.test.ts` (14, unrelated module), `sum.test.ts` (1),
`src/FloorEngine.test.ts` (4) — and that breakdown is still accurate for what these 9
files themselves contain. Typical runtime for just this subset is well under a second
except for `src/FloorEngine.test.ts`, which takes ~3.5s — Z3's WASM module takes ~200ms
to initialize and Gate 2's 1000 fuzz iterations plus Gate 1's in-memory `ts-morph`
project load account for the rest. Nothing here is flaky; the runtime is simply real
work, not overhead.

`npm test` today runs the WHOLE repo, not just this subset — system 2 (§7 onward) added
26 more test files. See §9 for the current full-suite count and how system 2's
standalone (non-`npm test`) diagnostic scripts are run.

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
| SPEC-014 | This document (originally) | `982e180`..HEAD, see §10 for its Phase 22.0 extension |

---

# System 2: The LLM-Verified Multi-Domain Engine

Everything from here on documents the second system named in §1 — built starting at
Phase 4, sharing no code with §2-§3's translator (`instruction-floor.ts` is the one
exception: it reuses a few of `FloorEngine.ts`'s ground-truth equivalence checks as
Z3 oracles, never `lib/`'s translation pipeline itself). "Ceiling" is the LLM proposing
a candidate; "Floor" is the deterministic verification that candidate must pass,
independent of the LLM, before it's accepted.

## 7. Core Architecture

### 7.1 The Generic Verification-Floor Contract (`src/verification-floor.ts`)

```ts
export interface GateOutcome<GateName extends string = string> {
  gate: GateName
  ok: boolean
  details: string
  structured?: StructuredDiagnostic
}
export interface VerificationGate<Candidate, GateName extends string = string> {
  name: GateName
  check(candidate: Candidate): Promise<GateOutcome<GateName>> | GateOutcome<GateName>
}
export interface VerificationFloor<Candidate, GateName extends string = string> {
  domain: string
  gates: ReadonlyArray<VerificationGate<Candidate, GateName>>
}
export interface FloorReport<GateName extends string = string> {
  ok: boolean
  domain: string
  gates: GateOutcome<GateName>[]
}
```

`runVerificationFloor(floor, candidate, onGateComplete?)` runs **every** gate
unconditionally — no short-circuit on the first failure — and returns
`ok: gates.every(g => g.ok)`. `onGateComplete(gate, elapsedMs)` fires once per gate with
its real measured latency; this single hook is the source of every per-gate timing
number anywhere in this codebase (`WorkerGateOutcome.elapsedMs` in §7.5,
`EngineTracer`'s `floor_gate:*` spans in §7.7, and `scripts/load-test-engine.ts`'s
per-gate breakdown in §9).

**Adding a new domain** means writing a candidate type, an ordered array of
`VerificationGate<Candidate, GateName>`, and nothing else — `runVerificationFloor`,
`CeilingAgent`'s retry loop, and `TaskGraphExecutor` all drive any floor identically,
with no domain-specific code of their own.

**`StructuredDiagnostic`** (Phase 19.0, defined in the same file) is an optional,
additive companion to `details` — populated only where a gate already computes real
structured data internally, never fabricated for a gate that doesn't have it:

```ts
export interface SymbolicCounterexample { kind: 'symbolic-counterexample'; assignments: { variable: string; value: string }[] }
export interface DiagnosticPositions   { kind: 'diagnostic-positions';   diagnostics: { code: number; message: string; line: number | undefined }[] }
export interface SubShapeFaults        { kind: 'subshape-faults';       faults: { shapeKind: 'face' | 'edge'; index: number; status: string }[] }
export type StructuredDiagnostic = SymbolicCounterexample | DiagnosticPositions | SubShapeFaults
```

| Variant | Populated by | How |
|---|---|---|
| `SymbolicCounterexample` | `instruction-floor.ts`'s `symbolic` gate, on a Z3 SAT (disproved) result | one `{variable, value}` per declaration in the Z3 model |
| `DiagnosticPositions` | `CeilingAgent.ts`'s `patch`-mode `static` gate, on ts-morph compile diagnostics | `{code, message, line}` per diagnostic |
| `SubShapeFaults` | `brep-floor.ts`'s `structural-validity` gate, when `BRepCheck_Analyzer.IsValid_2()` is false | walks unique faces/edges via `analyzer.Result(subShape).get().Status()`, one `{shapeKind, index, status}` per faulted sub-shape |

`details` (prose) always flows into the retry prompt regardless; `structured`, when
present, is rendered as one additional line by `buildPrompt` — see §7.3.

### 7.2 The Five Concrete Domain Floors

| `CeilingRequestKind` | Floor const | File | Gates, in order |
|---|---|---|---|
| `instruction` | `ARM64_INSTRUCTION_FLOOR` | `src/instruction-floor.ts` | `static` (conditional-branch dot-notation) → `fuzz` (register-token validity) → `symbolic` (Z3 register-transfer equivalence; PUSH/POP/SIB-MOV cases delegate to `FloorEngine.ts`'s ground-truth checks) |
| `topology` | `TOPOLOGY_FLOOR` | `src/topology-floor.ts` | `exports` → `types` (0 `any`, explicit return types) → `reachability` (BFS over a ts-morph-built call graph) |
| `claim` | `CLAIM_VERIFICATION_FLOOR` | `src/claim-floor.ts` | `structural` → `cross-reference` (ts-morph: the symbol is really exported) → `empirical` (dynamic `import()`, real call, `deepStrictEqual` against the claimed result) |
| `spatial` | `SPATIAL_VERIFICATION_FLOOR` | `src/spatial-floor.ts` | `continuity` (finite-difference Lipschitz-bound check) → `volumetric-bound` (exact analytic extent vs. declared box) → `self-intersection` (closed-form degeneracy/singularity checks) |
| `brep` | `BREP_VERIFICATION_FLOOR` | `src/layer1/brep/brep-floor.ts` | `structural-validity` (`BRepCheck_Analyzer`) → `volumetric-bound` (`BRepBndLib`, ±1e-4 tolerance) → `step-export` (only when `exportStep: true`; a passing `details` is the real STEP text itself) |

A sixth kind, `patch`, is verified inline in `CeilingAgent.ts` (`verifyPatchCandidate`)
rather than as a separate floor file — same `static`/`fuzz`/`symbolic` gate names as
`instruction`, but `fuzz`/`symbolic` are `ok:true, "not applicable"` placeholders:
executing arbitrary LLM-generated code is a real security boundary this project doesn't
cross.

### 7.3 CeilingAgent: Retry Loop & Structured Diagnostic Feedback (`src/CeilingAgent.ts`)

```ts
export interface GateCheckResult { gate: string; ok: boolean; details: string; structured?: StructuredDiagnostic }
export interface CeilingAttempt  { attempt: number; candidate: string; failedGate: GateCheckResult }
export interface CeilingSuccess  {
  ok: true; result: string; attempts: number
  gates: GateCheckResult[]; history: CeilingAttempt[]
  formatted?: FormattedEngineResponse
}
```

`runCeilingAgent(request, llm, options)` retries up to `options.maxRetries` (default
5). Each attempt tries, in order: (1) `tryMetaKernelBypass` if a `metaKernel` is
supplied and `history` is non-empty (§7.6), (2) `runBestOfNRound` if `bestOfN` is
supplied (§7.6), (3) `runSingleCandidateRound` (one plain LLM call). On failure,
`{attempt, candidate, failedGate}` is pushed onto `history`, and the next attempt's
prompt is rebuilt by `buildPrompt(request, history)`:

```
Attempt N was rejected - gate "X".
Counterexample/details: <details>
Structured: <describeStructured(structured)>      ← only emitted when structured is present
Rejected candidate:
<candidate>
```

`describeStructured` renders each `StructuredDiagnostic` variant as one line
(`"var=value, ..."` / `"line N: TSCODE message; ..."` / `"face[0]: STATUS, ..."`).
After `maxRetries`, `runCeilingAgent` throws `CeilingAgentExhaustedError`, carrying the
full `history`.

**Phase 17.0 duplicate-candidate short-circuit**: in the sequential (non-Best-of-N)
path, `findDuplicateAttempt` checks a new candidate against every prior `history` entry
by byte-identical string match. A repeat is short-circuited with a synthetic
`duplicate-candidate` gate (echoing the ORIGINAL rejection's `details` verbatim)
without re-running the real floor at all — a deterministic gate fails the same
byte-identical input the same way again, so re-verifying is pure waste. The LLM is
still called every attempt; only the redundant verification work is skipped.

### 7.4 Dynamic DAG Execution: `TaskGraphExecutor` (`src/layer0/task-graph.ts`)

```ts
export interface TaskNode {
  id: string
  kind: CeilingRequestKind
  description: string | ((upstream: ReadonlyMap<string, CeilingSuccess>) => string)
  dependsOn?: string[]
  maxRetries?: number
  bestOfN?: BestOfNOptions
}
export interface TaskGraphExecutorOptions {
  llm: LlmClient
  onNodeSettled?: (result: TaskNodeResult, completed: ReadonlyMap<string, CeilingSuccess>) => void | Promise<void>
  metaKernel?: MetaKernelCompiler
  formatResponse?: boolean
  peerReview?: boolean
  brepPool?: BRepWorkerPoolEvaluator   // required if the graph has any 'brep' node
}
export type TaskNodeResult =
  | { id: string; status: 'ok'; success: CeilingSuccess; review?: PeerReviewResult }
  | { id: string; status: 'failed'; error: string; review?: PeerReviewResult }
  | { id: string; status: 'skipped' }   // a declared dependency failed or was itself skipped
```

**Structure is caller-supplied and fully deterministic** — `topologicalSort` is a pure,
synchronous DFS with no LLM call anywhere in it (the file's own header comment is
explicit: this is deliberately NOT autonomous HTN-style planning). It throws a plain
`Error` for an unknown `dependsOn` id, or, on a genuine DFS revisit-while-visiting,
`"task graph has a cycle involving ..."`.

**`run()`** — only one run may be active per executor instance (a second concurrent
`run()` throws). `requireBRepPoolIfNeeded` fails closed, before any LLM call at all, if
the graph has a `brep` node and no `brepPool`. The main loop repeatedly computes the
`ready` set (every node whose declared dependencies have all resolved, ok or not) and
dispatches it via `Promise.all` — genuine concurrent execution within a batch.
`onNodeSettled` fires once per node, sequentially within a batch, specifically so two
callbacks in the same batch never race to mutate shared state. The final
`TaskGraphResult.ok` is the conjunction of every node's status — a real failure
anywhere makes the whole result `false`, even if a caller-injected resolver later fixed
it.

**`injectNodes(newNodes, dependencies?)`** (Phase 18.0) is caller-driven only — nothing
inside `task-graph.ts` itself ever calls it. Exact order:
1. Throws if no run is active.
2. No-ops on an empty array.
3. Throws on a duplicate node id.
4. Merges `dependencies` map entries **additively** onto each new node's own `dependsOn`.
5. Combines with the live `order` and re-runs `topologicalSort` — a genuine cycle is
   re-thrown as the exported `CycleDetectedError` (distinguished from an
   unknown-dependency `Error` by checking the message for the substring `"cycle"`).
6. Re-checks `requireBRepPoolIfNeeded` against the injected nodes specifically.
7. **Only then** commits, reassigning `order`/`byId`/`remaining`.

Every check runs before any mutation — a rejected injection leaves the live run's state
byte-for-byte untouched.

**Parent-state retention**: `completed: Map<string, CeilingSuccess>` (part of the
executor's private per-run state) is written once per node and never re-written. A
downstream node's failure, a downstream retry, or a later `injectNodes()` call never
re-verifies or re-generates an already-completed node. Every "verified parents stay
cached" claim elsewhere in this codebase (Phase 17.0/18.0/20.0) is proven this way, via
a direct real LLM-call-count assertion, not a reading of this code.

`brep` nodes bypass `runCeilingAgent` entirely: `runBRepNode` is a self-contained
mirror of the same retry loop (reusing the SAME `buildPrompt`/`stripJsonFences`
helpers, imported directly from `CeilingAgent.ts`) that dispatches through
`BRepWorkerPoolEvaluator.verify()` instead, since a B-Rep candidate is structured data,
not free text, and always needs worker isolation (§7.5).

### 7.5 Worker-Pool Lifecycle & OpenCASCADE WASM Memory Management

Two structurally similar but independent worker pools exist — not a shared base class,
because `'brep'` was never added to the general pool's closed `WorkerDomain` union
(`'instruction' | 'topology' | 'claim' | 'spatial'`):

| | `WorkerPoolEvaluator` (`src/layer1/worker-pool.ts`) | `BRepWorkerPoolEvaluator` (`src/layer1/brep/brep-worker-pool.ts`) |
|---|---|---|
| Handles | instruction / topology / claim / spatial | brep only |
| Default pool size | `os.cpus().length - 1` | **1** — a single OpenCASCADE-loaded worker costs ~450-500MB RSS at rest (spike-measured) |
| Default RSS recycle threshold | 512MB — a cold worker already measures ~258MB (Z3 + ts-morph eagerly loaded regardless of task domain); 10 mixed tasks on one worker climbed to ~475MB | 900MB — OpenCASCADE's own steady-state RSS (~470-500MB) measured flat across 200 real build+check cycles |
| Recycling trigger | after every task, if the reporting worker's `process.memoryUsage.rss()` exceeds the threshold: `slot.worker.terminate()` (fire-and-forget) then respawn at the same slot index, `recycledWorkerCount++` | identical mechanism |
| `verify(task, fallback)` contract | any infra problem (dead pool/worker, timeout, thrown error) resolves to `fallback()`, **never** a rejection — "a pool problem degrades to no isolation for this candidate, never a silently-failed candidate" | identical fail-open contract |

Both satisfy the same minimal contract (`src/layer1/worker-pool-like.ts`):

```ts
export interface WorkerPoolLike {
  verify(task: WorkerVerifyTask, fallback: () => Promise<WorkerGateOutcome[]>): Promise<WorkerGateOutcome[]>
  shutdown(): Promise<void>
}
```

— the reason `layer3/sampler.ts`'s `WorkerOffload` and `CeilingAgent.ts`'s
`BestOfNOptions.workerPool` never need to know which concrete pool they're holding (a
third implementation, `DistributedWorkerPoolEvaluator`, also satisfies it — §7.8).

**Documented caveat, not a bug**: `worker_threads` are real OS threads sharing ONE
process's address space (unlike `child_process`), so `process.memoryUsage().rss()` is a
PROCESS-WIDE reading, not one worker's exclusive share. Recycling still does something
real — it discards the reporting worker's own V8 isolate/module state — but this is not
true per-thread memory isolation, and the source says so directly rather than
presenting it as one.

```ts
export interface WorkerGateOutcome {
  gate: string
  ok: boolean
  details: string
  /** Real per-gate latency, measured INSIDE the worker via runVerificationFloor's
   *  onGateComplete hook - optional only because a caller-supplied fallback may not
   *  have per-gate timing of its own. */
  elapsedMs?: number
}
```

**OpenCASCADE WASM object lifecycle** (`src/layer1/brep/brep-floor.ts`): every
OCCT-bound class implements `OcDisposable = { delete?: () => void }`
(`src/layer1/brep/oc-types.ts`). Two small helpers are the ENTIRE leak-prevention
mechanism:

```ts
function track<T extends OcDisposable>(disposables: OcDisposable[], value: T): T {
  disposables.push(value)
  return value
}
function disposeAll(disposables: OcDisposable[]): void {
  for (let i = disposables.length - 1; i >= 0; i--) disposables[i].delete?.()
}
```

Every gate function (`checkStructuralValidity`, `checkVolumetricBound`,
`checkStepExport`) builds its OWN fresh shape from a local
`disposables: OcDisposable[]` array — threaded through `buildShape` and every
`track(disposables, new oc.SomeType(...))` call — and disposes it in a `finally` block,
in REVERSE construction order, guaranteeing cleanup even on a thrown native exception.
Shapes are never shared or cached across gates — deliberately, after a spike found that
reusing one shape handle across two boolean operations produced a suspect result.

`loadOpenCascade()` (`src/layer1/brep/oc-loader.ts`) is a module-scope-memoized
singleton — one WASM init per worker lifetime (~600ms cold-init, paid once), never once
per task.

### 7.6 Parallel Sampling (Best-of-N) & the Meta-Kernel Zero-Latency Bypass

`ParallelCandidateSampler` (`src/layer3/sampler.ts`) runs `sampleSize` (default 4 via
`runCeilingAgent`) independent LLM completions at stepped/fixed/random temperatures
(`temperatureStrategy`), racing them with real early-exit — the first candidate whose
real floor result is `ok:true` wins; still-pending candidates are discarded, never
awaited to completion — when `earlyExitOnSuccess` is set. Each candidate scores
`passRatio - elapsedMs / 1_000_000`, so a passing candidate always outranks a failing
one, ties broken by speed. An optional `workerOffload: { pool, toTask }` routes each
candidate's verification through a `WorkerPoolLike` pool instead of in-process
`runVerificationFloor`.

`MetaKernelCompiler` (`src/layer5/meta-kernel.ts`) — "zero-latency" is literal:
`tryMetaKernelBypass` runs BEFORE any LLM call on a retry attempt. It classifies the
last failure (`classifyFailurePattern`, matching one of 4 known regex shapes or an
exact-text fallback), looks up a learned rule for that pattern, and if one matches,
derives and applies a patch (`derivePatch` — real structural fixes, e.g.
`topology-add-export`'s genuine ts-morph `fn.setIsExported(true)` mutation, or a
byte-identical `exact-replacement` replay). The patched candidate is re-verified
through the SAME real floor before being accepted — a matched rule that still produces
a failing candidate just falls through to a normal LLM round, never a false success. A
rule is learned (`recordFix`) after any successful round that followed ≥1 real failure;
the rule set is capped (`maxRules`, default 1000) with LRU + lowest-confidence
eviction, optionally persisted to a flat JSON file.

### 7.7 Telemetry & Output Formatting

`EngineTracer` (`src/telemetry/tracer.ts`) is a genuine OTLP-JSON-shaped tracer built
on Node builtins only (real hex trace/span IDs via `node:crypto`, zero
`@opentelemetry/*` dependency). One instance = one trace = one `runCeilingAgent` call.
`recordFloorGate(gate, ok, elapsedMs, details?)` creates a real child span
`floor_gate:${gate}` carrying a `latency_ms` attribute — the exact attribute
`scripts/load-test-engine.ts` (§9) reads back to cross-check recorded span latency
against independently measured wall-clock time.

`formatEngineResponse` (`src/telemetry/output-formatter.ts`) produces
`FormattedEngineResponse { summary, structuralDiff, verificationTraces, telemetry }`.
`summary.resolvedLayer` (`'layer5-meta-kernel' | 'layer3-sampler' | 'layer4-healing' |
'layer1-floor'`) is always caller-supplied from `runCeilingAgent`'s own control flow —
never reconstructed from the trace, since that would be genuinely ambiguous (a
meta-kernel check can fire-and-miss across multiple rounds). `structuralDiff` is a real
LCS-based unified diff (no external diff library). Three renderers (`toAnsiText` /
`toMarkdown` / `toJson`) all consume the same computed object, never re-deriving it.

### 7.8 Supporting Infrastructure

- **`src/layer0/intent-router.ts`** (Phase 13.4) — classifies open-ended free-text
  input into a well-formed `CeilingRequest` before `runCeilingAgent` is ever called.
  Two independent signals (a pure heuristic scorer + an LLM classification call) must
  agree — or the heuristic must be ambiguous AND the LLM highly confident — before it
  proceeds automatically; otherwise it returns a single clarifying question rather than
  guessing.
- **`src/layer0/peer-review.ts`** (Phase 14.5.3) — optional (`peerReview: true`)
  multi-agent review of an already-verified result. QA and Security are real,
  deterministic, empirically-grounded checks (e.g. an empirical re-check for
  claim-stability) that CAN demote an `'ok'` node to `'failed'`; Architect is
  LLM-generated commentary with no `ok` field at all — structurally incapable of
  failing anything, by design.
- **`src/layer1/action-floor.ts`** (Phase 11.7) — the only module permitted to mutate
  the filesystem or spawn subprocesses on behalf of a verified candidate, and only when
  `FormattedEngineResponse.summary.outcome === 'PASS'`. Four modes of increasing
  autonomy (`dry-run` → `interactive` → `auto` → `auto-commit`), every write
  path-traversal-guarded to stay inside `targetWorkspace`.
- **`src/layer1/sandbox-runner.ts`** — executes the closed ARM64 register-transfer
  subset `instruction-floor.ts`'s Z3 gate models, via a fresh `worker_threads.Worker`
  per execution (never pooled/reused) running a hand-written interpreter, with real V8
  heap ceilings and a hard termination deadline that kills even a synchronous infinite
  loop.
- **`src/layer1/ingestion-floor.ts`** — `ProjectPackIngestor` parses a real
  directory/ZIP/single file into a `ProjectWorkspaceGraph`, extracting dependency edges
  via a real ts-morph AST import/export walk (never regex-guessed), with memory/
  zip-bomb limits enforced before bytes are held.
- **`src/layer1/distributed/`** (Phase 14.0) — `DistributedWorkerPoolEvaluator`
  satisfies the same `WorkerPoolLike` contract as `WorkerPoolEvaluator` over a real
  gRPC transport; `solver-node.ts` is a remote worker process that reuses
  `worker-pool-worker.ts`'s own `verify()` function directly (imported as a plain
  function, never as a `worker_threads` entry point).

## 8. Architecture & Roadmap Alignment

`ROADMAP.md` (this repo's original "Master Neuro-Symbolic Evolution Plan") describes an
idealized 5-layer system: Layer 5 (Meta-Kernel), Layer 4 ("Co-Evolving Mutation
Engines" — a Meta-Evolver and Synthetic Task Generator), Layer 3 (Parallel Sampling &
Router), Layer 2 ("Closed-Loop Symbolic Healer"), and Layer 1 (a multi-engine floor
spanning Z3, Lean 4, Coq, SymPy, JAX, and CUDA across software/math/physics/perception
domains), plus a hard `DOMAIN_LATENCY_BOUNDS` table of per-domain latency ceilings.

The real `src/` layout is `layer0`, `layer1`, `layer3`, `layer5` — **`layer2` and
`layer4` were never built, deliberately, not by oversight**:

- What `ROADMAP.md` called "Layer 2: Closed-Loop Symbolic Healer" is, in reality, just
  `CeilingAgent.ts`'s existing retry loop plus `StructuredDiagnostic` (§7.1/§7.3) — real
  gate feedback (a Z3 counterexample, a ts-morph diagnostic, a B-Rep fault) already
  flows back into the next prompt. There was never a second, separate "healer"
  subsystem to build.
- "Layer 4: Co-Evolving Mutation Engines" (a Meta-Evolver that mutates prompts, a
  Synthetic Task Generator) has no real counterpart anywhere in this codebase.
  `layer5/meta-kernel.ts`'s rule learning (§7.6) is deterministic pattern-matched patch
  replay, not prompt mutation or synthetic task generation.
- The Lean 4 / Coq / SymPy / JAX / CUDA floors, and the "Physics" / "Creative &
  Narrative" / "Multi-Modal Perception" / "Continuous Simulations" domain rows in
  `ROADMAP.md`'s matrix, have no implementation anywhere in this project. The five REAL
  domains are `instruction`, `topology`, `claim`, `spatial`, and `brep` (§7.2), backed
  by exactly three real verification engines: Z3, ts-morph, and OpenCASCADE WASM.
- `DOMAIN_LATENCY_BOUNDS`'s hard per-domain latency ceilings were never implemented as
  assertions anywhere. Every benchmark/load-test artifact in this codebase
  (`scripts/load-test-engine.ts`, `src/integration/engine-integration.test.ts`)
  measures and reports real timing but never gates pass/fail on it — a hard wall-clock
  SLA on shared CI/dev hardware is a flakiness source, not a correctness signal, and
  this project has consistently declined to build one (see §9).

Where this document describes the real system (§7 above), it describes what is
actually built in `src/` today, verified directly against the current source — not
`ROADMAP.md`'s aspirational plan.

## 9. Running the Engine: Tests vs. Out-of-Band Diagnostics

```
npm test                              # full suite (vitest run) - fast, deterministic, no network calls
npm test -- path/to/file.test.ts      # a single file
npx tsc --noEmit                      # type-check only
npm run loadtest                      # scripts/load-test-engine.ts - standalone, NOT part of npm test
npm run benchmark                     # scripts/benchmark-live.ts - real network calls to a local Ollama endpoint, NOT part of npm test
npm run benchmark:sampler             # scripts/benchmark-sampler.ts - synthetic Best-of-N convergence measurement, NOT part of npm test
```

As of this document, the full suite is **750 tests across 35 files**, all passing,
entirely deterministic — every LLM call anywhere in `npm test` is a scripted fake; no
test in the suite makes a network call.

`npm run loadtest` drives real, higher-volume concurrent load across all 5
verification domains plus sandboxed execution, reporting (never asserting) real
memory-over-time RSS samples, worker-recycling counts, and a per-gate latency
breakdown built from the same `elapsedMs` telemetry described in §7.1/§7.5 (Phase
21.0). It is deliberately excluded from `npm test`: it's slow, it deliberately drives
two real WASM/worker pools past their recycling thresholds, and RSS growth under that
load is expected, not a bug — a hard "zero growth" or per-gate wall-clock assertion
here would just be a flaky CI failure waiting to happen on different hardware, not a
real regression signal. `npm run benchmark` is the one script in this project that DOES
make real network calls (to a local Ollama-compatible endpoint) — it measures real LLM
behavior, not synthetic behavior, and is excluded from `npm test` for that reason
alone.

## 10. Phase Commit Lineage (System 2)

A second commit-lineage convention runs alongside §6's `SPEC-NNN` numbering, covering
the LLM-verified multi-domain engine described in §7-§9. "Phase N.0" citations appear
directly in source comments (e.g. `task-graph.ts`'s Phase 14.5.1/17.0/18.0 comments)
and in commit messages from this point on:

| Phase | What it added | Commit |
|---|---|---|
| Phase 1 / 1b | Z3 Gate 3 extended to PUSH/POP/RSP tracking and SIB addressing | `ef9fd2e` / `7380fd2` |
| Phase 2b | `translate` CLI with CeilingAgent verification | `4b60d6f` |
| Phase 3 / 3.1 | Live multi-model benchmark; branch dot-notation + case-folding | `694f720` / `220e60b` |
| Phase 4 / 4.1 / 4.2 | Generic `VerificationFloor` contract + self-healing loop; Topology floor; Claim floor | `4504e8f` / `70d1d72` / `d7ae6c2` |
| Phase 5 / 5.1 | Dynamic multi-domain routing + CLI flags; fence sanitizer + empirical stack traces | `10e888b`, `c6e2e26` / `c2acac0` |
| — | Best-of-N `ParallelCandidateSampler` integration | `164d2ce` |
| — | `SPATIAL_VERIFICATION_FLOOR` (SDF/CSG surfaces) | `1d8af1a` |
| — | `WorkerPoolEvaluator` (multi-threaded verification) | `1e91d4c` |
| — | `MetaKernelCompiler` (zero-latency AST rule bypass) | `7f8ab16` |
| Phase 11.1-13.0 | Telemetry, sandboxed runner, and other enterprise-extension work | `54a9991` |
| Phase 12.1 | Isolated `SandboxRunner` floor | `8d61f1c` |
| Phase 13.4 | Intent classification & request normalization | `6b1f321`, `e698402` |
| Phase 14.0 | Distributed solver pipeline (gRPC) | `845e7ae` |
| Phase 14.5 | Task decomposition, meta-kernel reuse, peer review | `3c75ff6` |
| Phase 15.0 / 15.1 | OpenCASCADE WASM B-Rep kernel; `brep` as a first-class routable domain | `caa9801` / `19129ee` |
| — | Process-lifecycle hardening and thread supervision | `352bf0b` |
| Phase 16.1 | Advanced B-Rep CAD operations (fillet/chamfer/shell/draft) & STEP export | `e8b1458` |
| Phase 17.0 | Verified parent-state retention + duplicate-candidate short-circuiting | `d03b410` |
| Phase 18.0 | Caller-driven dynamic DAG node injection (`injectNodes`) | `3d56ae6` |
| Phase 19.0 | Structured diagnostic payloads (Z3, AST, B-Rep) | `132f1a8` |
| Phase 20.0 | Full-engine multi-domain integration & stress suite | `ea2c53b` |
| Phase 21.0 | Real-time multi-engine performance benchmarking | `dc9d4a5` |
| Phase 22.0 | This section (§1's dual-system framing, §7-§10) | *(pending commit)* |
