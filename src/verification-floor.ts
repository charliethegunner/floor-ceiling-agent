// Generic plugin contract for a "verification floor" - a named, pluggable
// set of gates that check a candidate output against domain-specific ground
// truth. lib/index.ts's ARM64 translation pipeline is the first fully
// implemented domain (src/FloorEngine.ts for whole-program checks,
// src/CeilingAgent.ts's per-instruction gates for LLM candidates). This file
// exists so future domains can conform to the SAME orchestration contract
// CeilingAgent's self-healing retry loop already drives, without
// CeilingAgent needing to know anything domain-specific about them.
//
// GateName is a second generic parameter (not just `string`) so a concrete
// floor - e.g. the ARM64 instruction floor's 'static' | 'fuzz' | 'symbolic'
// - keeps its exact literal gate-name union through runVerificationFloor,
// rather than every caller needing an `as` cast back to it.

export interface GateOutcome<GateName extends string = string> {
  gate: GateName
  ok: boolean
  details: string
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

export async function runVerificationFloor<Candidate, GateName extends string = string>(
  floor: VerificationFloor<Candidate, GateName>,
  candidate: Candidate,
  /** Optional, backward-compatible hook: called after each individual gate
   *  resolves, with its outcome and real measured latency - lets a caller
   *  (e.g. Phase 11.1's EngineTracer) record genuine per-gate timing without
   *  every floor/candidate type needing to know about tracing itself. */
  onGateComplete?: (gate: GateOutcome<GateName>, elapsedMs: number) => void
): Promise<FloorReport<GateName>> {
  const gates: GateOutcome<GateName>[] = []
  for (const gate of floor.gates) {
    const start = Date.now()
    const outcome = await gate.check(candidate)
    onGateComplete?.(outcome, Date.now() - start)
    gates.push(outcome)
  }
  return { ok: gates.every((g) => g.ok), domain: floor.domain, gates }
}

// Both placeholders that used to live here are gone: the Topology Engine's
// (Phase 4.1, src/topology-floor.ts) and the Claim Verification Engine's
// (Phase 4.2, src/claim-floor.ts) are both implemented for real now, so a
// vague stub alongside a concrete floor would just be dead weight. This
// file stays purely generic - the plugin contract every floor implements,
// not a registry of the floors themselves.
