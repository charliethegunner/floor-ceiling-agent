# Master System Architecture: 5-Layer Governed Neuro-Symbolic Engine

## Core Philosophy
We substitute probabilistic AI self-reflection with deterministic mathematical proofs. The system enforces a strict Floor-to-Ceiling design where an LLM (Ceiling) generates candidates that are verified by deterministic mathematical solvers, graph AST invariants, and empirical execution gates (Floor).

---

## The 5-Layer Peak Architecture Target

┌─────────────────────────────────────────────────────────────┐
│  LAYER 5: THE GOVERNING META-KERNEL (Dynamic Equilibrium)   │
│  • Curriculum Gating (Prevents Task Asymmetry)              │
│  • TTL Rule Garbage Collection (Prevents AST Rule Collision) │
│  • Strict 200ms Execution Caps (Prevents SMT Timeouts)      │
└──────────────────────────────┬──────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 4: THREE CO-EVOLVING AUTONOMOUS ENGINES              │
│  1. Meta-Evolver (Optimizes Prompts & Reasoning Paths)       │
│  2. Reverse SMT Task Generator (Synthesizes Edge Cases)     │
│  3. AST Micro-Fix Floor (Executes 0ms Deterministic Repairs)│
└──────────────────────────────┬──────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 3: ZERO-SYNTAX & PARALLEL SAMPLING (Enterprise)      │
│  • Grammar-Constrained Logit Decoding (0% Parse Drops)     │
│  • Parallel Best-of-N Floor Verification                    │
└──────────────────────────────┬──────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: CLOSED-LOOP SYMBOLIC HEALING                      │
│  • Injects Z3 Minimal Unsat Cores & Runtime Stack Traces    │
│  • Drives Attempt-2 Candidate Convergence to >95%           │
└──────────────────────────────┬──────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: DETERMINISTIC MATHEMATICAL FLOOR (100% Safety)    │
│  • Z3 SMT Solver • Graph AST Invariants • Empirical Gates   │
└──────────────────────────────┴──────────────────────────────┘


---

## Architectural Guarantees

1. **Absolute Mathematical Safety (100% Catch Rate):** No unverified code, broken graph topology, or illegal ISA instruction can ever pass the Floor gates.
2. **Sub-Millisecond Repair Latency:** Known structural errors are patched deterministically at the AST layer in 0ms without invoking an LLM retry.
3. **Self-Sustaining Evolution without Decay:** The Layer 5 Governing Meta-Kernel cleans up obsolete AST rules via TTL garbage collection, gates synthetic task difficulty to prevent Z3 solver deadlocks, and enforces strict 200ms verification execution bounds.

---

## Sequential Implementation Roadmap

| Phase | Core Objectives | Status |
| :--- | :--- | :--- |
| **Phase 5** | Multi-Domain Verification Routing (`isa`, `topology`, `claim`) with 277 passing tests. | **COMPLETED** (`c6e2e26`) |
| **Phase 5.1** | Regex pre-sanitizer for markdown fences + rich empirical execution stack trace feedback. | **IN PROGRESS** |
| **Phase 6** | Best-of-N parallel candidate sampling & background auto-evolver (`scripts/auto-evolver.ts`). | **SCHEDULED** |
| **Phase 7** | Governing Meta-Kernel (TTL AST rule garbage collection, curriculum gating, 200ms bounds). | **TARGET STATE** |
