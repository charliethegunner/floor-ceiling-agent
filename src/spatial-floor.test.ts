import { describe, expect, test } from 'vitest'
import {
  SPATIAL_VERIFICATION_FLOOR,
  evaluateSdf,
  type SpatialCandidate,
  type SdfNode,
} from './spatial-floor'
import { runVerificationFloor } from './verification-floor'

function runGate(name: 'continuity' | 'volumetric-bound' | 'self-intersection', candidate: SpatialCandidate) {
  const gate = SPATIAL_VERIFICATION_FLOOR.gates.find((g) => g.name === name)
  if (!gate) throw new Error(`no such gate: ${name}`)
  return gate.check(candidate)
}

const UNIT_SPHERE: SdfNode = { type: 'sphere', center: [0, 0, 0], radius: 1 }
const UNIT_BOX: SdfNode = { type: 'box', center: [0, 0, 0], halfExtents: [1, 1, 1] }
const VALID_TORUS: SdfNode = { type: 'torus', center: [0, 0, 0], majorRadius: 2, minorRadius: 0.5 }

describe('evaluateSdf: primitive formulas', () => {
  test('sphere: distance is |p - center| - radius', () => {
    expect(evaluateSdf(UNIT_SPHERE, [2, 0, 0])).toBeCloseTo(1)
    expect(evaluateSdf(UNIT_SPHERE, [0, 0, 0])).toBeCloseTo(-1)
    expect(evaluateSdf(UNIT_SPHERE, [1, 0, 0])).toBeCloseTo(0)
  })

  test('box: zero on the flat face, negative inside, positive outside', () => {
    expect(evaluateSdf(UNIT_BOX, [1, 0, 0])).toBeCloseTo(0)
    expect(evaluateSdf(UNIT_BOX, [1, 0.5, 0])).toBeCloseTo(0)
    expect(evaluateSdf(UNIT_BOX, [0, 0, 0])).toBeCloseTo(-1)
    expect(evaluateSdf(UNIT_BOX, [2, 0, 0])).toBeCloseTo(1)
  })

  test('torus: zero on the tube surface', () => {
    // On the ring plane, at the outer edge of the tube: distance from center = majorRadius + minorRadius
    expect(evaluateSdf(VALID_TORUS, [2.5, 0, 0])).toBeCloseTo(0)
    expect(evaluateSdf(VALID_TORUS, [0, 0, 0])).toBeCloseTo(1.5) // center of the hole is OUTSIDE the tube
  })

  test('union: minimum of children', () => {
    const twoSpheres: SdfNode = {
      type: 'union',
      children: [
        { type: 'sphere', center: [-3, 0, 0], radius: 1 },
        { type: 'sphere', center: [3, 0, 0], radius: 1 },
      ],
    }
    expect(evaluateSdf(twoSpheres, [-3, 0, 0])).toBeCloseTo(-1)
    expect(evaluateSdf(twoSpheres, [3, 0, 0])).toBeCloseTo(-1)
  })

  test('subtraction: max(a, -b) carves b out of a', () => {
    const carved: SdfNode = { type: 'subtraction', a: UNIT_BOX, b: { type: 'sphere', center: [0, 0, 0], radius: 0.5 } }
    expect(evaluateSdf(carved, [0, 0, 0])).toBeCloseTo(0.5) // inside the carved-out cavity: outside the remaining solid
    expect(evaluateSdf(carved, [0.9, 0, 0])).toBeCloseTo(evaluateSdf(UNIT_BOX, [0.9, 0, 0])) // far from the cavity: same as the box
  })
})

describe('SPATIAL_VERIFICATION_FLOOR: continuity gate (Lipschitz / gradient bound)', () => {
  test('a single sphere satisfies the Eikonal property (|gradient| ~= 1) everywhere sampled', async () => {
    const result = await runGate('continuity', {
      surface: UNIT_SPHERE,
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    })
    expect(result.ok).toBe(true)
    expect(result.details).toContain('Lipschitz')
  })

  test('a box satisfies the Lipschitz bound', async () => {
    const result = await runGate('continuity', {
      surface: UNIT_BOX,
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    })
    expect(result.ok).toBe(true)
  })

  test('a torus satisfies the Lipschitz bound', async () => {
    const result = await runGate('continuity', {
      surface: VALID_TORUS,
      boundingBox: { min: [-3, -1, -3], max: [3, 1, 3] },
    })
    expect(result.ok).toBe(true)
  })

  test('a CSG union/subtraction of valid primitives satisfies the Lipschitz bound', async () => {
    const shape: SdfNode = { type: 'subtraction', a: UNIT_BOX, b: { type: 'sphere', center: [0, 0, 0], radius: 0.5 } }
    const result = await runGate('continuity', { surface: shape, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } })
    expect(result.ok).toBe(true)
  })

  test('a malformed "unsafeScale" field (range-only scaling) breaks the Lipschitz bound and is caught', async () => {
    // Multiplying the raw distance VALUE by a factor without rescaling the
    // domain is the classic SDF scaling bug: the zero-set (geometry) is
    // unchanged, but the gradient magnitude is multiplied by `factor` -
    // exactly the numerical-instability case this gate exists to catch.
    const badlyScaled: SdfNode = { type: 'unsafeScale', factor: 3, child: UNIT_SPHERE }
    const result = await runGate('continuity', { surface: badlyScaled, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } })
    expect(result.ok).toBe(false)
    expect(result.details).toContain('Lipschitz')
  })

  test('a custom maxGradientMagnitude override is honored', async () => {
    const scaled: SdfNode = { type: 'unsafeScale', factor: 2, child: UNIT_SPHERE }
    const result = await runGate('continuity', {
      surface: scaled,
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
      maxGradientMagnitude: 3,
    })
    expect(result.ok).toBe(true)
  })
})

describe('SPATIAL_VERIFICATION_FLOOR: volumetric bound gate', () => {
  test('a sphere strictly within its declared bounding box passes', async () => {
    const result = await runGate('volumetric-bound', {
      surface: UNIT_SPHERE,
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    })
    expect(result.ok).toBe(true)
  })

  test('a sphere exceeding a too-small declared bounding box is caught', async () => {
    const result = await runGate('volumetric-bound', {
      surface: UNIT_SPHERE,
      boundingBox: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    })
    expect(result.ok).toBe(false)
    expect(result.details).toContain('Xmax')
  })

  test('a surface EXACTLY touching the boundary fails the strict containment check', async () => {
    const result = await runGate('volumetric-bound', {
      surface: UNIT_SPHERE,
      boundingBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    })
    expect(result.ok).toBe(false)
  })

  test('a bare infinite plane has no finite extent and is rejected', async () => {
    const result = await runGate('volumetric-bound', {
      surface: { type: 'plane', normal: [0, 1, 0], distance: 0 },
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    })
    expect(result.ok).toBe(false)
    expect(result.details).toContain('unbounded')
  })

  test('a plane intersected with a bounded sphere becomes bounded (extent falls back to the bounded child)', async () => {
    const clippedPlane: SdfNode = {
      type: 'intersection',
      children: [{ type: 'plane', normal: [0, 1, 0], distance: 0 }, UNIT_SPHERE],
    }
    const result = await runGate('volumetric-bound', { surface: clippedPlane, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } })
    expect(result.ok).toBe(true)
  })

  test('a union spans the combined extent of its children', async () => {
    const farApart: SdfNode = {
      type: 'union',
      children: [
        { type: 'sphere', center: [-5, 0, 0], radius: 1 },
        { type: 'sphere', center: [5, 0, 0], radius: 1 },
      ],
    }
    const tooSmall = await runGate('volumetric-bound', { surface: farApart, boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] } })
    expect(tooSmall.ok).toBe(false)

    const bigEnough = await runGate('volumetric-bound', { surface: farApart, boundingBox: { min: [-7, -2, -2], max: [7, 2, 2] } })
    expect(bigEnough.ok).toBe(true)
  })

  test('a subtraction is bounded by its base shape (a), regardless of the subtracted piece (b)', async () => {
    const carved: SdfNode = { type: 'subtraction', a: UNIT_BOX, b: { type: 'sphere', center: [0, 0, 0], radius: 100 } }
    const result = await runGate('volumetric-bound', { surface: carved, boundingBox: { min: [-1.5, -1.5, -1.5], max: [1.5, 1.5, 1.5] } })
    expect(result.ok).toBe(true)
  })
})

describe('SPATIAL_VERIFICATION_FLOOR: self-intersection gate', () => {
  test('a well-formed single sphere has no self-intersection', async () => {
    const result = await runGate('self-intersection', {
      surface: UNIT_SPHERE,
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    })
    expect(result.ok).toBe(true)
  })

  test('a well-formed union of separated spheres has no self-intersection', async () => {
    const separated: SdfNode = {
      type: 'union',
      children: [
        { type: 'sphere', center: [-3, 0, 0], radius: 1 },
        { type: 'sphere', center: [3, 0, 0], radius: 1 },
      ],
    }
    const result = await runGate('self-intersection', { surface: separated, boundingBox: { min: [-5, -2, -2], max: [5, 2, 2] } })
    expect(result.ok).toBe(true)
  })

  test('a negative sphere radius is a structurally degenerate primitive and is caught', async () => {
    const result = await runGate('self-intersection', {
      surface: { type: 'sphere', center: [0, 0, 0], radius: -1 },
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    })
    expect(result.ok).toBe(false)
    expect(result.details).toContain('radius')
  })

  test('a zero box halfExtent is a degenerate primitive and is caught', async () => {
    const result = await runGate('self-intersection', {
      surface: { type: 'box', center: [0, 0, 0], halfExtents: [1, 0, 1] },
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    })
    expect(result.ok).toBe(false)
    expect(result.details).toContain('halfExtents')
  })

  test('a torus with majorRadius <= minorRadius self-intersects at the center and is caught', async () => {
    const result = await runGate('self-intersection', {
      surface: { type: 'torus', center: [0, 0, 0], majorRadius: 0.5, minorRadius: 1 },
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    })
    expect(result.ok).toBe(false)
    expect(result.details).toContain('majorRadius')
  })

  test('a zero-normal plane is degenerate and is caught', async () => {
    const result = await runGate('self-intersection', {
      surface: { type: 'plane', normal: [0, 0, 0], distance: 0 },
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    })
    expect(result.ok).toBe(false)
    expect(result.details).toContain('normal')
  })

  test('subtracting a shape from an identical copy of itself creates a degenerate zero-gradient ridge and is caught', async () => {
    // subtraction(a, a) = max(f, -f) = |f| - a genuine "V-cusp" at the
    // original surface (f=0): the resulting field is continuous but its
    // gradient vanishes exactly there, a real non-manifold degeneracy.
    // Grid chosen (resolution 5 over [-2,2]) so a sample point lands EXACTLY
    // on the box's face center (1,0,0), where this is deterministic, not
    // numerically fragile.
    const selfSubtracted: SdfNode = { type: 'subtraction', a: UNIT_BOX, b: UNIT_BOX }
    const result = await runGate('self-intersection', {
      surface: selfSubtracted,
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
      gridResolution: 5,
    })
    expect(result.ok).toBe(false)
    expect(result.details).toContain('gradient')
  })
})

describe('SPATIAL_VERIFICATION_FLOOR: full floor via runVerificationFloor', () => {
  test('all three gates pass together for a well-formed shape', async () => {
    const candidate: SpatialCandidate = {
      surface: { type: 'subtraction', a: UNIT_BOX, b: { type: 'sphere', center: [0, 0, 0], radius: 0.5 } },
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    }
    const report = await runVerificationFloor(SPATIAL_VERIFICATION_FLOOR, candidate)

    expect(report.domain).toBe('spatial-metrology')
    expect(report.gates.map((g) => g.gate)).toEqual(['continuity', 'volumetric-bound', 'self-intersection'])
    expect(report.ok).toBe(true)
  })

  test('a malformed candidate fails at least one gate, and every gate still reports independently', async () => {
    const candidate: SpatialCandidate = {
      surface: { type: 'torus', center: [0, 0, 0], majorRadius: 0.5, minorRadius: 1 },
      boundingBox: { min: [-2, -2, -2], max: [2, 2, 2] },
    }
    const report = await runVerificationFloor(SPATIAL_VERIFICATION_FLOOR, candidate)

    expect(report.ok).toBe(false)
    expect(report.gates).toHaveLength(3)
    expect(report.gates.find((g) => g.gate === 'self-intersection')?.ok).toBe(false)
  })
})
