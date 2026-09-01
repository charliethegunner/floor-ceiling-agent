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
    expect(report.gates.map((g) => g.gate)).toEqual(['structural-validity', 'volumetric-bound'])
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
  test('a zero-height box is rejected by both gates with a real diagnostic, not silently accepted', async () => {
    const candidate: BRepCandidate = {
      solid: { type: 'box', center: [0, 0, 0], halfExtents: [5, 5, 0] },
      boundingBox: { min: [-6, -6, -6], max: [6, 6, 6] },
    }
    const report = await runVerificationFloor(BREP_VERIFICATION_FLOOR, candidate)
    expect(report.ok).toBe(false)
    expect(report.gates.every((g) => !g.ok)).toBe(true)
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
    expect(report.gates.find((g) => g.gate === 'structural-validity')?.ok).toBe(false)
    const bound = report.gates.find((g) => g.gate === 'volumetric-bound')
    expect(bound?.ok).toBe(false)
    expect(bound?.details).toContain('non-finite')
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
