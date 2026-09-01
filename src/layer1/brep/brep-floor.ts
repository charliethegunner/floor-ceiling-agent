import type { VerificationFloor, VerificationGate, GateOutcome } from '../../verification-floor'
import { loadOpenCascade } from './oc-loader'
import type { OpenCascadeInstance, TopoDsShape, OcDisposable } from './oc-types'

// A concrete VerificationFloor (src/verification-floor.ts) for solid B-Rep
// (Boundary Representation) geometry - faces/edges/vertices bounded by
// NURBS surfaces, the representation industrial CAD toolchains actually
// use, as distinct from spatial-floor.ts's implicit SDF surfaces (a
// materially different representation, not an extension of it).
//
// Candidates are STRUCTURED DATA (a tree of named primitives and CSG
// combinators), never candidate-authored executable code - mirroring
// spatial-floor.ts's own posture and claim-floor.ts's "candidate DATA,
// never candidate CODE" rule. Every shape is built by this file's own
// trusted calls into OpenCASCADE, parameterized by candidate-supplied
// numbers; a candidate can no more smuggle in arbitrary code here than an
// SDF candidate can.
//
// OpenCASCADE itself is the verification oracle here, the same
// architectural role Z3 plays for the instruction floor and ts-morph plays
// for the topology floor: STRUCTURAL_VALIDITY_GATE delegates to
// BRepCheck_Analyzer, OpenCASCADE's own real topological-validity checker
// (closed wires, consistent orientation, no degenerate edges) - not a
// heuristic this project invented. VOLUMETRIC_BOUND_GATE mirrors
// spatial-floor's existing analytic-extent gate, using OpenCASCADE's own
// BRepBndLib to compute the shape's real bounding box rather than
// re-deriving one.
//
// This floor is only ever invoked from inside a dedicated worker thread
// (see brep-worker.ts / brep-worker-pool.ts) - never the main thread. Two
// real, spike-measured costs justify that (not asserted): a ~600ms WASM
// cold-init paid once per worker, and a ~450-500MB per-worker RSS
// footprint for the loaded kernel, both far larger than any other domain
// this project verifies.

export interface BoxBRepPrimitive {
  type: 'box'
  center: [number, number, number]
  halfExtents: [number, number, number]
}

export interface CylinderBRepPrimitive {
  type: 'cylinder'
  /** The cylinder's base center; it extends along +Z from here. v1 scope:
   *  axis-aligned along +Z only (OpenCASCADE's own MakeCylinder default
   *  axis) - arbitrary rotation is a real, deliberately deferred
   *  limitation, not an oversight. */
  baseCenter: [number, number, number]
  radius: number
  height: number
}

export interface SphereBRepPrimitive {
  type: 'sphere'
  center: [number, number, number]
  radius: number
}

export type BRepPrimitive = BoxBRepPrimitive | CylinderBRepPrimitive | SphereBRepPrimitive

export interface UnionBRepNode {
  type: 'union'
  children: BRepNode[]
}

export interface IntersectionBRepNode {
  type: 'intersection'
  children: BRepNode[]
}

export interface SubtractionBRepNode {
  type: 'subtraction'
  a: BRepNode
  b: BRepNode
}

export type BRepNode = BRepPrimitive | UnionBRepNode | IntersectionBRepNode | SubtractionBRepNode

export interface BoundingBox3 {
  min: [number, number, number]
  max: [number, number, number]
}

export interface BRepCandidate {
  solid: BRepNode
  boundingBox: BoundingBox3
}

export type BRepGateName = 'structural-validity' | 'volumetric-bound'

// ---------------------------------------------------------------------------
// Shape construction. Every OpenCASCADE object created along the way
// (points, vectors, transforms, primitive makers, boolean operations) is
// tracked and disposed at the end of the gate that built it - embind
// objects live in WASM linear memory, invisible to V8's GC, so a missing
// `.delete()` is a real leak, not a style nit (spike-confirmed: RSS stayed
// flat across 200 build+check cycles ONLY because every object built was
// explicitly deleted). A shape is built FRESH for every gate rather than
// shared across gates or cached - deliberately, after the spike surfaced a
// case where reusing the same shape handle across two different boolean
// operations produced a suspect result; building fresh sidesteps that
// entirely rather than trying to prove it's safe to share.
// ---------------------------------------------------------------------------

function track<T extends OcDisposable>(disposables: OcDisposable[], value: T): T {
  disposables.push(value)
  return value
}

function disposeAll(disposables: OcDisposable[]): void {
  for (let i = disposables.length - 1; i >= 0; i--) {
    disposables[i].delete?.()
  }
}

function translate(oc: OpenCascadeInstance, shape: TopoDsShape, offset: [number, number, number], disposables: OcDisposable[]): TopoDsShape {
  if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) return shape
  const vec = track(disposables, new oc.gp_Vec_4(offset[0], offset[1], offset[2]))
  const trsf = track(disposables, new oc.gp_Trsf_1())
  trsf.SetTranslation_1(vec)
  const transform = track(disposables, new oc.BRepBuilderAPI_Transform_2(shape, trsf, true))
  return transform.Shape()
}

function buildPrimitive(oc: OpenCascadeInstance, node: BRepPrimitive, disposables: OcDisposable[]): TopoDsShape {
  switch (node.type) {
    case 'box': {
      if (node.halfExtents.some((h) => h <= 0)) {
        throw new Error(`box halfExtents must all be > 0, got [${node.halfExtents.join(', ')}]`)
      }
      const [dx, dy, dz] = node.halfExtents.map((h) => h * 2) as [number, number, number]
      const maker = track(disposables, new oc.BRepPrimAPI_MakeBox_1(dx, dy, dz))
      const cornerOffset: [number, number, number] = [node.center[0] - node.halfExtents[0], node.center[1] - node.halfExtents[1], node.center[2] - node.halfExtents[2]]
      return translate(oc, maker.Shape(), cornerOffset, disposables)
    }
    case 'cylinder': {
      if (node.radius <= 0) throw new Error(`cylinder radius must be > 0, got ${node.radius}`)
      if (node.height <= 0) throw new Error(`cylinder height must be > 0, got ${node.height}`)
      const maker = track(disposables, new oc.BRepPrimAPI_MakeCylinder_1(node.radius, node.height))
      return translate(oc, maker.Shape(), node.baseCenter, disposables)
    }
    case 'sphere': {
      if (node.radius <= 0) throw new Error(`sphere radius must be > 0, got ${node.radius}`)
      const maker = track(disposables, new oc.BRepPrimAPI_MakeSphere_1(node.radius))
      return translate(oc, maker.Shape(), node.center, disposables)
    }
  }
}

function buildShape(oc: OpenCascadeInstance, node: BRepNode, disposables: OcDisposable[]): TopoDsShape {
  switch (node.type) {
    case 'box':
    case 'cylinder':
    case 'sphere':
      return buildPrimitive(oc, node, disposables)

    case 'union': {
      if (node.children.length === 0) throw new Error('union must have at least one child')
      return node.children.map((child) => buildShape(oc, child, disposables)).reduce((acc, shape) => {
        const op = track(disposables, new oc.BRepAlgoAPI_Fuse_3(acc, shape))
        op.Build()
        if (!op.IsDone()) throw new Error('BRepAlgoAPI_Fuse did not complete (IsDone() = false)')
        return op.Shape()
      })
    }

    case 'intersection': {
      if (node.children.length === 0) throw new Error('intersection must have at least one child')
      return node.children.map((child) => buildShape(oc, child, disposables)).reduce((acc, shape) => {
        const op = track(disposables, new oc.BRepAlgoAPI_Common_3(acc, shape))
        op.Build()
        if (!op.IsDone()) throw new Error('BRepAlgoAPI_Common did not complete (IsDone() = false)')
        return op.Shape()
      })
    }

    case 'subtraction': {
      const a = buildShape(oc, node.a, disposables)
      const b = buildShape(oc, node.b, disposables)
      const op = track(disposables, new oc.BRepAlgoAPI_Cut_3(a, b))
      op.Build()
      if (!op.IsDone()) throw new Error('BRepAlgoAPI_Cut did not complete (IsDone() = false)')
      return op.Shape()
    }
  }
}

function describeError(error: unknown): string {
  // OpenCASCADE rejects some degenerate inputs (e.g. a zero-height box) by
  // throwing across the WASM boundary - spike-confirmed this is a bare
  // number (a raw native/embind exception handle), NOT a JS Error, so
  // `.message` isn't available and String(error) is the real, honest text.
  return error instanceof Error ? error.message : `native OpenCASCADE exception: ${String(error)}`
}

// ---------------------------------------------------------------------------
// Gate: structural-validity - BRepCheck_Analyzer, OpenCASCADE's own real
// topological validity checker, not a heuristic this project invented.
// ---------------------------------------------------------------------------

async function checkStructuralValidity(candidate: BRepCandidate): Promise<GateOutcome<'structural-validity'>> {
  const oc = await loadOpenCascade()
  const disposables: OcDisposable[] = []
  try {
    const shape = buildShape(oc, candidate.solid, disposables)
    const analyzer = track(disposables, new oc.BRepCheck_Analyzer(shape, true))
    const valid = analyzer.IsValid_2()
    return valid
      ? { gate: 'structural-validity', ok: true, details: 'BRepCheck_Analyzer reports the constructed solid is topologically valid' }
      : { gate: 'structural-validity', ok: false, details: 'BRepCheck_Analyzer reports the constructed solid is topologically INVALID (inconsistent orientation, open wires, or degenerate edges)' }
  } catch (error) {
    return { gate: 'structural-validity', ok: false, details: `shape construction failed: ${describeError(error)}` }
  } finally {
    disposeAll(disposables)
  }
}

// ---------------------------------------------------------------------------
// Gate: volumetric-bound - OpenCASCADE's own BRepBndLib-computed bounding
// box, checked for strict containment within the declared bounding box -
// the direct B-Rep analogue of spatial-floor.ts's existing analytic-extent
// gate. A small tolerance absorbs OpenCASCADE's own numerical padding on
// the computed box (spike-measured: ~1e-7 on a unit-scale box), not a
// design margin.
// ---------------------------------------------------------------------------

const BOUNDING_BOX_TOLERANCE = 1e-4
const AXIS_LABELS = ['X', 'Y', 'Z'] as const

async function checkVolumetricBound(candidate: BRepCandidate): Promise<GateOutcome<'volumetric-bound'>> {
  const oc = await loadOpenCascade()
  const disposables: OcDisposable[] = []
  try {
    const shape = buildShape(oc, candidate.solid, disposables)
    const bndBox = track(disposables, new oc.Bnd_Box_1())
    oc.BRepBndLib.Add(shape, bndBox, true)
    const cornerMin = track(disposables, bndBox.CornerMin())
    const cornerMax = track(disposables, bndBox.CornerMax())
    const actualMin: [number, number, number] = [cornerMin.X(), cornerMin.Y(), cornerMin.Z()]
    const actualMax: [number, number, number] = [cornerMax.X(), cornerMax.Y(), cornerMax.Z()]

    // A NaN/Infinity coordinate makes every direct comparison below false
    // regardless of operand order, which would otherwise report a
    // nonsensical bounding box as "contained" - a real fail-open bug this
    // project's floors never accept (caught empirically: a NaN-radius
    // sphere produced exactly this).
    if (![...actualMin, ...actualMax].every(Number.isFinite)) {
      return {
        gate: 'volumetric-bound',
        ok: false,
        details: `computed bounding box is non-finite: min=[${actualMin.join(', ')}] max=[${actualMax.join(', ')}] - the constructed solid is degenerate`,
      }
    }

    const { min: boxMin, max: boxMax } = candidate.boundingBox
    const violations: string[] = []
    for (let i = 0; i < 3; i++) {
      if (actualMin[i] < boxMin[i] - BOUNDING_BOX_TOLERANCE) {
        violations.push(`${AXIS_LABELS[i]}min: solid extends to ${actualMin[i].toFixed(4)}, beyond the declared ${boxMin[i]}`)
      }
      if (actualMax[i] > boxMax[i] + BOUNDING_BOX_TOLERANCE) {
        violations.push(`${AXIS_LABELS[i]}max: solid extends to ${actualMax[i].toFixed(4)}, beyond the declared ${boxMax[i]}`)
      }
    }

    if (violations.length > 0) {
      return { gate: 'volumetric-bound', ok: false, details: violations.join('; ') }
    }
    return {
      gate: 'volumetric-bound',
      ok: true,
      details: `solid extent [${actualMin.map((n) => n.toFixed(4)).join(', ')}] to [${actualMax.map((n) => n.toFixed(4)).join(', ')}] lies within the declared bounding box`,
    }
  } catch (error) {
    return { gate: 'volumetric-bound', ok: false, details: `shape construction failed: ${describeError(error)}` }
  } finally {
    disposeAll(disposables)
  }
}

// ---------------------------------------------------------------------------

export const STRUCTURAL_VALIDITY_GATE: VerificationGate<BRepCandidate, BRepGateName> = { name: 'structural-validity', check: checkStructuralValidity }
export const VOLUMETRIC_BOUND_GATE: VerificationGate<BRepCandidate, BRepGateName> = { name: 'volumetric-bound', check: checkVolumetricBound }

export const BREP_VERIFICATION_FLOOR: VerificationFloor<BRepCandidate, BRepGateName> = {
  domain: 'brep-geometry',
  gates: [STRUCTURAL_VALIDITY_GATE, VOLUMETRIC_BOUND_GATE],
}
