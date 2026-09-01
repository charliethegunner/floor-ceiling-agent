import { describe, test, expect } from 'vitest'
import { runVerificationFloor } from '../../verification-floor'
import { BREP_VERIFICATION_FLOOR, type BRepCandidate } from './brep-floor'

// Real OpenCASCADE (via opencascade.js/WASM) end to end - no mocking. A
// worker's first task pays the ~600ms cold-init cost the loader amortizes
// across every subsequent call (see brep-worker.ts) - here, in-process,
// every test pays it independently, so timeouts are generous.

describe('BREP_VERIFICATION_FLOOR: valid geometry passes both real gates', () => {
  test('a well-formed box is structurally valid and its real bounding box lies within the declared one', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] },
      boundingBox: { min: [-6, -6, -6], max: [6, 6, 6] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
    expect(report.gates.map((g) => g.gate)).toEqual(['structural-validity', 'volumetric-bound', 'step-export'])
  }, 15000)

  test('a well-formed cylinder is structurally valid', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'cylinder', baseCenter: [0, 0, 0], radius: 3, height: 10 },
      boundingBox: { min: [-4, -4, -1], max: [4, 4, 11] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
  }, 15000)

  test('a well-formed sphere is structurally valid', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'sphere', center: [1, 2, 3], radius: 4 },
      boundingBox: { min: [-4, -3, -2], max: [6, 7, 8] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
  }, 15000)

  test('a union of an offset box and sphere genuinely reflects BOTH shapes in its bounding box, not just the first operand (the real Shape() vs Shape1()/Shape2() distinction this floor depends on)', async () => {
    const candidate: BRepCandidate = {
      solid: {
        type: 'union',
        children: [
          { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] },
          { type: 'sphere', center: [5, 0, 0], radius: 3 }, // reaches X=8, beyond the box's own X=5
        ],
      },
      boundingBox: { min: [-6, -6, -6], max: [9, 6, 6] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
    const bound = report.gates.find((g) => g.gate === 'volumetric-bound')
    expect(bound?.details).toContain('8.0000') // the sphere's real contribution, not the box alone
  }, 15000)

  test('a subtraction (box minus a piercing cylinder) is structurally valid', async () => {
    const candidate: BRepCandidate = {
      solid: {
        type: 'subtraction',
        a: { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] },
        b: { type: 'cylinder', baseCenter: [0, 0, -6], radius: 2, height: 12 },
      },
      boundingBox: { min: [-6, -6, -6], max: [6, 6, 6] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
  }, 15000)

  test('an intersection of two overlapping boxes has a bounding box matching only the real overlap region', async () => {
    const candidate: BRepCandidate = {
      solid: {
        type: 'intersection',
        children: [
          { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] },
          { type: 'box', center: [5, 0, 0], halfExtents: [5, 5, 5] }, // overlap is X in [0,5]
        ],
      },
      boundingBox: { min: [-1, -6, -6], max: [6, 6, 6] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
    const bound = report.gates.find((g) => g.gate === 'volumetric-bound')
    expect(bound?.details).toContain('0.0000') // overlap starts at X=0, not X=-5 (the un-intersected box's own extent)
  }, 15000)
})

describe('BREP_VERIFICATION_FLOOR: degenerate geometry fails closed with real, concrete diagnostics', () => {
  test('a zero-height box is rejected by both construction-dependent gates with a real diagnostic, not silently accepted', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 0] },
      boundingBox: { min: [-6, -6, -6], max: [6, 6, 6] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    // step-export independently reports ok:true ("not requested") since
    // exportStep wasn't set - it never even attempts to build the shape,
    // so it's correctly unaffected by the OTHER gates' construction failure.
    expect(report.gates.filter((g) => g.gate !== 'step-export').every((g) => !g.ok)).toBe(true)
    expect(report.gates.find((g) => g.gate === 'step-export')?.ok).toBe(true)
    expect(report.gates[0].details).toContain('halfExtents must all be > 0')
  }, 15000)

  test('a negative-radius cylinder is rejected with a real diagnostic, caught before ever reaching OpenCASCADE', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'cylinder', baseCenter: [0, 0, 0], radius: -3, height: 10 },
      boundingBox: { min: [-4, -4, -1], max: [4, 4, 11] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('radius must be > 0')
  }, 15000)

  test('a zero-radius sphere is rejected with a real diagnostic', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'sphere', center: [0, 0, 0], radius: 0 },
      boundingBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('radius must be > 0')
  }, 15000)

  test('a NaN dimension slips past the pre-check (h <= 0 is false for NaN), but fails both gates for real, independent reasons: BRepCheck_Analyzer flags the constructed solid invalid, and the resulting NaN bounding box is rejected explicitly rather than silently comparing as "contained" (a real bug this exact test caught: NaN < x and NaN > x are both false, which had let a non-finite box report ok:true before the explicit finite check was added)', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'sphere', center: [0, 0, 0], radius: NaN },
      boundingBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    const structural = report.gates.find((g) => g.gate === 'structural-validity')
    expect(structural?.ok).toBe(false)
    const bound = report.gates.find((g) => g.gate === 'volumetric-bound')
    expect(bound?.ok).toBe(false)
    expect(bound?.details).toContain('non-finite')
  }, 15000)

  test('Phase 19.0: the invalid NaN-radius sphere carries structured, per-face BRepCheck_Analyzer fault codes, not just a pass/fail boolean', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'sphere', center: [0, 0, 0], radius: NaN },
      boundingBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    const structural = report.gates.find((g) => g.gate === 'structural-validity')
    expect(structural?.ok).toBe(false)
    expect(structural?.structured?.kind).toBe('subshape-faults')
    if (structural?.structured?.kind === 'subshape-faults') {
      expect(structural.structured.faults.length).toBeGreaterThan(0)
      expect(structural.structured.faults[0]).toMatchObject({ shapeKind: 'face', index: 0, status: 'BRepCheck_UnorientableShape' })
    }
  }, 15000)

  test('a union with zero children is rejected with a real diagnostic', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'union', children: [] },
      boundingBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('union must have at least one child')
  }, 15000)
})

describe('BREP_VERIFICATION_FLOOR: volumetric-bound gate genuinely checks containment, independent of structural validity', () => {
  test('a structurally valid solid still fails volumetric-bound when the declared bounding box is too small', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] },
      boundingBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    const structural = report.gates.find((g) => g.gate === 'structural-validity')
    const bound = report.gates.find((g) => g.gate === 'volumetric-bound')
    expect(structural?.ok).toBe(true)
    expect(bound?.ok).toBe(false)
    expect(bound?.details).toContain('Xmin')
    expect(report.ok).toBe(false)
  }, 15000)

  test('a declared bounding box that generously contains the solid passes', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'sphere', center: [0, 0, 0], radius: 1 },
      boundingBox: { min: [-100, -100, -100], max: [100, 100, 100] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.gates.find((g) => g.gate === 'volumetric-bound')?.ok).toBe(true)
  }, 15000)
})

// ---------------------------------------------------------------------------
// Phase 16.1: advanced B-Rep operations - fillet, chamfer, shell, draft
// angle - each spike-verified against the real OpenCASCADE WASM module
// before being written into production (see brep-floor.ts's own header
// comments on each operation for the exact API findings, including two
// real bugs the spike caught before they shipped: BRepAlgoAPI's
// Shape1()/Shape2() being operand accessors rather than the result, and
// STEPControl_Writer.Write()'s filename argument getting corrupted
// internally).
// ---------------------------------------------------------------------------

const TEST_BOX: BRepCandidate['solid'] = { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 5] }
const GENEROUS_BOUND = { min: [-60, -60, -60] as [number, number, number], max: [60, 60, 60] as [number, number, number] }

describe('BREP_VERIFICATION_FLOOR: fillet (Phase 16.1)', () => {
  test('a real fillet on one edge of a box passes both real gates', async () => {
    const candidate: BRepCandidate = { solid: { type: 'fillet', child: TEST_BOX, edgeIndices: [0], radius: 1 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
  }, 15000)

  test('filleting multiple edges in one node passes', async () => {
    const candidate: BRepCandidate = { solid: { type: 'fillet', child: TEST_BOX, edgeIndices: [0, 1, 2], radius: 1 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
  }, 15000)

  test('a non-positive radius is rejected before ever reaching OpenCASCADE', async () => {
    const candidate: BRepCandidate = { solid: { type: 'fillet', child: TEST_BOX, edgeIndices: [0], radius: 0 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('radius must be > 0')
  }, 15000)

  test('an empty edgeIndices array is rejected with a real diagnostic', async () => {
    const candidate: BRepCandidate = { solid: { type: 'fillet', child: TEST_BOX, edgeIndices: [], radius: 1 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('must select at least one edge')
  }, 15000)

  test('an out-of-range edge index is rejected, naming the real valid range rather than crashing or guessing', async () => {
    const candidate: BRepCandidate = { solid: { type: 'fillet', child: TEST_BOX, edgeIndices: [99], radius: 1 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('edgeIndices contains 99')
    expect(report.gates[0].details).toContain('has only 12 unique edge(s)')
  }, 15000)

  test('a radius far too large for the solid fails closed rather than producing an invalid or crashed result', async () => {
    const candidate: BRepCandidate = { solid: { type: 'fillet', child: TEST_BOX, edgeIndices: [0], radius: 50 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].ok).toBe(false)
    expect(report.gates[0].details.length).toBeGreaterThan(0)
  }, 15000)
})

describe('BREP_VERIFICATION_FLOOR: chamfer (Phase 16.1)', () => {
  test('a real chamfer on one edge of a box passes both real gates', async () => {
    const candidate: BRepCandidate = { solid: { type: 'chamfer', child: TEST_BOX, edgeIndices: [0], distance: 1 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
  }, 15000)

  test('a non-positive distance is rejected before ever reaching OpenCASCADE', async () => {
    const candidate: BRepCandidate = { solid: { type: 'chamfer', child: TEST_BOX, edgeIndices: [0], distance: -1 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('distance must be > 0')
  }, 15000)

  test('an out-of-range edge index is rejected with a real diagnostic', async () => {
    const candidate: BRepCandidate = { solid: { type: 'chamfer', child: TEST_BOX, edgeIndices: [-1], distance: 1 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('edgeIndices contains -1')
  }, 15000)
})

describe('BREP_VERIFICATION_FLOOR: shell (Phase 16.1)', () => {
  test('a real shell (hollowed box, one face open) passes both real gates, with the outer envelope preserved', async () => {
    const candidate: BRepCandidate = { solid: { type: 'shell', child: TEST_BOX, faceIndices: [0], thickness: 1 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
    // Shelling hollows INWARD - the outer bounding box should stay close
    // to the original solid box's own [-5,5]^3 extent, not shrink to
    // reflect only the remaining wall.
    expect(report.gates.find((g) => g.gate === 'volumetric-bound')?.details).toContain('5.0')
  }, 15000)

  test('a non-positive thickness is rejected before ever reaching OpenCASCADE', async () => {
    const candidate: BRepCandidate = { solid: { type: 'shell', child: TEST_BOX, faceIndices: [0], thickness: 0 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('thickness must be > 0')
  }, 15000)

  test('an empty faceIndices array is rejected with a real diagnostic', async () => {
    const candidate: BRepCandidate = { solid: { type: 'shell', child: TEST_BOX, faceIndices: [], thickness: 1 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('must select at least one face')
  }, 15000)

  test('a thickness larger than the solid itself fails closed with a real, named diagnostic (IsDone() = false, not a crash)', async () => {
    const candidate: BRepCandidate = { solid: { type: 'shell', child: TEST_BOX, faceIndices: [0], thickness: 50 }, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('BRepOffsetAPI_MakeThickSolid did not complete')
  }, 15000)
})

describe('BREP_VERIFICATION_FLOOR: draft angle (Phase 16.1)', () => {
  test('drafting a vertical side face of a box (real, geometrically valid configuration) passes both real gates', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'draftAngle', child: TEST_BOX, faceIndices: [0], angleDegrees: 5, pullDirection: [0, 0, 1] },
      boundingBox: GENEROUS_BOUND,
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
  }, 15000)

  test('drafting a face parallel to the default neutral plane (the box\'s own top face) is a real, fail-closed OCCT rejection - not a bug, and never silently accepted', async () => {
    const candidate: BRepCandidate = {
      // faceIndices 4/5 are the box's horizontal top/bottom faces -
      // spike-confirmed AddDone() genuinely returns false for these
      // relative to the default XY neutral plane and a +Z pull direction.
      solid: { type: 'draftAngle', child: TEST_BOX, faceIndices: [4], angleDegrees: 5, pullDirection: [0, 0, 1] },
      boundingBox: GENEROUS_BOUND,
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('parallel to the neutral plane')
  }, 15000)

  test('an empty faceIndices array is rejected with a real diagnostic', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'draftAngle', child: TEST_BOX, faceIndices: [], angleDegrees: 5, pullDirection: [0, 0, 1] },
      boundingBox: GENEROUS_BOUND,
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('must select at least one face')
  }, 15000)

  test('an out-of-range face index is rejected with a real diagnostic', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'draftAngle', child: TEST_BOX, faceIndices: [99], angleDegrees: 5, pullDirection: [0, 0, 1] },
      boundingBox: GENEROUS_BOUND,
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates[0].details).toContain('faceIndices contains 99')
  }, 15000)
})

describe('BREP_VERIFICATION_FLOOR: step-export (Phase 16.1)', () => {
  test('exportStep defaults to false - the gate reports ok:true without ever building or exporting anything', async () => {
    const candidate: BRepCandidate = { solid: TEST_BOX, boundingBox: GENEROUS_BOUND }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    const stepGate = report.gates.find((g) => g.gate === 'step-export')
    expect(stepGate).toEqual({ gate: 'step-export', ok: true, details: 'not requested' })
  }, 15000)

  test('exportStep: true produces real ISO-10303-21 STEP text', async () => {
    const candidate: BRepCandidate = { solid: TEST_BOX, boundingBox: GENEROUS_BOUND, exportStep: true }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    const stepGate = report.gates.find((g) => g.gate === 'step-export')
    expect(stepGate?.ok).toBe(true)
    expect(stepGate?.details.startsWith('ISO-10303-21;')).toBe(true)
    expect(stepGate?.details).toContain('END-ISO-10303-21;')
  }, 15000)

  test('exporting a modified (filleted) solid still produces valid STEP text, proving export works on composed operations, not just primitives', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'fillet', child: TEST_BOX, edgeIndices: [0], radius: 1 },
      boundingBox: GENEROUS_BOUND,
      exportStep: true,
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
    const stepGate = report.gates.find((g) => g.gate === 'step-export')
    expect(stepGate?.details.startsWith('ISO-10303-21;')).toBe(true)
  }, 15000)

  test('requesting export on a candidate that fails to build reports a real export failure, not a false pass', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'fillet', child: TEST_BOX, edgeIndices: [99], radius: 1 },
      boundingBox: GENEROUS_BOUND,
      exportStep: true,
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    const stepGate = report.gates.find((g) => g.gate === 'step-export')
    expect(stepGate?.ok).toBe(false)
    expect(stepGate?.details).toContain('STEP export failed')
  }, 15000)
})

describe('BREP_VERIFICATION_FLOOR: composed advanced operations (Phase 16.1)', () => {
  test('a fillet applied to an already-shelled box succeeds - modifiers compose on real, already-modified geometry, not just fresh primitives', async () => {
    const candidate: BRepCandidate = {
      solid: {
        type: 'fillet',
        child: { type: 'shell', child: TEST_BOX, faceIndices: [0], thickness: 1 },
        edgeIndices: [0],
        radius: 0.5,
      },
      boundingBox: GENEROUS_BOUND,
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(true)
  }, 15000)
})
