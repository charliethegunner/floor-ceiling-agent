// Test fixtures for peer-review.test.ts's reviewQa checks (Phase 14.5.3).
// Deliberately unstable/crash-prone real, committed functions - not used by
// production code - so reviewQa's repeat-call and adversarial-mutation
// checks can be proven against genuine misbehavior rather than simulated.

let toggle = false

/** Deterministically alternates its own answer on every call (never actual
 *  Math.random()) - guarantees two consecutive calls always differ, so the
 *  repeat-call test can never flake, while still genuinely reproducing the
 *  "same args, different result" shape a real non-deterministic function
 *  would exhibit. */
export function flakyDouble(x: number): number {
  toggle = !toggle
  return toggle ? x * 2 + 1 : x * 2
}

/** Works fine for a non-empty string, but throws on an empty one - exactly
 *  the shape reviewQa's boundary-mutation check (mutateArg('A') -> '') is
 *  meant to catch. */
export function firstCharCode(s: string): number {
  if (s.length === 0) throw new Error('cannot get char code of an empty string')
  return s.charCodeAt(0)
}
