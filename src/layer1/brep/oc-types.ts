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

export interface TopoDsShape extends OcDisposable {}

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

export interface OpenCascadeInstance {
  gp_Pnt_3: new (x: number, y: number, z: number) => GpPnt
  gp_Vec_4: new (x: number, y: number, z: number) => GpVec
  gp_Trsf_1: new () => GpTrsf
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
}
