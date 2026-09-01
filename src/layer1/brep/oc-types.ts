// Phase 15.0: hand-authored, narrow types for the exact opencascade.js
// (OpenCASCADE-via-WASM) surface this floor uses. The published package
// ships ZERO TypeScript declarations (confirmed: no .d.ts anywhere in the
// package, no @types/opencascade.js on npm) and its own "Supported APIs.md"
// lists class names with no argument/overload detail at all - embind
// exposes every C++ overload as a separately-numbered class/method
// (e.g. BRepPrimAPI_MakeBox_1..4; the bare "BRepPrimAPI_MakeBox" name is
// NOT constructible - confirmed empirically). Every signature below was
// confirmed against the live WASM module in a throwaway spike before being
// written down here - none of this is guessed from documentation.

export interface OcDisposable {
  delete?: () => void
}

export interface TopoDsShape extends OcDisposable {
  /** Orientation-independent "is this the same underlying topological
   *  entity" check - the correct de-duplication test for TopExp_Explorer's
   *  own traversal, which visits a shared edge/face once per adjacent
   *  parent (spike-confirmed: a box's 12 real edges show up as 24 raw
   *  TopExp_Explorer visits; IsSame-based de-dup reduces that back to 12). */
  IsSame(other: TopoDsShape): boolean
}

export interface TopoDsEdge extends TopoDsShape {}
export interface TopoDsFace extends TopoDsShape {}

export interface GpPnt extends OcDisposable {
  X(): number
  Y(): number
  Z(): number
}

export interface GpVec extends OcDisposable {}

export interface GpTrsf extends OcDisposable {
  SetTranslation_1(vec: GpVec): void
}

export interface BndBox extends OcDisposable {
  CornerMin(): GpPnt
  CornerMax(): GpPnt
}

/** Common shape to every BRepPrimAPI_Make* result (Box/Cylinder/Sphere). */
export interface BRepPrimitiveMaker extends OcDisposable {
  Shape(): TopoDsShape
}

/** Common shape to BRepAlgoAPI_Fuse_3/Cut_3/Common_3 - all real subclasses
 *  of OpenCASCADE's BRepAlgoAPI_BooleanOperation, confirmed to share this
 *  exact Build/Shape/IsDone surface (spike-verified individually, not
 *  assumed from the shared base class alone). Shape1()/Shape2() also exist
 *  on this class but are accessors for the operation's two INPUT operands
 *  (confirmed empirically, after an initial mistaken assumption that the
 *  "1" suffix meant "the real result overload") - Shape() (inherited from
 *  the BRepBuilderAPI_MakeShape base, no numeric suffix) is the actual
 *  boolean result and the only one of the three exposed here. */
export interface BRepBooleanOperation extends OcDisposable {
  Build(): void
  Shape(): TopoDsShape
  IsDone(): boolean
}

export interface BRepCheckAnalyzer extends OcDisposable {
  IsValid_2(): boolean
}

export interface BRepBuilderApiTransform extends OcDisposable {
  Shape(): TopoDsShape
}

export interface BRepBndLibNamespace {
  Add(shape: TopoDsShape, box: BndBox, useTriangulation: boolean): void
}

// Phase 16.1: advanced B-Rep operations (fillet/chamfer/shell/draft) and
// STEP export - every signature below is spike-verified the same way as
// everything above, including two real, non-obvious findings: embind
// enum members (ChFi3d_FilletShape.ChFi3d_Rational etc.) are opaque
// wrapper objects, not plain numbers, so they're typed as OcEnumValue
// rather than `number`; and TopTools_IndexedMapOfShape - the standard
// OCCT class for an indexed/de-duplicated shape list - is NOT bound in
// this WASM build at all (confirmed: absent from the module's own key
// list), which is why edge/face selection here goes through
// TopExp_Explorer + IsSame de-duplication instead (see brep-floor.ts).

/** Opaque wrapper embind gives every bound C++ enum member - never a bare
 *  number, confirmed empirically (an enum member logged as `ctor {}`; the
 *  status objects STEPControl_Writer/Reader return carry an inspectable
 *  `.value`, but the enum members used to CONSTRUCT calls are opaque and
 *  only ever passed through, never compared numerically here). */
export interface OcEnumValue {
  readonly value?: number
}

export interface TopExpExplorer extends OcDisposable {
  More(): boolean
  Next(): void
  Current(): TopoDsShape
}

export interface TopAbsShapeEnumNamespace {
  TopAbs_EDGE: OcEnumValue
  TopAbs_FACE: OcEnumValue
  TopAbs_SHAPE: OcEnumValue
}

export interface TopoDsNamespace {
  Edge_1(shape: TopoDsShape): TopoDsEdge
  Face_1(shape: TopoDsShape): TopoDsFace
}

export interface TopToolsListOfShape extends OcDisposable {
  Append_1(shape: TopoDsShape): void
}

export interface GpDir extends OcDisposable {}
export interface GpPln extends OcDisposable {}

/** Common to BRepFilletAPI_MakeFillet/MakeChamfer - both real subclasses
 *  of BRepFilletAPI_LocalOperation, spike-verified individually (not
 *  assumed from the shared base) to share this exact
 *  Add_2/Build/IsDone/Shape surface. */
export interface BRepFilletOperation extends OcDisposable {
  Add_2(value: number, edge: TopoDsEdge): void
  Build(): void
  IsDone(): boolean
  Shape(): TopoDsShape
}

export interface ChFi3dFilletShapeNamespace {
  ChFi3d_Rational: OcEnumValue
}

export interface BRepOffsetModeNamespace {
  BRepOffset_Skin: OcEnumValue
}

export interface GeomAbsJoinTypeNamespace {
  GeomAbs_Arc: OcEnumValue
}

export interface BRepOffsetApiMakeThickSolid extends OcDisposable {
  /** Real 9-arg OCCT signature (shape, closingFaces, offset, tolerance,
   *  mode, intersection, selfInter, joinType, removeIntEdges) -
   *  spike-confirmed after two shorter attempts (4-arg, then 8-arg) both
   *  failed with an explicit embind arg-count error naming 9 as correct. */
  MakeThickSolidByJoin(
    shape: TopoDsShape,
    closingFaces: TopToolsListOfShape,
    offset: number,
    tolerance: number,
    mode: OcEnumValue,
    intersection: boolean,
    selfInter: boolean,
    joinType: OcEnumValue,
    removeIntEdges: boolean
  ): void
  IsDone(): boolean
  Shape(): TopoDsShape
}

export interface BRepOffsetApiDraftAngle extends OcDisposable {
  /** Real 5-arg signature (face, pullDirection, angleRadians, neutralPlane,
   *  flag). AddDone() reports whether THIS specific Add() call actually
   *  queued a real modification - spike-confirmed it's false (not a
   *  throw) for a face parallel to the neutral plane, e.g. a box's own
   *  top/bottom faces when drafting relative to the default XY plane -
   *  correct, fail-closed OCCT behavior, not a bug to work around. */
  Add(face: TopoDsFace, pullDirection: GpDir, angleRadians: number, neutralPlane: GpPln, flag: boolean): void
  AddDone(): boolean
  Build(): void
  IsDone(): boolean
  Shape(): TopoDsShape
}

export interface StepControlStepModelTypeNamespace {
  STEPControl_AsIs: OcEnumValue
}

export interface StepTransferStatus extends OcDisposable {
  readonly value: number
}

export interface StepControlWriter extends OcDisposable {
  Transfer(shape: TopoDsShape, modelType: OcEnumValue, compound: boolean): StepTransferStatus
  Write(filename: string): StepTransferStatus
}

/** Emscripten's in-memory virtual filesystem (MEMFS), exposed directly on
 *  the module instance - real, sandboxed, never touches the actual Node
 *  filesystem. Used to recover STEP export output via a before/after
 *  directory diff rather than trusting Write()'s own filename argument:
 *  spike-confirmed real, reproducible bug in this build - the filename
 *  Write() receives gets corrupted internally (OpenCASCADE's own status
 *  log printed garbage bytes instead of the real name given), while the
 *  file CONTENT it writes is unaffected - so this reads back whatever new
 *  entry appears rather than the name that was asked for. */
export interface EmscriptenFS {
  readdir(path: string): string[]
  readFile(path: string, opts: { encoding: 'utf8' }): string
  unlink(path: string): void
}

export interface OpenCascadeInstance {
  gp_Pnt_3: new (x: number, y: number, z: number) => GpPnt
  gp_Vec_4: new (x: number, y: number, z: number) => GpVec
  gp_Trsf_1: new () => GpTrsf
  gp_Dir_4: new (x: number, y: number, z: number) => GpDir
  gp_Pln_1: new () => GpPln
  Bnd_Box_1: new () => BndBox
  BRepBndLib: BRepBndLibNamespace
  BRepPrimAPI_MakeBox_1: new (dx: number, dy: number, dz: number) => BRepPrimitiveMaker
  BRepPrimAPI_MakeCylinder_1: new (radius: number, height: number) => BRepPrimitiveMaker
  BRepPrimAPI_MakeSphere_1: new (radius: number) => BRepPrimitiveMaker
  BRepAlgoAPI_Fuse_3: new (a: TopoDsShape, b: TopoDsShape) => BRepBooleanOperation
  BRepAlgoAPI_Cut_3: new (a: TopoDsShape, b: TopoDsShape) => BRepBooleanOperation
  BRepAlgoAPI_Common_3: new (a: TopoDsShape, b: TopoDsShape) => BRepBooleanOperation
  BRepBuilderAPI_Transform_2: new (shape: TopoDsShape, trsf: GpTrsf, copy: boolean) => BRepBuilderApiTransform
  BRepCheck_Analyzer: new (shape: TopoDsShape, geomControls: boolean) => BRepCheckAnalyzer
  TopExp_Explorer_2: new (shape: TopoDsShape, toFind: OcEnumValue, toAvoid: OcEnumValue) => TopExpExplorer
  TopAbs_ShapeEnum: TopAbsShapeEnumNamespace
  TopoDS: TopoDsNamespace
  TopTools_ListOfShape_1: new () => TopToolsListOfShape
  BRepFilletAPI_MakeFillet: new (shape: TopoDsShape, filletShape: OcEnumValue) => BRepFilletOperation
  BRepFilletAPI_MakeChamfer: new (shape: TopoDsShape) => BRepFilletOperation
  ChFi3d_FilletShape: ChFi3dFilletShapeNamespace
  BRepOffsetAPI_MakeThickSolid_1: new () => BRepOffsetApiMakeThickSolid
  BRepOffset_Mode: BRepOffsetModeNamespace
  GeomAbs_JoinType: GeomAbsJoinTypeNamespace
  BRepOffsetAPI_DraftAngle_2: new (shape: TopoDsShape) => BRepOffsetApiDraftAngle
  STEPControl_Writer_1: new () => StepControlWriter
  STEPControl_StepModelType: StepControlStepModelTypeNamespace
  FS: EmscriptenFS
}
