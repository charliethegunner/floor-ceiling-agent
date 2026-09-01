import { describe, test, expect } from 'vitest'
import fc from 'fast-check'
import { extractPdfVectorPaths, PdfVectorExtractionError } from './pdf_vector'

// Real vector PDF fixtures, not mocks: every test below builds a genuine,
// spec-valid (PDF 1.4) single-page PDF byte stream and feeds it through the
// real pdfjs-dist parser - the same discipline this project's other
// verification floors follow (real Z3 proofs, real ts-morph ASTs, real
// OpenCASCADE WASM). "Real vector PDF fixtures" per the Phase 25.1 task
// description means genuinely valid PDF bytes a real reader can open, not
// literally third-party sample files vendored into the repo.
//
// Deliberately does NOT feed extracted geometry into src/spatial-floor.ts
// (the real file - there is no src/floors/spatial.ts in this codebase).
// SpatialCandidate is an SDF/CSG primitive tree (spheres, boxes, planes,
// tori); converting an arbitrary extracted polyline into that
// representation is a separate, nontrivial "geometry fitting" problem, not
// an ingestion concern - out of scope here. What this suite verifies is
// exactly what the task asked for: coordinate extraction and closed-loop
// preservation are correct BEFORE any such downstream step could consume
// them.

const PDF_POINTS_TO_MM = 25.4 / 72

function buildMinimalPdf(contentStream: string): Uint8Array {
  const objects: string[] = []
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  objects[2] = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
  objects[3] = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 2000] /Contents 4 0 R /Resources << >> >>\nendobj\n'
  objects[4] = `4 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let i = 1; i <= 4; i++) {
    offsets[i] = pdf.length
    pdf += objects[i]
  }
  const xrefOffset = pdf.length
  pdf += `xref\n0 5\n0000000000 65535 f \n`
  for (let i = 1; i <= 4; i++) pdf += `${offsets[i].toString().padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

function buildMultiPagePdf(contentStreams: string[]): Uint8Array {
  const pageCount = contentStreams.length
  const pageObjIds = contentStreams.map((_, i) => 3 + i)
  const contentObjIds = contentStreams.map((_, i) => 3 + pageCount + i)

  const objects: string[] = []
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>\nendobj\n`
  pageObjIds.forEach((id, i) => {
    objects[id] = `${id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 2000] /Contents ${contentObjIds[i]} 0 R /Resources << >> >>\nendobj\n`
  })
  contentObjIds.forEach((id, i) => {
    const stream = contentStreams[i]
    objects[id] = `${id} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`
  })

  const totalObjects = 2 + pageCount * 2
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let i = 1; i <= totalObjects; i++) {
    offsets[i] = pdf.length
    pdf += objects[i]
  }
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= totalObjects; i++) pdf += `${offsets[i].toString().padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

interface GeneratedSubpath {
  points: [number, number][]
  closed: boolean
}

// Integer coordinates only, deliberately: keeps content-stream number
// formatting (plain decimal text) and the resulting mm-conversion
// assertions free of PDF-writer rounding/precision edge cases that would
// otherwise be a property of this test's own fixture-building code, not of
// the extractor under test.
const coordArb = fc.integer({ min: -2000, max: 2000 })
const pointArb = fc.tuple(coordArb, coordArb)
const subpathArb: fc.Arbitrary<GeneratedSubpath> = fc.record({
  points: fc.array(pointArb, { minLength: 2, maxLength: 6 }),
  closed: fc.boolean(),
})

function subpathToContentStream(subpath: GeneratedSubpath): string {
  const [first, ...rest] = subpath.points
  const lines = [`${first[0]} ${first[1]} m`, ...rest.map(([x, y]) => `${x} ${y} l`)]
  if (subpath.closed) lines.push('h')
  lines.push('S')
  return lines.join('\n')
}

const PROPERTY_RUNS = 100

describe('extractPdfVectorPaths: property-based round-trip against real PDF content streams (fast-check)', () => {
  test('every generated subpath is extracted with the exact point count, mm-converted coordinates, and closed flag', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(subpathArb, { minLength: 1, maxLength: 4 }), async (subpaths) => {
        const content = subpaths.map(subpathToContentStream).join('\n')
        const pages = await extractPdfVectorPaths(buildMinimalPdf(content))
        const polylines = pages[0]

        expect(polylines).toHaveLength(subpaths.length)
        subpaths.forEach((subpath, i) => {
          const extracted = polylines[i]
          expect(extracted.closed).toBe(subpath.closed)
          expect(extracted.points).toHaveLength(subpath.points.length)
          extracted.points.forEach((p, j) => {
            const [rawX, rawY] = subpath.points[j]
            expect(p.x).toBeCloseTo(rawX * PDF_POINTS_TO_MM, 6)
            expect(p.y).toBeCloseTo(rawY * PDF_POINTS_TO_MM, 6)
          })
        })
      }),
      { numRuns: PROPERTY_RUNS }
    )
  })

  test('drawingScale multiplies every extracted coordinate proportionally (algebraic property, not just internal consistency)', async () => {
    await fc.assert(
      fc.asyncProperty(subpathArb, fc.integer({ min: 1, max: 200 }), async (subpath, scale) => {
        const pdfBytes = buildMinimalPdf(subpathToContentStream(subpath))
        const unscaled = (await extractPdfVectorPaths(pdfBytes))[0][0]
        const scaled = (await extractPdfVectorPaths(pdfBytes, { drawingScale: scale }))[0][0]

        unscaled.points.forEach((p, i) => {
          expect(scaled.points[i].x).toBeCloseTo(p.x * scale, 4)
          expect(scaled.points[i].y).toBeCloseTo(p.y * scale, 4)
        })
      }),
      { numRuns: 50 }
    )
  })

  test('a `cm` translate shifts every extracted point by exactly (dx,dy) converted to mm - verifies real CTM tracking, not just per-point math', async () => {
    await fc.assert(
      fc.asyncProperty(subpathArb, coordArb, coordArb, async (subpath, dx, dy) => {
        const base = subpathToContentStream(subpath)
        const translated = `q\n1 0 0 1 ${dx} ${dy} cm\n${base}\nQ`

        const baseline = (await extractPdfVectorPaths(buildMinimalPdf(base)))[0][0].points
        const shifted = (await extractPdfVectorPaths(buildMinimalPdf(translated)))[0][0].points

        baseline.forEach((p, i) => {
          expect(shifted[i].x).toBeCloseTo(p.x + dx * PDF_POINTS_TO_MM, 6)
          expect(shifted[i].y).toBeCloseTo(p.y + dy * PDF_POINTS_TO_MM, 6)
        })
      }),
      { numRuns: 50 }
    )
  })
})

describe('extractPdfVectorPaths: closed-loop preservation across multiple subpaths in one path', () => {
  test('a path with a closed subpath followed by an open subpath preserves each one\'s closed flag independently', async () => {
    const content = ['0 0 m', '10 0 l', '10 10 l', '0 10 l', 'h', '20 20 m', '30 20 l', 'S'].join('\n')
    const pages = await extractPdfVectorPaths(buildMinimalPdf(content))
    expect(pages[0]).toHaveLength(2)
    expect(pages[0][0].closed).toBe(true)
    expect(pages[0][0].points).toHaveLength(4)
    expect(pages[0][1].closed).toBe(false)
    expect(pages[0][1].points).toHaveLength(2)
  })
})

describe('extractPdfVectorPaths: the `re` rectangle operator decomposes to the same closed 4-point polyline as explicit m/l/h', () => {
  test('re and an equivalent m/l/l/l/h sequence produce identical extracted geometry', async () => {
    const viaRectangle = await extractPdfVectorPaths(buildMinimalPdf('10 10 30 40 re\nf'))
    const viaExplicit = await extractPdfVectorPaths(buildMinimalPdf('10 10 m\n40 10 l\n40 50 l\n10 50 l\nh\nf'))

    expect(viaRectangle[0][0].closed).toBe(true)
    expect(viaRectangle[0][0].points).toEqual(viaExplicit[0][0].points)
  })
})

describe('extractPdfVectorPaths: cubic Bezier curve flattening (moveTo/lineTo/curveTo)', () => {
  test('a curveTo endpoint matches the exact analytic cubic Bezier formula at t=1, and start matches the current point', async () => {
    const content = '0 0 m\n0 10 10 10 10 0 c\nS'
    const pages = await extractPdfVectorPaths(buildMinimalPdf(content))
    const points = pages[0][0].points

    expect(points[0]).toEqual({ x: 0, y: 0 })
    const last = points[points.length - 1]
    expect(last.x).toBeCloseTo(10 * PDF_POINTS_TO_MM, 6)
    expect(last.y).toBeCloseTo(0, 6)
  })

  test('curveSegments controls the flattened point count', async () => {
    const content = '0 0 m\n0 10 10 10 10 0 c\nS'
    const pdfBytes = buildMinimalPdf(content)
    const coarse = (await extractPdfVectorPaths(pdfBytes, { curveSegments: 4 }))[0][0].points
    const fine = (await extractPdfVectorPaths(pdfBytes, { curveSegments: 32 }))[0][0].points

    // +1 for the moveTo point itself, which isn't part of the curve's own segment count.
    expect(coarse).toHaveLength(4 + 1)
    expect(fine).toHaveLength(32 + 1)
  })

  test('the v and y curve shorthand operators are also flattened correctly (both decompose to the same internal curveTo encoding as c)', async () => {
    const viaV = await extractPdfVectorPaths(buildMinimalPdf('0 0 m\n0 0 10 0 v\nS'))
    const viaC = await extractPdfVectorPaths(buildMinimalPdf('0 0 m\n0 0 0 0 10 0 c\nS'))
    expect(viaV[0][0].points).toEqual(viaC[0][0].points)
  })
})

describe('extractPdfVectorPaths: unit normalization', () => {
  test('the default millimetersPerPoint is the exact PDF spec constant (25.4mm / 72 units), not an approximation', async () => {
    const pages = await extractPdfVectorPaths(buildMinimalPdf('0 0 m\n72 0 l\nS'))
    // 72 PDF units is defined as exactly 1 inch.
    expect(pages[0][0].points[1].x).toBeCloseTo(25.4, 9)
  })

  test('an explicit millimetersPerPoint overrides the default entirely', async () => {
    const pages = await extractPdfVectorPaths(buildMinimalPdf('0 0 m\n10 0 l\nS'), { millimetersPerPoint: 1 })
    expect(pages[0][0].points[1].x).toBe(10)
  })
})

describe('extractPdfVectorPaths: multi-page documents', () => {
  test('extracts each page independently, and options.pages selects a subset', async () => {
    const pdfBytes = buildMultiPagePdf(['0 0 m 10 0 l S', '20 20 m 30 20 l S', '40 40 m 50 40 l S'])

    const all = await extractPdfVectorPaths(pdfBytes)
    expect(all).toHaveLength(3)
    expect(all[0][0].points[0]).toEqual({ x: 0, y: 0 })
    expect(all[1][0].points[0].x).toBeCloseTo(20 * PDF_POINTS_TO_MM, 6)

    const subset = await extractPdfVectorPaths(pdfBytes, { pages: [2] })
    expect(subset).toHaveLength(1)
    expect(subset[0][0].points[0].x).toBeCloseTo(20 * PDF_POINTS_TO_MM, 6)
  })
})

describe('extractPdfVectorPaths: fails closed on invalid input rather than returning empty/wrong geometry', () => {
  test('a non-PDF byte stream rejects rather than silently returning an empty result', async () => {
    await expect(extractPdfVectorPaths(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow()
  })

  test('a PDF larger than maxBytes is rejected before any parsing is attempted', async () => {
    const pdfBytes = buildMinimalPdf('0 0 m 10 0 l S')
    await expect(extractPdfVectorPaths(pdfBytes, { maxBytes: 10 })).rejects.toThrow(PdfVectorExtractionError)
  })

  test('requesting a page number that does not exist is rejected', async () => {
    const pdfBytes = buildMinimalPdf('0 0 m 10 0 l S')
    await expect(extractPdfVectorPaths(pdfBytes, { pages: [5] })).rejects.toThrow(PdfVectorExtractionError)
  })
})
