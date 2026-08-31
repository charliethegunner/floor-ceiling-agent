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
  candidate: Candidate
): Promise<FloorReport<GateName>> {
  const gates: GateOutcome<GateName>[] = []
  for (const gate of floor.gates) {
    gates.push(await gate.check(candidate))
  }
  return { ok: gates.every((g) => g.ok), domain: floor.domain, gates }
}

// ---------------------------------------------------------------------------
// Placeholder interface for a domain not yet implemented. Deliberately just
// a marker conforming to VerificationFloor<Candidate, GateName> - no domain
// logic is invented here, since this engine's actual verification semantics
// (what a "candidate" is, what its gates check) hasn't been specified yet.
// It becomes a real floor by supplying `gates` once that spec exists;
// nothing in CeilingAgent's orchestration loop needs to change when it does,
// since it already knows only the generic contract above.
//
// The Topology Engine's placeholder that used to live here is gone: Phase
// 4.1 (src/topology-floor.ts) implemented it for real, so a vague stub
// alongside a concrete floor would just be dead weight.
// ---------------------------------------------------------------------------

export interface ClaimVerificationCandidate {
  readonly domain: 'claim-verification'
  readonly data: unknown
}

export type ClaimVerificationFloor = VerificationFloor<ClaimVerificationCandidate>
