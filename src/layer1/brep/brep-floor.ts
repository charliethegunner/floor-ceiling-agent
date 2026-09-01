import type { VerificationFloor, VerificationGate, GateOutcome, SubShapeFaults } from '../../verification-floor'
import { loadOpenCascade } from './oc-loader'
import type { OpenCascadeInstance, TopoDsShape, OcDisposable, BRepCheckAnalyzer } from './oc-types'

type SubShapeFault = SubShapeFaults['faults'][number]

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

// Phase 16.1: modifier nodes - each operates on a child solid's real,
// already-built edges/faces, selected by INDEX into a de-duplicated list
// (see uniqueEdgesOf/uniqueFacesOf below) rather than any coordinate-based
// guess, since OpenCASCADE has no notion of "the edge near point P" - only
// "this specific topological edge," which TopExp_Explorer enumerates.
// One radius/distance/angle applies to every selected edge/face in a
// single node; a candidate wanting different values per edge nests
// multiple modifier nodes instead - deliberately kept to what was
// spike-verified rather than a speculative per-edge-values API.

export interface FilletBRepNode {
  type: 'fillet'
  child: BRepNode
  /** Indices into the child solid's de-duplicated edge list. */
  edgeIndices: number[]
  radius: number
}

export interface ChamferBRepNode {
  type: 'chamfer'
  child: BRepNode
  edgeIndices: number[]
  distance: number
}

export interface ShellBRepNode {
  type: 'shell'
  child: BRepNode
  /** Indices into the child solid's de-duplicated face list - these faces
   *  are removed (opened), hollowing the solid inward from every other
   *  face by `thickness`. */
  faceIndices: number[]
  thickness: number
}

export interface DraftAngleBRepNode {
  type: 'draftAngle'
  child: BRepNode
  /** Indices into the child solid's de-duplicated face list. A face
   *  parallel to the neutral plane (see below) is a real, fail-closed
   *  rejection, not a bug - draft angle is only meaningful for a face
   *  that actually intersects the neutral plane it's tapered relative to. */
  faceIndices: number[]
  angleDegrees: number
  pullDirection: [number, number, number]
  /** v1 scope: the neutral plane is always the default XY plane at the
   *  origin (OpenCASCADE's own gp_Pln default) - a spike-verified,
   *  reliably constructible plane. An arbitrary custom neutral plane
   *  (gp_Pln from an origin+normal) failed to construct in the same
   *  spike session; this is a real, disclosed limitation, not silently
   *  assumed to work. */
}

export type BRepNode =
  | BRepPrimitive
  | UnionBRepNode
  | IntersectionBRepNode
  | SubtractionBRepNode
  | FilletBRepNode
  | ChamferBRepNode
  | ShellBRepNode
  | DraftAngleBRepNode

export interface BoundingBox3 {
  min: [number, number, number]
  max: [number, number, number]
}

export interface BRepCandidate {
  solid: BRepNode
  boundingBox: BoundingBox3
  /** Phase 16.1: when true, the verified solid is also exported to real
   *  STEP (ISO-10303-21) text, attached as the 'step-export' gate's
   *  details on success. Default false - matches every other optional
   *  candidate field in this codebase in staying opt-in. */
  exportStep?: boolean
}

export type BRepGateName = 'structural-validity' | 'volumetric-bound' | 'step-export'

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

// TopExp_Explorer visits a shared edge/face once per adjacent parent
// (spike-confirmed: a box's 12 real edges show up as 24 raw visits, its 6
// real faces as more than 6) - IsSame-based de-duplication reduces that
// back to the real, unique topological entities. Bounded by a generous
// guard rather than trusting `More()` to always terminate on a
// pathological/degenerate shape - fail closed with a clear error instead
// of hanging, never silently truncate the list.
const EXPLORER_VISIT_GUARD = 10_000

function uniqueSubShapes(oc: OpenCascadeInstance, shape: TopoDsShape, kind: 'edge' | 'face', disposables: OcDisposable[]): TopoDsShape[] {
  const toFind = kind === 'edge' ? oc.TopAbs_ShapeEnum.TopAbs_EDGE : oc.TopAbs_ShapeEnum.TopAbs_FACE
  const explorer = track(disposables, new oc.TopExp_Explorer_2(shape, toFind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
  const seen: TopoDsShape[] = []
  let visits = 0
  while (explorer.More()) {
    if (++visits > EXPLORER_VISIT_GUARD) {
      throw new Error(`shape traversal exceeded ${EXPLORER_VISIT_GUARD} visits while enumerating ${kind}s - the shape is likely degenerate`)
    }
    const current = explorer.Current()
    if (!seen.some((existing) => current.IsSame(existing))) seen.push(current)
    explorer.Next()
  }
  return seen
}

function selectSubShapes<T extends TopoDsShape>(
  all: TopoDsShape[],
  indices: number[],
  kind: 'edge' | 'face',
  cast: (shape: TopoDsShape) => T
): T[] {
  return indices.map((index) => {
    if (index < 0 || index >= all.length || !Number.isInteger(index)) {
      throw new Error(`${kind}Indices contains ${index}, but the child solid has only ${all.length} unique ${kind}(s) (valid range 0-${all.length - 1})`)
    }
    return cast(all[index])
  })
}

function buildFillet(oc: OpenCascadeInstance, node: FilletBRepNode, disposables: OcDisposable[]): TopoDsShape {
  if (node.radius <= 0) throw new Error(`fillet radius must be > 0, got ${node.radius}`)
  if (node.edgeIndices.length === 0) throw new Error('fillet must select at least one edge')

  const childShape = buildShape(oc, node.child, disposables)
  const edges = selectSubShapes(uniqueSubShapes(oc, childShape, 'edge', disposables), node.edgeIndices, 'edge', (s) => oc.TopoDS.Edge_1(s))

  const maker = track(disposables, new oc.BRepFilletAPI_MakeFillet(childShape, oc.ChFi3d_FilletShape.ChFi3d_Rational))
  for (const edge of edges) maker.Add_2(node.radius, edge)
  maker.Build()
  if (!maker.IsDone()) throw new Error('BRepFilletAPI_MakeFillet did not complete (IsDone() = false) - the requested radius may be too large for the selected edge(s)')
  return maker.Shape()
}

function buildChamfer(oc: OpenCascadeInstance, node: ChamferBRepNode, disposables: OcDisposable[]): TopoDsShape {
  if (node.distance <= 0) throw new Error(`chamfer distance must be > 0, got ${node.distance}`)
  if (node.edgeIndices.length === 0) throw new Error('chamfer must select at least one edge')

  const childShape = buildShape(oc, node.child, disposables)
  const edges = selectSubShapes(uniqueSubShapes(oc, childShape, 'edge', disposables), node.edgeIndices, 'edge', (s) => oc.TopoDS.Edge_1(s))

  const maker = track(disposables, new oc.BRepFilletAPI_MakeChamfer(childShape))
  for (const edge of edges) maker.Add_2(node.distance, edge)
  maker.Build()
  if (!maker.IsDone()) throw new Error('BRepFilletAPI_MakeChamfer did not complete (IsDone() = false) - the requested distance may be too large for the selected edge(s)')
  return maker.Shape()
}

function buildShell(oc: OpenCascadeInstance, node: ShellBRepNode, disposables: OcDisposable[]): TopoDsShape {
  if (node.thickness <= 0) throw new Error(`shell thickness must be > 0, got ${node.thickness}`)
  if (node.faceIndices.length === 0) throw new Error('shell must select at least one face to open')

  const childShape = buildShape(oc, node.child, disposables)
  const faces = selectSubShapes(uniqueSubShapes(oc, childShape, 'face', disposables), node.faceIndices, 'face', (s) => oc.TopoDS.Face_1(s))

  const facesToRemove = track(disposables, new oc.TopTools_ListOfShape_1())
  for (const face of faces) facesToRemove.Append_1(face)

  const maker = track(disposables, new oc.BRepOffsetAPI_MakeThickSolid_1())
  // Negative offset hollows INWARD (spike-confirmed: the outer bounding
  // box is unchanged after shelling, exactly as a wall-thickness removal
  // from the inside should behave) - `thickness` itself stays a positive,
  // user-facing "wall thickness" value.
  maker.MakeThickSolidByJoin(childShape, facesToRemove, -node.thickness, 1.0e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false)
  if (!maker.IsDone()) throw new Error('BRepOffsetAPI_MakeThickSolid did not complete (IsDone() = false) - the requested thickness may be too large for this solid')
  return maker.Shape()
}

function buildDraftAngle(oc: OpenCascadeInstance, node: DraftAngleBRepNode, disposables: OcDisposable[]): TopoDsShape {
  if (node.faceIndices.length === 0) throw new Error('draftAngle must select at least one face')

  const childShape = buildShape(oc, node.child, disposables)
  const faces = selectSubShapes(uniqueSubShapes(oc, childShape, 'face', disposables), node.faceIndices, 'face', (s) => oc.TopoDS.Face_1(s))

  const maker = track(disposables, new oc.BRepOffsetAPI_DraftAngle_2(childShape))
  const pullDir = track(disposables, new oc.gp_Dir_4(node.pullDirection[0], node.pullDirection[1], node.pullDirection[2]))
  const neutralPlane = track(disposables, new oc.gp_Pln_1())
  const angleRadians = (node.angleDegrees * Math.PI) / 180

  faces.forEach((face, i) => {
    maker.Add(face, pullDir, angleRadians, neutralPlane, true)
    if (!maker.AddDone()) {
      throw new Error(
        `draftAngle could not be applied to faceIndices[${i}] (index ${node.faceIndices[i]}) - it is likely parallel to the neutral plane ` +
          '(the default XY plane at the origin); draft angle is only meaningful for a face that actually intersects it'
      )
    }
  })
  maker.Build()
  if (!maker.IsDone()) throw new Error('BRepOffsetAPI_DraftAngle did not complete (IsDone() = false)')
  return maker.Shape()
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

    case 'fillet':
      return buildFillet(oc, node, disposables)

    case 'chamfer':
      return buildChamfer(oc, node, disposables)

    case 'shell':
      return buildShell(oc, node, disposables)

    case 'draftAngle':
      return buildDraftAngle(oc, node, disposables)
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

// Phase 19.0: BRepCheck_Analyzer.Result(subShape) gives real, structured,
// per-sub-shape fault data - spike-confirmed on a NaN-radius sphere (Phase
// 15.1's own known-invalid shape), where all 3 unique faces reported
// BRepCheck_UnorientableShape and all 3 unique edges reported
// BRepCheck_NoError. Reuses uniqueSubShapes (the same IsSame-deduplicated
// walker every other gate/builder here already relies on) rather than a
// second traversal mechanism.
function statusNameByValue(oc: OpenCascadeInstance): Map<number, string> {
  const names = new Map<number, string>()
  for (const key of Object.keys(oc.BRepCheck_Status)) {
    if (key === 'values') continue
    const value = oc.BRepCheck_Status[key]?.value
    if (typeof value === 'number') names.set(value, key)
  }
  return names
}

const BRCHECK_NO_ERROR = 0

function collectSubShapeFaults(oc: OpenCascadeInstance, analyzer: BRepCheckAnalyzer, shape: TopoDsShape, disposables: OcDisposable[]): SubShapeFault[] {
  const names = statusNameByValue(oc)
  const faults: SubShapeFault[] = []
  for (const shapeKind of ['face', 'edge'] as const) {
    const subShapes = uniqueSubShapes(oc, shape, shapeKind, disposables)
    subShapes.forEach((subShape, index) => {
      const result = track(disposables, analyzer.Result(subShape)).get()
      const status = track(disposables, result.Status())
      if (status.Size() === 0) return
      const value = status.First_1().value
      if (value === undefined || value === BRCHECK_NO_ERROR) return
      faults.push({ shapeKind, index, status: names.get(value) ?? `BRepCheck_Status(${value})` })
    })
  }
  return faults
}

async function checkStructuralValidity(candidate: BRepCandidate): Promise<GateOutcome<'structural-validity'>> {
  const oc = await loadOpenCascade()
  const disposables: OcDisposable[] = []
  try {
    const shape = buildShape(oc, candidate.solid, disposables)
    const analyzer = track(disposables, new oc.BRepCheck_Analyzer(shape, true))
    if (analyzer.IsValid_2()) {
      return { gate: 'structural-validity', ok: true, details: 'BRepCheck_Analyzer reports the constructed solid is topologically valid' }
    }
    const faults = collectSubShapeFaults(oc, analyzer, shape, disposables)
    return {
      gate: 'structural-validity',
      ok: false,
      details: 'BRepCheck_Analyzer reports the constructed solid is topologically INVALID (inconsistent orientation, open wires, or degenerate edges)',
      structured: { kind: 'subshape-faults', faults },
    }
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
// Gate: step-export - real STEP (ISO-10303-21) text via STEPControl_Writer,
// only when candidate.exportStep is true (otherwise a real, honest
// "not requested" pass, matching the "not applicable, not a failure"
// pattern every other floor in this codebase already uses). The exported
// text is attached verbatim as this gate's `details` on success - the
// same "details carries the real payload" convention claim-floor's
// empirical gate and the instruction floor's Z3 SAT-model counterexamples
// already use, not a new one invented here.
// ---------------------------------------------------------------------------

function exportShapeToStepText(oc: OpenCascadeInstance, shape: TopoDsShape, disposables: OcDisposable[]): string {
  const before = new Set(oc.FS.readdir('/'))
  const writer = track(disposables, new oc.STEPControl_Writer_1())
  writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true)
  // Write()'s own filename argument is spike-confirmed to get corrupted
  // internally in this WASM build (OpenCASCADE's own status log printed
  // garbage bytes instead of the name given) - the file CONTENT is
  // unaffected, so this recovers it via a before/after directory diff on
  // the real (sandboxed, in-memory) Emscripten filesystem rather than
  // trusting the name back.
  writer.Write('export.step')
  const after = oc.FS.readdir('/')
  const newEntry = after.find((entry) => !before.has(entry))
  if (!newEntry) throw new Error('STEP export produced no output file')
  const stepText = oc.FS.readFile(`/${newEntry}`, { encoding: 'utf8' })
  oc.FS.unlink(`/${newEntry}`)
  return stepText
}

async function checkStepExport(candidate: BRepCandidate): Promise<GateOutcome<'step-export'>> {
  if (!candidate.exportStep) {
    return { gate: 'step-export', ok: true, details: 'not requested' }
  }
  const oc = await loadOpenCascade()
  const disposables: OcDisposable[] = []
  try {
    const shape = buildShape(oc, candidate.solid, disposables)
    const stepText = exportShapeToStepText(oc, shape, disposables)
    if (!stepText.startsWith('ISO-10303-21;')) {
      return { gate: 'step-export', ok: false, details: `STEP export produced output that does not start with a real ISO-10303-21 header: ${stepText.slice(0, 80)}` }
    }
    return { gate: 'step-export', ok: true, details: stepText }
  } catch (error) {
    return { gate: 'step-export', ok: false, details: `STEP export failed: ${describeError(error)}` }
  } finally {
    disposeAll(disposables)
  }
}

// ---------------------------------------------------------------------------

export const STRUCTURAL_VALIDITY_GATE: VerificationGate<BRepCandidate, BRepGateName> = { name: 'structural-validity', check: checkStructuralValidity }
export const VOLUMETRIC_BOUND_GATE: VerificationGate<BRepCandidate, BRepGateName> = { name: 'volumetric-bound', check: checkVolumetricBound }
export const STEP_EXPORT_GATE: VerificationGate<BRepCandidate, BRepGateName> = { name: 'step-export', check: checkStepExport }

export const BREP_VERIFICATION_FLOOR: VerificationFloor<BRepCandidate, BRepGateName> = {
  domain: 'brep-geometry',
  gates: [STRUCTURAL_VALIDITY_GATE, VOLUMETRIC_BOUND_GATE, STEP_EXPORT_GATE],
}
