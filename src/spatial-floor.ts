import type { VerificationFloor, VerificationGate, GateOutcome } from './verification-floor'
import { startDeadlineClock, isDeadlineExceeded, SOLVER_DEADLINE_DIAGNOSTIC, DEFAULT_SOLVER_DEADLINE_MS } from './layer1/verification-floors'

// A concrete VerificationFloor (src/verification-floor.ts) for continuous
// implicit surfaces expressed as Signed Distance Functions (SDFs) - spatial
// metrology, the first non-code-shaped domain this project verifies.
//
// Candidates are STRUCTURED DATA (a tree of named primitives and CSG
// combinators), never candidate-authored executable code: every distance
// value is computed by this file's own trusted, hardcoded closed-form SDF
// formulas, parameterized by candidate-supplied numbers. This mirrors
// claim-floor.ts's "candidate DATA, never candidate CODE" posture and
// CeilingAgent.ts's explicit refusal to execute untrusted LLM output - an
// SDF candidate that tried to smuggle in a JS expression would simply not
// parse against this schema, not get eval()'d.
//
// The three gates below are genuine, checkable mathematical properties, not
// theater: sphere/box/plane/torus and union/intersection/subtraction are all
// provably 1-Lipschitz (a real SDF satisfies the Eikonal equation |∇f|=1
// almost everywhere) - CONTINUITY_GATE verifies that numerically via
// finite-difference gradient sampling. VOLUMETRIC_BOUND_GATE computes each
// node's exact analytic bounding extent (not a sampling approximation) and
// checks strict containment. SELF_INTERSECTION_GATE combines closed-form
// degeneracy checks (e.g. a torus needs majorRadius > minorRadius to be a
// non-self-intersecting embedded manifold) with a gradient-vanishing check
// on the sampled surface (a genuine differential-geometry singularity
// signal, not a heuristic guess).

export interface SpherePrimitive {
  type: 'sphere'
  center: [number, number, number]
  radius: number
}

export interface BoxPrimitive {
  type: 'box'
  center: [number, number, number]
  halfExtents: [number, number, number]
}

export interface PlanePrimitive {
  type: 'plane'
  normal: [number, number, number]
  distance: number
}

export interface TorusPrimitive {
  type: 'torus'
  center: [number, number, number]
  majorRadius: number
  minorRadius: number
}

export type SdfPrimitive = SpherePrimitive | BoxPrimitive | PlanePrimitive | TorusPrimitive

export interface UnionNode {
  type: 'union'
  children: SdfNode[]
}

export interface IntersectionNode {
  type: 'intersection'
  children: SdfNode[]
}

export interface SubtractionNode {
  type: 'subtraction'
  a: SdfNode
  b: SdfNode
}

// Deliberately NOT a well-formed SDF combinator: multiplies the raw distance
// VALUE by `factor` without correspondingly rescaling the domain. This is
// the classic SDF scaling bug - it moves no geometry (the zero-set, where
// value=0, is unchanged since factor*0=0) but multiplies gradient magnitude
// by `factor`, breaking the Lipschitz/Eikonal property whenever factor != 1.
// Included specifically so CONTINUITY_GATE has a real, realistic failure
// case to catch - a mistake an LLM candidate might plausibly make if asked
// to "scale a shape" without knowing the domain must scale too.
export interface UnsafeScaleNode {
  type: 'unsafeScale'
  factor: number
  child: SdfNode
}

export type SdfNode = SdfPrimitive | UnionNode | IntersectionNode | SubtractionNode | UnsafeScaleNode

export interface BoundingBox {
  min: [number, number, number]
  max: [number, number, number]
}

export interface SpatialCandidate {
  surface: SdfNode
  boundingBox: BoundingBox
  /** Grid points sampled per axis for continuity/self-intersection checks. */
  gridResolution?: number
  /** Upper bound on sampled gradient magnitude. Defaults to 1.05 - a true SDF is exactly 1-Lipschitz (Eikonal |∇f|=1); the small margin absorbs finite-difference error, not a design tolerance. */
  maxGradientMagnitude?: number
  /** Phase 13.2: overrides the default 500ms wall-clock bound on the continuity/self-intersection grid scans (see layer1/verification-floors.ts). */
  solverDeadlineMs?: number
}

export type SpatialGateName = 'continuity' | 'volumetric-bound' | 'self-intersection'

// ---------------------------------------------------------------------------
// Vector helpers and the trusted SDF evaluator.
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number]

function subVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function lengthVec(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

function dotVec(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function absVec(v: Vec3): Vec3 {
  return [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])]
}

function normalizeVec(v: Vec3): Vec3 {
  const len = lengthVec(v)
  return len === 0 ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len]
}

export function evaluateSdf(node: SdfNode, p: Vec3): number {
  switch (node.type) {
    case 'sphere':
      return lengthVec(subVec(p, node.center)) - node.radius

    case 'box': {
      const q = subVec(absVec(subVec(p, node.center)), node.halfExtents)
      const outside = lengthVec([Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)])
      const inside = Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0)
      return outside + inside
    }

    case 'plane':
      return dotVec(p, normalizeVec(node.normal)) - node.distance

    case 'torus': {
      const local = subVec(p, node.center)
      const ringDistance = Math.sqrt(local[0] * local[0] + local[2] * local[2]) - node.majorRadius
      return Math.sqrt(ringDistance * ringDistance + local[1] * local[1]) - node.minorRadius
    }

    case 'union':
      return Math.min(...node.children.map((child) => evaluateSdf(child, p)))

    case 'intersection':
      return Math.max(...node.children.map((child) => evaluateSdf(child, p)))

    case 'subtraction':
      return Math.max(evaluateSdf(node.a, p), -evaluateSdf(node.b, p))

    case 'unsafeScale':
      return node.factor * evaluateSdf(node.child, p)
  }
}

const GRADIENT_EPSILON = 1e-4

function estimateGradient(node: SdfNode, p: Vec3): Vec3 {
  const [x, y, z] = p
  const h = GRADIENT_EPSILON
  return [
    (evaluateSdf(node, [x + h, y, z]) - evaluateSdf(node, [x - h, y, z])) / (2 * h),
    (evaluateSdf(node, [x, y + h, z]) - evaluateSdf(node, [x, y - h, z])) / (2 * h),
    (evaluateSdf(node, [x, y, z + h]) - evaluateSdf(node, [x, y, z - h])) / (2 * h),
  ]
}

const DEFAULT_GRID_RESOLUTION = 6

function* sampleGrid(box: BoundingBox, resolution: number): Generator<Vec3> {
  for (let i = 0; i < resolution; i++) {
    for (let j = 0; j < resolution; j++) {
      for (let k = 0; k < resolution; k++) {
        const t = (n: number) => (resolution === 1 ? 0.5 : n / (resolution - 1))
        yield [
          box.min[0] + t(i) * (box.max[0] - box.min[0]),
          box.min[1] + t(j) * (box.max[1] - box.min[1]),
          box.min[2] + t(k) * (box.max[2] - box.min[2]),
        ]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gate: continuity - bounded gradient magnitude (Lipschitz / Eikonal check).
// ---------------------------------------------------------------------------

const DEFAULT_MAX_GRADIENT_MAGNITUDE = 1.05

function checkContinuity(candidate: SpatialCandidate): GateOutcome<'continuity'> {
  const resolution = candidate.gridResolution ?? DEFAULT_GRID_RESOLUTION
  const maxGradient = candidate.maxGradientMagnitude ?? DEFAULT_MAX_GRADIENT_MAGNITUDE
  // Phase 13.2: a cooperative wall-clock check, not Promise.race - this loop
  // is synchronous, and single-threaded JS cannot preempt it mid-iteration;
  // see layer1/verification-floors.ts's header comment for why this is the
  // real (not fabricated) bound for CPU-bound synchronous work like a large
  // candidate.gridResolution.
  const clock = startDeadlineClock(candidate.solverDeadlineMs ?? DEFAULT_SOLVER_DEADLINE_MS)

  let worst = 0
  let worstPoint: Vec3 = [0, 0, 0]
  for (const p of sampleGrid(candidate.boundingBox, resolution)) {
    if (isDeadlineExceeded(clock)) {
      return { gate: 'continuity', ok: false, details: SOLVER_DEADLINE_DIAGNOSTIC }
    }
    const magnitude = lengthVec(estimateGradient(candidate.surface, p))
    if (magnitude > worst) {
      worst = magnitude
      worstPoint = p
    }
  }

  if (worst > maxGradient) {
    return {
      gate: 'continuity',
      ok: false,
      details:
        `gradient magnitude ${worst.toFixed(4)} at (${worstPoint.map((n) => n.toFixed(3)).join(', ')}) exceeds the Lipschitz bound of ${maxGradient} - ` +
        `a valid SDF satisfies |∇f| ≈ 1 everywhere (the Eikonal property); a larger value indicates numerical instability or a malformed implicit field`,
    }
  }
  return {
    gate: 'continuity',
    ok: true,
    details: `max sampled gradient magnitude ${worst.toFixed(4)} across ${resolution ** 3} grid points, within the Lipschitz bound of ${maxGradient}`,
  }
}

// ---------------------------------------------------------------------------
// Gate: volumetric-bound - exact analytic extent per node, checked for
// strict containment within the declared bounding box. Computed
// analytically (not by grid sampling) so it can't miss a surface that
// happens to fall between sample points.
// ---------------------------------------------------------------------------

function extentOf(node: SdfNode): BoundingBox | null {
  switch (node.type) {
    case 'sphere':
      return {
        min: [node.center[0] - node.radius, node.center[1] - node.radius, node.center[2] - node.radius],
        max: [node.center[0] + node.radius, node.center[1] + node.radius, node.center[2] + node.radius],
      }

    case 'box':
      return {
        min: [node.center[0] - node.halfExtents[0], node.center[1] - node.halfExtents[1], node.center[2] - node.halfExtents[2]],
        max: [node.center[0] + node.halfExtents[0], node.center[1] + node.halfExtents[1], node.center[2] + node.halfExtents[2]],
      }

    case 'torus': {
      const ringReach = node.majorRadius + node.minorRadius
      return {
        min: [node.center[0] - ringReach, node.center[1] - node.minorRadius, node.center[2] - ringReach],
        max: [node.center[0] + ringReach, node.center[1] + node.minorRadius, node.center[2] + ringReach],
      }
    }

    case 'plane':
      return null // infinite extent

    case 'union': {
      const extents = node.children.map(extentOf)
      if (extents.some((e) => e === null)) return null
      const boxes = extents as BoundingBox[]
      return {
        min: [Math.min(...boxes.map((b) => b.min[0])), Math.min(...boxes.map((b) => b.min[1])), Math.min(...boxes.map((b) => b.min[2]))],
        max: [Math.max(...boxes.map((b) => b.max[0])), Math.max(...boxes.map((b) => b.max[1])), Math.max(...boxes.map((b) => b.max[2]))],
      }
    }

    case 'intersection': {
      const extents = node.children.map(extentOf).filter((e): e is BoundingBox => e !== null)
      if (extents.length === 0) return null // every child unbounded
      return {
        min: [Math.max(...extents.map((b) => b.min[0])), Math.max(...extents.map((b) => b.min[1])), Math.max(...extents.map((b) => b.min[2]))],
        max: [Math.min(...extents.map((b) => b.max[0])), Math.min(...extents.map((b) => b.max[1])), Math.min(...extents.map((b) => b.max[2]))],
      }
    }

    case 'subtraction':
      return extentOf(node.a) // subtracting can only remove material, never extend beyond `a`

    case 'unsafeScale':
      return extentOf(node.child) // scaling the VALUE doesn't move the zero-set
  }
}

const AXIS_LABELS = ['X', 'Y', 'Z'] as const

function checkVolumetricBound(candidate: SpatialCandidate): GateOutcome<'volumetric-bound'> {
  const extent = extentOf(candidate.surface)
  if (extent === null) {
    return {
      gate: 'volumetric-bound',
      ok: false,
      details: 'surface has unbounded extent (e.g. a bare infinite plane) and cannot be verified against a finite bounding box',
    }
  }

  const { min: boxMin, max: boxMax } = candidate.boundingBox
  const violations: string[] = []
  for (let i = 0; i < 3; i++) {
    if (extent.min[i] <= boxMin[i]) {
      violations.push(`${AXIS_LABELS[i]}min: surface extends to ${extent.min[i].toFixed(3)}, at or beyond the declared ${boxMin[i]}`)
    }
    if (extent.max[i] >= boxMax[i]) {
      violations.push(`${AXIS_LABELS[i]}max: surface extends to ${extent.max[i].toFixed(3)}, at or beyond the declared ${boxMax[i]}`)
    }
  }

  if (violations.length > 0) {
    return { gate: 'volumetric-bound', ok: false, details: violations.join('; ') }
  }
  return {
    gate: 'volumetric-bound',
    ok: true,
    details: `surface extent [${extent.min.map((n) => n.toFixed(3)).join(', ')}] to [${extent.max.map((n) => n.toFixed(3)).join(', ')}] lies strictly within the declared bounding box`,
  }
}

// ---------------------------------------------------------------------------
// Gate: self-intersection - closed-form degeneracy checks (the real
// mathematical conditions for each primitive to be a proper embedded
// manifold) plus a gradient-vanishing check on the sampled surface (a
// genuine differential-geometry singularity signal: a smooth, non-
// self-intersecting point on a true SDF's zero level-set has |∇f| ≈ 1;
// a near-vanishing gradient there indicates two sheets of the surface
// meeting, e.g. from a degenerate CSG combination).
// ---------------------------------------------------------------------------

function validatePrimitiveManifold(node: SdfNode, path: string): string[] {
  switch (node.type) {
    case 'sphere':
      return node.radius <= 0 ? [`${path}: sphere radius must be > 0, got ${node.radius}`] : []

    case 'box':
      return node.halfExtents.flatMap((h, i) => (h <= 0 ? [`${path}: box halfExtents[${i}] must be > 0, got ${h}`] : []))

    case 'plane':
      return lengthVec(node.normal) === 0 ? [`${path}: plane normal must be non-zero`] : []

    case 'torus': {
      const problems: string[] = []
      if (node.minorRadius <= 0) problems.push(`${path}: torus minorRadius must be > 0, got ${node.minorRadius}`)
      if (node.majorRadius <= node.minorRadius) {
        problems.push(`${path}: torus majorRadius (${node.majorRadius}) must exceed minorRadius (${node.minorRadius}) - otherwise the tube self-intersects at the center`)
      }
      return problems
    }

    case 'union':
      return node.children.flatMap((child, i) => validatePrimitiveManifold(child, `${path}.union[${i}]`))

    case 'intersection':
      return node.children.flatMap((child, i) => validatePrimitiveManifold(child, `${path}.intersection[${i}]`))

    case 'subtraction':
      return [...validatePrimitiveManifold(node.a, `${path}.subtraction.a`), ...validatePrimitiveManifold(node.b, `${path}.subtraction.b`)]

    case 'unsafeScale':
      return validatePrimitiveManifold(node.child, `${path}.unsafeScale`)
  }
}

const SELF_INTERSECTION_SURFACE_EPSILON = 0.05
const SELF_INTERSECTION_GRADIENT_FLOOR = 0.1

function checkSelfIntersection(candidate: SpatialCandidate): GateOutcome<'self-intersection'> {
  const structuralProblems = validatePrimitiveManifold(candidate.surface, 'surface')
  if (structuralProblems.length > 0) {
    return { gate: 'self-intersection', ok: false, details: structuralProblems.join('; ') }
  }

  const resolution = candidate.gridResolution ?? DEFAULT_GRID_RESOLUTION
  const clock = startDeadlineClock(candidate.solverDeadlineMs ?? DEFAULT_SOLVER_DEADLINE_MS)
  let singularPoint: Vec3 | undefined
  let singularMagnitude = Infinity

  for (const p of sampleGrid(candidate.boundingBox, resolution)) {
    if (isDeadlineExceeded(clock)) {
      return { gate: 'self-intersection', ok: false, details: SOLVER_DEADLINE_DIAGNOSTIC }
    }
    const value = evaluateSdf(candidate.surface, p)
    if (Math.abs(value) > SELF_INTERSECTION_SURFACE_EPSILON) continue // not near the surface

    const magnitude = lengthVec(estimateGradient(candidate.surface, p))
    if (magnitude < SELF_INTERSECTION_GRADIENT_FLOOR && magnitude < singularMagnitude) {
      singularMagnitude = magnitude
      singularPoint = p
    }
  }

  if (singularPoint) {
    return {
      gate: 'self-intersection',
      ok: false,
      details:
        `near-vanishing gradient (${singularMagnitude.toFixed(4)}) found on the surface at (${singularPoint.map((n) => n.toFixed(3)).join(', ')}) - ` +
        `indicates a singular point where the surface likely self-intersects or forms a non-manifold cusp`,
    }
  }
  return {
    gate: 'self-intersection',
    ok: true,
    details: `no degenerate primitive parameters and no near-vanishing surface gradients found across ${resolution ** 3} sampled grid points`,
  }
}

// ---------------------------------------------------------------------------

export const CONTINUITY_GATE: VerificationGate<SpatialCandidate, SpatialGateName> = { name: 'continuity', check: checkContinuity }
export const VOLUMETRIC_BOUND_GATE: VerificationGate<SpatialCandidate, SpatialGateName> = { name: 'volumetric-bound', check: checkVolumetricBound }
export const SELF_INTERSECTION_GATE: VerificationGate<SpatialCandidate, SpatialGateName> = { name: 'self-intersection', check: checkSelfIntersection }

export const SPATIAL_VERIFICATION_FLOOR: VerificationFloor<SpatialCandidate, SpatialGateName> = {
  domain: 'spatial-metrology',
  gates: [CONTINUITY_GATE, VOLUMETRIC_BOUND_GATE, SELF_INTERSECTION_GATE],
}
