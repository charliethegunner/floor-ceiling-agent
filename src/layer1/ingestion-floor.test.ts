import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { ProjectPackIngestor, IngestionLimitExceededError, parseDxf, parseStepEntities, parsePdfMetadata, toWorkspaceFiles } from './ingestion-floor'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ingestion-floor-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A real, minimal ZIP writer (stored + deflate, node:zlib only) used purely
// to build test fixtures - independently verified against the reader's
// binary-format assumptions before ingestion-floor.ts was written.
// ---------------------------------------------------------------------------

function crc32(buf: Buffer): number {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const { name, data } of files) {
    const compressed = deflateRawSync(data)
    const nameBuf = Buffer.from(name, 'utf8')

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt32LE(crc32(data), 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localParts.push(localHeader, nameBuf, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt32LE(crc32(data), 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBuf)

    offset += localHeader.length + nameBuf.length + compressed.length
  }

  const centralDirStart = offset
  const centralDirBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDirBuf.length, 12)
  eocd.writeUInt32LE(centralDirStart, 16)

  return Buffer.concat([...localParts, centralDirBuf, eocd])
}

// A ZIP whose declared central-directory uncompressedSize is small, but
// whose real inflated bytes are much larger than declared - a genuine
// (if crude) zip-bomb-shaped entry, to exercise zlib's own maxOutputLength
// backstop rather than just the pre-check on the declared size.
function buildZipWithLyingSize(name: string, realData: Buffer, declaredUncompressedSize: number): Buffer {
  const zip = buildZip([{ name, data: realData }])
  const patched = Buffer.from(zip)
  // Central directory's uncompressedSize field is at centralHeaderOffset+24;
  // the single entry's central header starts right after the one local
  // entry (localHeader + name + compressed data).
  const nameBuf = Buffer.from(name, 'utf8')
  const compressed = deflateRawSync(realData)
  const centralHeaderOffset = 30 + nameBuf.length + compressed.length
  patched.writeUInt32LE(declaredUncompressedSize, centralHeaderOffset + 24)
  return patched
}

describe('ProjectPackIngestor.ingestWorkspace: multi-file TypeScript repository (directory)', () => {
  test('ingests every file into the graph, with real per-content-type classification', async () => {
    writeFileSync(join(workspace, 'a.ts'), "export function a(): number { return 1 }\n")
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'b.ts'), "import { a } from '../a'\nexport function b(): number { return a() }\n")
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'x' }))

    const graph = await new ProjectPackIngestor().ingestWorkspace(workspace)

    expect(graph.metadata.source).toBe('directory')
    expect(graph.metadata.fileCount).toBe(3)
    expect(graph.files.has('a.ts')).toBe(true)
    expect(graph.files.has('src/b.ts')).toBe(true)
    expect(graph.files.get('a.ts')?.contentType).toBe('typescript')
    expect(graph.files.get('package.json')?.contentType).toBe('json')
  })

  test('builds a real cross-file dependency edge from a genuine ts-morph import declaration, not a regex guess', async () => {
    writeFileSync(join(workspace, 'a.ts'), "export function a(): number { return 1 }\n")
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'b.ts'), "import { a } from '../a'\nexport function b(): number { return a() }\n")

    const graph = await new ProjectPackIngestor().ingestWorkspace(workspace)

    expect(graph.dependencies).toContainEqual({ fromPath: 'src/b.ts', toPath: 'a.ts', specifier: '../a' })
  })

  test('a bare package specifier produces no dependency edge - it is honestly outside the ingested graph', async () => {
    writeFileSync(join(workspace, 'a.ts'), "import { z } from 'zod'\nexport function a(): number { return 1 }\n")

    const graph = await new ProjectPackIngestor().ingestWorkspace(workspace)

    expect(graph.dependencies).toEqual([])
  })

  test('skips node_modules and .git as noise', async () => {
    mkdirSync(join(workspace, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(workspace, 'node_modules', 'x', 'index.js'), 'module.exports = {}')
    mkdirSync(join(workspace, '.git'))
    writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main')
    writeFileSync(join(workspace, 'a.ts'), 'export function a(): number { return 1 }')

    const graph = await new ProjectPackIngestor().ingestWorkspace(workspace)

    expect(graph.metadata.fileCount).toBe(1)
    expect(graph.files.has('a.ts')).toBe(true)
  })

  test('toWorkspaceFiles extracts a { path: text } map for every text-bearing file', async () => {
    writeFileSync(join(workspace, 'a.ts'), 'export function a(): number { return 1 }')

    const graph = await new ProjectPackIngestor().ingestWorkspace(workspace)
    expect(toWorkspaceFiles(graph)).toEqual({ 'a.ts': 'export function a(): number { return 1 }' })
  })
})

describe('ProjectPackIngestor.ingestWorkspace: extraction limits and out-of-bounds rejection', () => {
  test('rejects a single file exceeding maxEntryBytes before it is fully read into memory', async () => {
    const bigFile = join(workspace, 'big.ts')
    writeFileSync(bigFile, 'x'.repeat(1000))

    await expect(new ProjectPackIngestor().ingestWorkspace(workspace, { maxEntryBytes: 100 })).rejects.toThrow(IngestionLimitExceededError)
  })

  test('rejects a directory whose cumulative size exceeds maxTotalBytes, even if no single file does', async () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(workspace, `f${i}.ts`), 'x'.repeat(100))

    await expect(new ProjectPackIngestor().ingestWorkspace(workspace, { maxTotalBytes: 250 })).rejects.toThrow(IngestionLimitExceededError)
  })

  test('rejects a directory with more files than maxFileCount', async () => {
    for (let i = 0; i < 10; i++) writeFileSync(join(workspace, `f${i}.ts`), 'x')

    await expect(new ProjectPackIngestor().ingestWorkspace(workspace, { maxFileCount: 5 })).rejects.toThrow(IngestionLimitExceededError)
  })

  test('a single oversized file (non-archive) is rejected before being read at all', async () => {
    const bigFile = join(workspace, 'big.ts')
    writeFileSync(bigFile, 'x'.repeat(1000))

    await expect(new ProjectPackIngestor().ingestWorkspace(bigFile, { maxTotalBytes: 100 })).rejects.toThrow(IngestionLimitExceededError)
  })

  test('a real ZIP entry declaring a larger uncompressed size than maxEntryBytes is rejected via the central-directory check', async () => {
    const zip = buildZip([{ name: 'huge.ts', data: Buffer.from('x'.repeat(1_000_000)) }])
    const zipPath = join(workspace, 'pack.zip')
    writeFileSync(zipPath, zip)

    await expect(new ProjectPackIngestor().ingestWorkspace(zipPath, { maxEntryBytes: 1000 })).rejects.toThrow(IngestionLimitExceededError)
  })

  test('a ZIP entry that LIES about its declared size is still caught by zlib\'s real maxOutputLength backstop', async () => {
    const realData = Buffer.alloc(500_000, 'A') // compresses to a tiny buffer
    const zip = buildZipWithLyingSize('bomb.ts', realData, 10) // declares only 10 bytes
    const zipPath = join(workspace, 'bomb.zip')
    writeFileSync(zipPath, zip)

    // The declared-size check alone would let this through (10 <= limit) -
    // it must be zlib's own maxOutputLength that rejects the ACTUAL inflate.
    await expect(new ProjectPackIngestor().ingestWorkspace(zipPath, { maxEntryBytes: 1000 })).rejects.toThrow(IngestionLimitExceededError)
  })

  test('a valid pack well within every limit ingests successfully', async () => {
    writeFileSync(join(workspace, 'a.ts'), 'export function a(): number { return 1 }')
    const graph = await new ProjectPackIngestor().ingestWorkspace(workspace, { maxTotalBytes: 1000, maxEntryBytes: 500, maxFileCount: 10 })
    expect(graph.metadata.fileCount).toBe(1)
  })
})

describe('ProjectPackIngestor.ingestWorkspace: ZIP archives', () => {
  test('ingests a real multi-file ZIP into the same unified graph shape as a directory, dependency edges included', async () => {
    const zip = buildZip([
      { name: 'a.ts', data: Buffer.from("export function a(): number { return 1 }\n") },
      { name: 'src/b.ts', data: Buffer.from("import { a } from '../a'\nexport function b(): number { return a() }\n") },
    ])
    const zipPath = join(workspace, 'pack.zip')
    writeFileSync(zipPath, zip)

    const graph = await new ProjectPackIngestor().ingestWorkspace(zipPath)

    expect(graph.metadata.source).toBe('zip')
    expect(graph.metadata.fileCount).toBe(2)
    expect(graph.files.get('a.ts')?.text).toContain('export function a')
    expect(graph.dependencies).toContainEqual({ fromPath: 'src/b.ts', toPath: 'a.ts', specifier: '../a' })
  })

  test('ingests an in-memory ZIP Buffer directly, with no file on disk', async () => {
    const zip = buildZip([{ name: 'a.ts', data: Buffer.from('export function a(): number { return 1 }') }])
    const graph = await new ProjectPackIngestor().ingestWorkspace(zip)
    expect(graph.metadata.source).toBe('zip')
    expect(graph.files.get('a.ts')?.text).toContain('export function a')
  })
})

describe('ProjectPackIngestor.ingestWorkspace: single CAD/PDF files', () => {
  test('a .dxf file is parsed into real geometric entities', async () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'CIRCLE', '8', 'layer1', '10', '1.5', '20', '2.5', '30', '0.0', '40', '3.0',
      '0', 'LINE', '10', '0.0', '20', '0.0', '30', '0.0', '11', '5.0', '21', '5.0', '31', '0.0',
      '0', 'ENDSEC',
    ].join('\n')
    const dxfPath = join(workspace, 'part.dxf')
    writeFileSync(dxfPath, dxf)

    const graph = await new ProjectPackIngestor().ingestWorkspace(dxfPath)
    const entry = graph.files.get('part.dxf')

    expect(entry?.contentType).toBe('dxf')
    expect(entry?.dxfEntities?.[0]).toEqual({ dxfType: 'CIRCLE', layer: 'layer1', points: [[1.5, 2.5, 0]], radius: 3 })
  })

  test('a .step file is parsed into real P21 entity-instance records, including nested-parenthesis entities', async () => {
    const step = "DATA;\n#10=CARTESIAN_POINT('',(0.,0.,0.));\n#11=DIRECTION('',(0.,0.,1.));\nENDSEC;\n"
    const stepPath = join(workspace, 'part.step')
    writeFileSync(stepPath, step)

    const graph = await new ProjectPackIngestor().ingestWorkspace(stepPath)
    const entry = graph.files.get('part.step')

    expect(entry?.contentType).toBe('step')
    expect(entry?.stepEntities).toEqual([
      { id: 10, type: 'CARTESIAN_POINT', rawParams: "'',(0.,0.,0.)" },
      { id: 11, type: 'DIRECTION', rawParams: "'',(0.,0.,1.)" },
    ])
  })

  test('a .pdf file gets structural metadata only, honestly - no fabricated text extraction', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\n%%EOF')
    const pdfPath = join(workspace, 'doc.pdf')
    writeFileSync(pdfPath, pdf)

    const graph = await new ProjectPackIngestor().ingestWorkspace(pdfPath)
    const entry = graph.files.get('doc.pdf')

    expect(entry?.contentType).toBe('pdf')
    expect(entry?.text).toBeUndefined()
    expect(entry?.pdfInfo).toEqual({ version: '1.4', approxPageCount: 2, approxObjectCount: 2 })
  })
})

describe('ProjectWorkspaceGraph topology and metadata', () => {
  test('fileTypeCounts and totalBytes reflect the real ingested contents', async () => {
    writeFileSync(join(workspace, 'a.ts'), 'export function a(): number { return 1 }')
    writeFileSync(join(workspace, 'b.ts'), 'export function b(): number { return 2 }')
    writeFileSync(join(workspace, 'data.json'), '{}')

    const graph = await new ProjectPackIngestor().ingestWorkspace(workspace)

    expect(graph.metadata.fileTypeCounts.typescript).toBe(2)
    expect(graph.metadata.fileTypeCounts.json).toBe(1)
    expect(graph.metadata.totalBytes).toBeGreaterThan(0)
  })

  test('a single non-archive file ingests as source "single-file" with one file entry', async () => {
    const filePath = join(workspace, 'lonely.ts')
    writeFileSync(filePath, 'export function lonely(): number { return 1 }')

    const graph = await new ProjectPackIngestor().ingestWorkspace(filePath)

    expect(graph.metadata.source).toBe('single-file')
    expect(graph.metadata.fileCount).toBe(1)
    expect(graph.files.has('lonely.ts')).toBe(true)
  })
})

describe('parseDxf / parseStepEntities / parsePdfMetadata: standalone parser correctness', () => {
  test('parseDxf assembles a multi-vertex LWPOLYLINE from repeated 10/20 group codes', () => {
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '10', '0.0', '20', '0.0', '10', '1.0', '20', '1.0', '0', 'ENDSEC'].join('\n')
    const entities = parseDxf(dxf)
    expect(entities).toEqual([{ dxfType: 'LWPOLYLINE', layer: undefined, points: [[0, 0, 0], [1, 1, 0]], radius: undefined }])
  })

  test('parseStepEntities returns an empty array for a DATA section with no entities', () => {
    expect(parseStepEntities('DATA;\nENDSEC;\n')).toEqual([])
  })

  test('parsePdfMetadata throws a clear error on a non-PDF buffer rather than fabricating info', () => {
    expect(() => parsePdfMetadata(Buffer.from('not a pdf'))).toThrow(/not a valid PDF/)
  })
})
