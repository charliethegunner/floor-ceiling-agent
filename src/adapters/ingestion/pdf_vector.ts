import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

// pdfjs-dist's own .d.ts doesn't re-export several real, documented parts of
// its runtime API from its package entry point (PDFOperatorList,
// isEvalSupported on DocumentInitParameters, and the shapes below) -
// verified directly (each genuinely works/returns this shape) rather than
// worked around blindly. Minimal local structural types for exactly what
// this file reads are more robust than depending on an incomplete upstream
// type export.
interface PdfOperatorListLike {
  fnArray: number[]
  argsArray: (unknown[] | null)[]
}
interface PdfTextItemLike {
  str?: string
  /** [a, b, c, d, e, f] - already fully CTM-composed by pdfjs's own
   *  getTextContent() (unlike getOperatorList()'s raw path coordinates,
   *  see this file's header comment) - verified directly (a scaled/
   *  translated text run's transform reflected the scale/translation). */
  transform?: number[]
}
interface OptionalContentGroupLike {
  id: string
  name: string | null
}
interface OptionalContentConfigLike {
  // `serializable.data` itself is genuinely `null` (not an object with an
  // empty `groups` array) for a PDF that declares no /OCProperties at all -
  // confirmed directly, not assumed; buildLayerNameMap below handles it.
  serializable: { data: { groups: OptionalContentGroupLike[] | null } | null }
}
interface PdfPageLike {
  getOperatorList(): Promise<PdfOperatorListLike>
  getTextContent(): Promise<{ items: PdfTextItemLike[] }>
}
interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
  getOptionalContentConfig(): Promise<OptionalContentConfigLike>
}

// Phase 25.1: real vector-path, text-node, and drawing-layer extraction
// from a PDF, via pdfjs-dist (not a hand-rolled parser) - this project's
// existing src/layer1/ingestion-floor.ts explicitly declined to do this for
// its own PDF support ("No text/content extraction is attempted - that
// needs real stream/filter decoding... this project doesn't have"), citing
// exactly the complexity a real library like pdfjs-dist already solves.
// That earlier scoping decision still stands for ingestion-floor.ts itself;
// this is a separate, additive module, not a rewrite of it.
//
// Deliberately does NOT attempt visual scale-bar detection (graphic tick-
// mark ruler recognition) - that is an unsolved-in-general image-analysis
// problem this project has no validated, deterministic tool for, and
// shipping an unreliable heuristic as "production" code would be exactly
// the kind of theater this project's culture (real Z3 proofs, real
// OpenCASCADE geometry, never a fabricated result) refuses elsewhere.
// findScaleAnnotations below is a real but narrower thing: it finds TEXT
// that states a scale ratio (e.g. "SCALE 1:50", common on AEC drawings
// alongside a graphic bar), which is a well-posed, testable text-pattern
// problem.
//
// pdfjs-dist's getOperatorList() does NOT expose separate moveTo/lineTo/
// curveTo/closePath entries in its fnArray for a stroked/filled path - it
// consolidates a whole (possibly multi-subpath) path into ONE
// OPS.constructPath entry, whose args pack every subpath's commands into a
// flat Float32Array using pdfjs's own small internal code space (NOT the
// same numbers as the top-level OPS.* enum - OPS.moveTo is 13, but inside
// this packed buffer moveTo is coded 0). pdfjs does not publicly export
// these as named constants. Both this shape and the four codes below
// were verified empirically against real, hand-built PDF fixtures (a
// rectangle via explicit m/l/h, a rectangle via the `re` operator - which
// pdfjs decomposes into the identical m/l/h encoding - and both cubic
// curve shorthand forms, `v` and `y`, which pdfjs also normalizes to full
// 6-argument `c` form) before being hardcoded here, not assumed from pdfjs's
// own documentation (which doesn't document this packed format).
//
// Path coordinates inside that buffer are RAW page-content-stream values,
// untouched by any `cm` transform already in effect - confirmed the same
// way (a scaled rectangle's extracted coordinates were unscaled). This
// module therefore tracks the current transformation matrix (CTM) itself,
// via OPS.save/OPS.restore/OPS.transform, exactly as a real PDF content
// stream interpreter must. Drawing layers (PDF Optional Content Groups,
// "OCGs") are tracked the same way, via OPS.beginMarkedContentProps/
// OPS.beginMarkedContent/OPS.endMarkedContent - also verified empirically
// (a real OCG-tagged path's marked-content args carry the OCG's object
// reference id, resolved to a human-readable name via
// PDFDocumentProxy.getOptionalContentConfig()).

export interface Point2D {
  x: number
  y: number
}

export interface PolylineNode {
  /** In millimeters, after unit normalization (see PdfVectorExtractionOptions). */
  points: Point2D[]
  /** True only when the PDF path explicitly closed this subpath (the `h`/closePath operator) -
   *  deliberately NOT a "first point ≈ last point" heuristic. Fuzzy closure detection (tolerant
   *  of a CAD export that draws a closed shape without an explicit close operator) is a
   *  downstream spatial-analysis concern, not this ingestion adapter's. */
  closed: boolean
  /** The drawing layer (PDF Optional Content Group) this path was drawn under, if any - the
   *  OCG's real /Name, or its raw object-reference id if the OCG has no name. Omitted entirely
   *  (not `undefined`-valued) when the path was drawn outside any marked-content/OCG block. */
  layer?: string
}

export interface TextNode {
  text: string
  /** The text run's origin, in millimeters, already CTM-transformed to page space by pdfjs's
   *  own getTextContent() (see this file's header comment). */
  position: Point2D
  /** Approximate rendered glyph height, in millimeters - derived from the text rendering
   *  matrix's y-basis vector magnitude, not a font's nominal point size (which can differ under
   *  a non-uniform CTM). */
  fontSizeMm: number
}

export interface PdfLayer {
  /** The OCG's PDF object-reference id (e.g. "6R") - stable within one document, not a
   *  human-authored identifier. */
  id: string
  /** The OCG's real /Name, or null if the layer was declared without one. */
  name: string | null
}

export interface ScaleAnnotation {
  /** The exact substring matched, e.g. "SCALE 1:50". */
  text: string
  /** Parsed ratio: for "1:50" this is 50 - one drawing unit represents 50 real-world units. */
  ratio: number
  position: Point2D
}

export interface PdfVectorExtractionOptions {
  /** Millimeters per PDF user-space unit. Defaults to the PDF spec's own exact, fixed
   *  definition (ISO 32000-1 §8.3.2.3): 1 unit = 1/72 inch = 25.4/72 mm - a real physical
   *  constant, not an approximation, and not dependent on any page's nominal "DPI" metadata
   *  (which describes how a raster image embedded in the page should be sized, not the vector
   *  coordinate space itself). */
  millimetersPerPoint?: number
  /** Additional real-world scale multiplier for a scaled engineering drawing (e.g. a "1:50"
   *  architectural drawing: 1mm on the physical paper represents 50mm in reality). Defaults to
   *  1 - the paper's own physical size, no drawing-scale amplification. */
  drawingScale?: number
  /** Straight-line segments each cubic Bezier curve (`c`/`v`/`y`) is flattened into. Defaults
   *  to 16 - fine enough that a real engineering curve's polyline approximation error is
   *  negligible without generating a pathological point count for a page with many curves. */
  curveSegments?: number
  /** Which 1-based page numbers to extract. Defaults to every page in the document. */
  pages?: number[]
  /** Upper bound on the input PDF's byte length, checked before any parsing - the same
   *  before-you-hold-the-bytes discipline src/layer1/ingestion-floor.ts's own limits enforce.
   *  Default 100MB. */
  maxBytes?: number
}

export class PdfVectorExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfVectorExtractionError'
  }
}

const PDF_POINTS_TO_MM = 25.4 / 72
const DEFAULT_CURVE_SEGMENTS = 16
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024

// ---------------------------------------------------------------------------
// 2D affine matrix helpers (PDF's [a b c d e f] convention, ISO 32000-1
// §8.3.3). Point transform verified directly against pdfjs-dist's own
// exported Util.applyTransform before being reimplemented here (identical
// formula); matrix composition order verified the same way against
// Util.transform - see this file's own test suite.
// ---------------------------------------------------------------------------

type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0]

/** Composes `inner` (applied to raw coordinates first - e.g. a fresh `cm` operand) with `outer`
 *  (the existing CTM, applied second), matching PDF's "preconcatenate" `cm` semantics. */
function composeMatrix(inner: Matrix, outer: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = inner
  const [a2, b2, c2, d2, e2, f2] = outer
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ]
}

function applyMatrix(m: Matrix, x: number, y: number): Point2D {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

function flattenCubicBezier(p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D, segments: number): Point2D[] {
  const points: Point2D[] = []
  for (let i = 1; i <= segments; i++) {
    const t = i / segments
    const mt = 1 - t
    const a = mt * mt * mt
    const b = 3 * mt * mt * t
    const c = 3 * mt * t * t
    const d = t * t * t
    points.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y })
  }
  return points
}

// ---------------------------------------------------------------------------
// constructPath buffer decoding - see this file's header comment.
// ---------------------------------------------------------------------------

const PATH_OP_MOVE_TO = 0
const PATH_OP_LINE_TO = 1
const PATH_OP_CURVE_TO = 2
const PATH_OP_CLOSE_PATH = 4

function decodeConstructPathBuffer(buffer: Float32Array, matrix: Matrix, millimetersPerUnit: number, curveSegments: number): PolylineNode[] {
  const polylines: PolylineNode[] = []
  let current: Point2D[] = []
  let closed = false
  let rawCursor: Point2D = { x: 0, y: 0 }
  let rawSubpathStart: Point2D = { x: 0, y: 0 }

  const pushRawPoint = (x: number, y: number): void => {
    const transformed = applyMatrix(matrix, x, y)
    current.push({ x: transformed.x * millimetersPerUnit, y: transformed.y * millimetersPerUnit })
  }
  const flushSubpath = (): void => {
    if (current.length > 0) polylines.push({ points: current, closed })
    current = []
    closed = false
  }

  let i = 0
  while (i < buffer.length) {
    const op = buffer[i]
    if (op === PATH_OP_MOVE_TO) {
      flushSubpath()
      const x = buffer[i + 1]
      const y = buffer[i + 2]
      rawCursor = { x, y }
      rawSubpathStart = { x, y }
      pushRawPoint(x, y)
      i += 3
    } else if (op === PATH_OP_LINE_TO) {
      const x = buffer[i + 1]
      const y = buffer[i + 2]
      rawCursor = { x, y }
      pushRawPoint(x, y)
      i += 3
    } else if (op === PATH_OP_CURVE_TO) {
      const x1 = buffer[i + 1]
      const y1 = buffer[i + 2]
      const x2 = buffer[i + 3]
      const y2 = buffer[i + 4]
      const x3 = buffer[i + 5]
      const y3 = buffer[i + 6]
      const p0 = applyMatrix(matrix, rawCursor.x, rawCursor.y)
      const p1 = applyMatrix(matrix, x1, y1)
      const p2 = applyMatrix(matrix, x2, y2)
      const p3 = applyMatrix(matrix, x3, y3)
      for (const p of flattenCubicBezier(p0, p1, p2, p3, curveSegments)) {
        current.push({ x: p.x * millimetersPerUnit, y: p.y * millimetersPerUnit })
      }
      rawCursor = { x: x3, y: y3 }
      i += 7
    } else if (op === PATH_OP_CLOSE_PATH) {
      closed = true
      rawCursor = rawSubpathStart
      i += 1
    } else {
      throw new PdfVectorExtractionError(`unrecognized path segment code ${op} inside a constructPath buffer at index ${i} - pdfjs-dist's internal packed-path encoding may have changed`)
    }
  }
  flushSubpath()
  return polylines
}

// ---------------------------------------------------------------------------
// Drawing layers (Optional Content Groups).
// ---------------------------------------------------------------------------

function buildLayerNameMap(occConfig: OptionalContentConfigLike): Map<string, string | null> {
  const groups = occConfig.serializable.data?.groups ?? []
  return new Map(groups.map((group) => [group.id, group.name]))
}

function layersFromNameMap(layerNameById: ReadonlyMap<string, string | null>): PdfLayer[] {
  return Array.from(layerNameById, ([id, name]) => ({ id, name }))
}

function isOcMarkedContentArgs(args: unknown[] | null): args is [string, { id: string }] {
  return args !== null && args.length >= 2 && args[0] === 'OC' && typeof args[1] === 'object' && args[1] !== null && 'id' in args[1]
}

// ---------------------------------------------------------------------------
// Path + layer extraction over one page's operator list.
// ---------------------------------------------------------------------------

function extractPolylinesFromOperatorList(opList: PdfOperatorListLike, millimetersPerUnit: number, curveSegments: number, layerNameById: ReadonlyMap<string, string | null>): PolylineNode[] {
  const polylines: PolylineNode[] = []
  const matrixStack: Matrix[] = [IDENTITY_MATRIX]
  const layerStack: (string | undefined)[] = [undefined]
  const currentMatrix = (): Matrix => matrixStack[matrixStack.length - 1]
  const currentLayer = (): string | undefined => layerStack[layerStack.length - 1]

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i]

    if (fn === OPS.save) {
      matrixStack.push(currentMatrix())
    } else if (fn === OPS.restore) {
      if (matrixStack.length > 1) matrixStack.pop()
    } else if (fn === OPS.transform) {
      const args = opList.argsArray[i] as number[]
      const m: Matrix = [args[0], args[1], args[2], args[3], args[4], args[5]]
      matrixStack[matrixStack.length - 1] = composeMatrix(m, currentMatrix())
    } else if (fn === OPS.beginMarkedContentProps || fn === OPS.beginMarkedContent) {
      const args = opList.argsArray[i]
      let layerName: string | undefined
      if (isOcMarkedContentArgs(args)) {
        const resolved = layerNameById.get(args[1].id)
        layerName = resolved ?? args[1].id
      }
      // A marked-content block with no OC tag of its own (e.g. a plain
      // /Span for accessibility) inherits whatever layer is already
      // active, rather than clearing it.
      layerStack.push(layerName ?? currentLayer())
    } else if (fn === OPS.endMarkedContent) {
      if (layerStack.length > 1) layerStack.pop()
    } else if (fn === OPS.constructPath) {
      const args = opList.argsArray[i] as [unknown, Float32Array[], unknown]
      const layer = currentLayer()
      for (const buffer of args[1]) {
        const decoded = decodeConstructPathBuffer(buffer, currentMatrix(), millimetersPerUnit, curveSegments)
        for (const polyline of decoded) {
          if (layer !== undefined) polyline.layer = layer
          polylines.push(polyline)
        }
      }
    }
  }

  return polylines
}

// ---------------------------------------------------------------------------
// Shared document-loading plumbing.
// ---------------------------------------------------------------------------

async function withLoadedDocument<T>(pdfBytes: Uint8Array, maxBytes: number, fn: (doc: PdfDocumentLike) => Promise<T>): Promise<T> {
  if (pdfBytes.byteLength > maxBytes) {
    throw new PdfVectorExtractionError(`PDF (${pdfBytes.byteLength} bytes) exceeds the ${maxBytes} byte limit`)
  }

  // pdfjs-dist's own docs warn that a TypedArray passed as `data` is
  // "generally transferred to the worker-thread... it will take ownership
  // of the TypedArrays" - confirmed the hard way (a real DataCloneError)
  // before this copy was added: calling this module's functions twice with
  // the SAME caller-supplied buffer (a completely reasonable thing to do -
  // e.g. this file's own tests extracting the same fixture with two
  // different `options`) detached it on the first call and threw on the
  // second. Copying here keeps `pdfBytes` a value callers only need to
  // read, never a buffer they must remember not to reuse.
  const data = new Uint8Array(pdfBytes)

  // No `disableWorker` option: pdfjs-dist's legacy Node build already
  // detects the lack of a real Worker/worker_threads wiring and falls back
  // to an in-process "fake worker" automatically - verified directly
  // (identical getOperatorList() output with and without the flag) rather
  // than assumed; the option isn't even part of the real DocumentInitParameters
  // type. isEvalSupported: false disables pdfjs's optional eval()/
  // new Function() fast paths - consistent with this project's standing
  // refusal to execute untrusted input anywhere (CeilingAgent.ts's own
  // header comment). useSystemFonts: false keeps this hermetic - text/path
  // extraction never needs to touch the host's installed fonts.
  const documentParams: Parameters<typeof getDocument>[0] & { isEvalSupported: boolean } = {
    data,
    isEvalSupported: false,
    useSystemFonts: false,
  }
  const loadingTask = getDocument(documentParams)

  try {
    const doc = (await loadingTask.promise) as unknown as PdfDocumentLike
    return await fn(doc)
  } finally {
    await loadingTask.destroy()
  }
}

function resolvePageNumbers(doc: PdfDocumentLike, requested: number[] | undefined): number[] {
  const pageNumbers = requested ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)
  for (const pageNumber of pageNumbers) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
      throw new PdfVectorExtractionError(`page ${pageNumber} does not exist (document has ${doc.numPages} page(s))`)
    }
  }
  return pageNumbers
}

// ---------------------------------------------------------------------------
// Public entrypoints.
// ---------------------------------------------------------------------------

/** Extracts real vector geometry from a PDF's content streams as one
 *  PolylineNode[] per requested page (`PolylineNode[][]`, outer index =
 *  page). Every coordinate is already in millimeters and already CTM-
 *  transformed to page space - see PdfVectorExtractionOptions for unit and
 *  drawing-scale control. Each polyline is tagged with its drawing layer
 *  (Optional Content Group), when it was drawn under one. Raster images
 *  and PDF annotations are not represented at all; only real
 *  path-construction operators are read. */
export async function extractPdfVectorPaths(pdfBytes: Uint8Array, options: PdfVectorExtractionOptions = {}): Promise<PolylineNode[][]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const millimetersPerUnit = (options.millimetersPerPoint ?? PDF_POINTS_TO_MM) * (options.drawingScale ?? 1)
  const curveSegments = options.curveSegments ?? DEFAULT_CURVE_SEGMENTS

  return withLoadedDocument(pdfBytes, maxBytes, async (doc) => {
    const pageNumbers = resolvePageNumbers(doc, options.pages)
    const occConfig = await doc.getOptionalContentConfig()
    const layerNameById = buildLayerNameMap(occConfig)

    const result: PolylineNode[][] = []
    for (const pageNumber of pageNumbers) {
      const page = await doc.getPage(pageNumber)
      const opList = await page.getOperatorList()
      result.push(extractPolylinesFromOperatorList(opList, millimetersPerUnit, curveSegments, layerNameById))
    }
    return result
  })
}

/** Extracts real text runs from a PDF's pages as one TextNode[] per
 *  requested page. Position and (approximate) rendered size are already
 *  CTM-transformed and converted to millimeters. Text is NOT tagged with
 *  its drawing layer - see this file's header comment for the scoping
 *  reason (pdfjs's high-level text API doesn't expose marked-content
 *  context the way its raw operator list does for paths). */
export async function extractPdfTextNodes(pdfBytes: Uint8Array, options: PdfVectorExtractionOptions = {}): Promise<TextNode[][]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const millimetersPerUnit = (options.millimetersPerPoint ?? PDF_POINTS_TO_MM) * (options.drawingScale ?? 1)

  return withLoadedDocument(pdfBytes, maxBytes, async (doc) => {
    const pageNumbers = resolvePageNumbers(doc, options.pages)

    const result: TextNode[][] = []
    for (const pageNumber of pageNumbers) {
      const page = await doc.getPage(pageNumber)
      const textContent = await page.getTextContent()
      const nodes: TextNode[] = []
      for (const item of textContent.items) {
        if (typeof item.str !== 'string' || item.str.length === 0 || !item.transform) continue // a TextMarkedContent entry, not real text
        const [, , c, d, e, f] = item.transform
        nodes.push({
          text: item.str,
          position: { x: e * millimetersPerUnit, y: f * millimetersPerUnit },
          fontSizeMm: Math.hypot(c, d) * millimetersPerUnit,
        })
      }
      result.push(nodes)
    }
    return result
  })
}

/** Extracts a PDF's declared drawing layers (Optional Content Groups) -
 *  every layer the document declares, regardless of whether any content is
 *  currently tagged under it. */
export async function extractPdfLayers(pdfBytes: Uint8Array, options: Pick<PdfVectorExtractionOptions, 'maxBytes'> = {}): Promise<PdfLayer[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  return withLoadedDocument(pdfBytes, maxBytes, async (doc) => {
    const occConfig = await doc.getOptionalContentConfig()
    return layersFromNameMap(buildLayerNameMap(occConfig))
  })
}

// A scale ratio stated as text, e.g. "SCALE 1:50", "Scale: 1 : 100", or a
// bare "1:1250" - the numerator is always fixed at 1 (the universal AEC
// drawing-scale convention: NRM2/CESMM4-style scales are always expressed
// as "1:N"). Deliberately permissive about the "SCALE" prefix being present
// - many drawings print the ratio alone next to a graphic bar - see this
// file's header comment for why this is scoped to TEXT patterns only, not
// graphic scale-bar recognition.
const SCALE_ANNOTATION_PATTERN = /(?:scale\s*[:=]?\s*)?\b1\s*:\s*(\d{1,6}(?:\.\d+)?)\b/gi

/** Finds text runs that state a drawing scale ratio (e.g. "SCALE 1:50"),
 *  over an already-extracted page's text nodes. Pure and synchronous - run
 *  it over extractPdfTextNodes's own output. A best-effort text-pattern
 *  match, not a validated calibration - see this file's header comment. */
export function findScaleAnnotations(textNodes: readonly TextNode[]): ScaleAnnotation[] {
  const annotations: ScaleAnnotation[] = []
  for (const node of textNodes) {
    const pattern = new RegExp(SCALE_ANNOTATION_PATTERN)
    let match: RegExpExecArray | null
    while ((match = pattern.exec(node.text)) !== null) {
      annotations.push({ text: match[0], ratio: Number(match[1]), position: node.position })
    }
  }
  return annotations
}
