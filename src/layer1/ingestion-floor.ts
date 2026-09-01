import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { Project } from 'ts-morph'

// Phase 12.0: Sandboxed Project-Pack Ingestion Floor - parses a directory,
// a ZIP archive, or a single CAD/PDF/code file into one unified,
// DECLARATIVE ProjectWorkspaceGraph. "Parse candidate data, never candidate
// code" applies here exactly as it does everywhere else in this project:
// every format below is read into structured records via a real, bounded
// parser (ZIP's own binary format, DXF's group-code pairs, STEP's P21
// entity-instance syntax, ts-morph's TypeScript AST) - nothing here ever
// eval()s, requires(), or executes anything extracted from a pack.
//
// Two formats are DELIBERATELY only partially parsed, to avoid the kind of
// theater this project has refused elsewhere (see action-floor.ts's refusal
// to fabricate a fake ".step" export):
//   - STEP (ISO 10303-21): only the P21 entity-instance structure (id, type
//     name, raw parameter text) is extracted. No B-rep/NURBS geometric
//     interpretation is attempted - that needs a real EXPRESS-schema kernel
//     this project doesn't have.
//   - PDF: only structural metadata (version, an approximate page count via
//     counting "/Type /Page" occurrences, an approximate object count via
//     counting "endobj") is extracted via a raw byte scan. No text/content
//     extraction is attempted - that needs real stream/filter decoding
//     (FlateDecode, cross-reference parsing, font encoding) this project
//     doesn't have.
//
// Memory safety: every entry point enforces maxTotalBytes/maxEntryBytes/
// maxFileCount BEFORE the corresponding bytes are held in memory - a
// directory walk checks fs.statSync per file before reading it, and ZIP
// extraction checks the central directory's DECLARED uncompressed size
// before inflating, then backstops that declaration with zlib's own
// maxOutputLength (a real zip-bomb guard: a malicious entry that lies about
// its declared size still can't inflate past the cap - verified against
// Node's actual RangeError/ERR_BUFFER_TOO_LARGE behavior before this was
// written).

// ---------------------------------------------------------------------------
// Workspace graph types
// ---------------------------------------------------------------------------

export type WorkspaceContentType = 'typescript' | 'json' | 'dxf' | 'step' | 'pdf' | 'other'

export interface DxfEntity {
  dxfType: string
  layer?: string
  /** Assembled from this entity's 10/20/30 group-code triples, in order (z defaults to 0 when code 30 is absent, as is standard for 2D DXF). */
  points: Array<[number, number, number]>
  /** Present only when this entity carries a group code 40 (radius). */
  radius?: number
}

export interface StepEntityInstance {
  id: number
  type: string
  /** The raw, unparsed text between this entity's outer parentheses - see the header comment for why this project doesn't interpret STEP geometry. */
  rawParams: string
}

export interface PdfInfo {
  version: string
  approxPageCount: number
  approxObjectCount: number
}

export interface WorkspaceFileEntry {
  path: string
  sizeBytes: number
  contentType: WorkspaceContentType
  /** Present for text-classified content (typescript/json/dxf/step and any "other" file that looks like text). */
  text?: string
  dxfEntities?: DxfEntity[]
  stepEntities?: StepEntityInstance[]
  pdfInfo?: PdfInfo
}

export interface DependencyEdge {
  fromPath: string
  toPath: string
  specifier: string
}

export interface ProjectWorkspaceGraph {
  files: Map<string, WorkspaceFileEntry>
  dependencies: DependencyEdge[]
  metadata: {
    source: 'directory' | 'zip' | 'single-file'
    totalBytes: number
    fileCount: number
    fileTypeCounts: Partial<Record<WorkspaceContentType, number>>
  }
}

export interface IngestOptions {
  /** Total uncompressed bytes across every file in the pack. Default 50MB. */
  maxTotalBytes?: number
  /** Bytes for any single file/entry. Defaults to maxTotalBytes. */
  maxEntryBytes?: number
  /** Entry/file count across the whole pack. Default 5000. */
  maxFileCount?: number
}

const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_FILE_COUNT = 5000

export class IngestionLimitExceededError extends Error {
  constructor(
    readonly limitKind: 'totalBytes' | 'entryBytes' | 'fileCount',
    readonly limit: number,
    readonly attempted: number,
    readonly atPath?: string
  ) {
    super(`ingestion aborted: ${limitKind} limit exceeded (attempted ${attempted}, limit ${limit})${atPath ? ` at "${atPath}"` : ''}`)
    this.name = 'IngestionLimitExceededError'
  }
}

interface ResolvedLimits {
  maxTotalBytes: number
  maxEntryBytes: number
  maxFileCount: number
}

function resolveLimits(options: IngestOptions): ResolvedLimits {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  return {
    maxTotalBytes,
    maxEntryBytes: options.maxEntryBytes ?? maxTotalBytes,
    maxFileCount: options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT,
  }
}

// ---------------------------------------------------------------------------
// Per-format content parsers - all pure functions over already-bounded
// buffers/text, no I/O.
// ---------------------------------------------------------------------------

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000)
  return !sample.includes(0)
}

// DXF: a real ASCII group-code/value parser (ISO/CAD's plain-text
// interchange format - alternating "code" line then "value" line). Multi-
// vertex codes (10/20/30 can repeat, e.g. LWPOLYLINE) are collected as
// parallel arrays and zipped into points in buildDxfEntity.
function parseDxfGroupPairs(text: string): Array<[number, string]> {
  const lines = text.split(/\r\n|\r|\n/)
  const pairs: Array<[number, string]> = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10)
    if (Number.isNaN(code)) continue
    pairs.push([code, lines[i + 1].trim()])
  }
  return pairs
}

interface RawDxfEntity {
  dxfType: string
  layer?: string
  fields: Map<number, string[]>
}

function buildDxfEntity(raw: RawDxfEntity): DxfEntity {
  const xs = raw.fields.get(10) ?? []
  const ys = raw.fields.get(20) ?? []
  const zs = raw.fields.get(30) ?? []
  const points: Array<[number, number, number]> = xs.map((x, i) => [Number.parseFloat(x), Number.parseFloat(ys[i] ?? '0'), Number.parseFloat(zs[i] ?? '0')])
  const radiusValues = raw.fields.get(40)
  return { dxfType: raw.dxfType, layer: raw.layer, points, radius: radiusValues ? Number.parseFloat(radiusValues[0]) : undefined }
}

export function parseDxf(text: string): DxfEntity[] {
  const pairs = parseDxfGroupPairs(text)
  const entities: DxfEntity[] = []
  let inEntitiesSection = false
  let current: RawDxfEntity | null = null

  const flush = (): void => {
    if (current) entities.push(buildDxfEntity(current))
    current = null
  }

  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i]
    if (code === 0) {
      if (value === 'SECTION' && pairs[i + 1]?.[0] === 2 && pairs[i + 1][1] === 'ENTITIES') {
        inEntitiesSection = true
        continue
      }
      if (value === 'ENDSEC') {
        flush()
        inEntitiesSection = false
        continue
      }
      if (inEntitiesSection) {
        flush()
        current = { dxfType: value, fields: new Map() }
        continue
      }
    }
    if (inEntitiesSection && current) {
      if (code === 8) current.layer = value
      const bucket = current.fields.get(code) ?? []
      bucket.push(value)
      current.fields.set(code, bucket)
    }
  }
  flush()
  return entities
}

// STEP (ISO 10303-21): extracts the P21 entity-instance structure
// (#id=TYPE(params);) from the DATA section via depth-counted paren
// matching (a naive non-greedy regex breaks on any entity with nested
// tuples, e.g. CARTESIAN_POINT('',(0.,0.,0.)), which is extremely common).
// Known limitation: does not account for parentheses inside quoted STEP
// strings, a rare but real edge case this scope doesn't handle.
export function parseStepEntities(text: string): StepEntityInstance[] {
  const dataMatch = /DATA;([\s\S]*?)ENDSEC;/.exec(text)
  const dataSection = dataMatch ? dataMatch[1] : text
  const entities: StepEntityInstance[] = []
  const idPattern = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(/g

  let match: RegExpExecArray | null
  while ((match = idPattern.exec(dataSection)) !== null) {
    const parenStart = idPattern.lastIndex - 1
    let depth = 1
    let i = parenStart + 1
    for (; i < dataSection.length && depth > 0; i++) {
      if (dataSection[i] === '(') depth++
      else if (dataSection[i] === ')') depth--
    }
    entities.push({ id: Number.parseInt(match[1], 10), type: match[2], rawParams: dataSection.slice(parenStart + 1, i - 1).trim() })
    idPattern.lastIndex = i
  }
  return entities
}

// PDF: structural metadata only, via a raw byte scan - see the header
// comment for why real text extraction is out of scope.
export function parsePdfMetadata(buffer: Buffer): PdfInfo {
  const head = buffer.subarray(0, 1024).toString('latin1')
  const versionMatch = /%PDF-(\d\.\d)/.exec(head)
  if (!versionMatch) throw new Error('not a valid PDF: missing %PDF- header')
  const text = buffer.toString('latin1')
  return {
    version: versionMatch[1],
    approxPageCount: (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length,
    approxObjectCount: (text.match(/\bendobj\b/g) ?? []).length,
  }
}

function classifyAndParseFile(path: string, buffer: Buffer, limits: ResolvedLimits): WorkspaceFileEntry {
  if (buffer.length > limits.maxEntryBytes) {
    throw new IngestionLimitExceededError('entryBytes', limits.maxEntryBytes, buffer.length, path)
  }

  const ext = extname(path).toLowerCase()
  const sizeBytes = buffer.length

  if (ext === '.ts' || ext === '.tsx') {
    return { path, sizeBytes, contentType: 'typescript', text: buffer.toString('utf8') }
  }
  if (ext === '.json') {
    return { path, sizeBytes, contentType: 'json', text: buffer.toString('utf8') }
  }
  if (ext === '.dxf') {
    const text = buffer.toString('utf8')
    return { path, sizeBytes, contentType: 'dxf', text, dxfEntities: parseDxf(text) }
  }
  if (ext === '.step' || ext === '.stp') {
    const text = buffer.toString('utf8')
    return { path, sizeBytes, contentType: 'step', text, stepEntities: parseStepEntities(text) }
  }
  if (ext === '.pdf') {
    return { path, sizeBytes, contentType: 'pdf', pdfInfo: parsePdfMetadata(buffer) }
  }
  return looksLikeText(buffer) ? { path, sizeBytes, contentType: 'other', text: buffer.toString('utf8') } : { path, sizeBytes, contentType: 'other' }
}

// ---------------------------------------------------------------------------
// Dependency graph: real ts-morph AST import/export-declaration extraction
// (never a regex-guessed import), resolved against the ingested files map.
// Only relative specifiers ('./x', '../x') are resolved - a bare package
// specifier ('react') correctly produces no edge, since it isn't part of
// this pack's own graph, not a fabricated one.
// ---------------------------------------------------------------------------

function normalizeRelativePath(path: string): string {
  const stack: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

function resolveSpecifier(fromPath: string, specifier: string, files: Map<string, WorkspaceFileEntry>): string | null {
  if (!specifier.startsWith('.')) return null
  const lastSlash = fromPath.lastIndexOf('/')
  const base = lastSlash === -1 ? '' : fromPath.slice(0, lastSlash)
  const resolved = normalizeRelativePath(base ? `${base}/${specifier}` : specifier)
  for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`, `${resolved}/index.tsx`]) {
    if (files.has(candidate)) return candidate
  }
  return null
}

function buildDependencyGraph(files: Map<string, WorkspaceFileEntry>): DependencyEdge[] {
  const tsFiles = [...files.values()].filter((f) => f.contentType === 'typescript' && f.text !== undefined)
  if (tsFiles.length === 0) return []

  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } })
  for (const file of tsFiles) project.createSourceFile(file.path, file.text)

  const edges: DependencyEdge[] = []
  for (const file of tsFiles) {
    const sourceFile = project.getSourceFileOrThrow(file.path)
    const specifiers = [
      ...sourceFile.getImportDeclarations().map((d) => d.getModuleSpecifierValue()),
      ...sourceFile.getExportDeclarations().map((d) => d.getModuleSpecifierValue()).filter((s): s is string => s !== undefined),
    ]
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(file.path, specifier, files)
      if (resolved) edges.push({ fromPath: file.path, toPath: resolved, specifier })
    }
  }
  return edges
}

function finalizeGraph(files: Map<string, WorkspaceFileEntry>, source: ProjectWorkspaceGraph['metadata']['source']): ProjectWorkspaceGraph {
  const fileTypeCounts: Partial<Record<WorkspaceContentType, number>> = {}
  let totalBytes = 0
  for (const file of files.values()) {
    fileTypeCounts[file.contentType] = (fileTypeCounts[file.contentType] ?? 0) + 1
    totalBytes += file.sizeBytes
  }
  return {
    files,
    dependencies: buildDependencyGraph(files),
    metadata: { source, totalBytes, fileCount: files.size, fileTypeCounts },
  }
}

// ---------------------------------------------------------------------------
// ZIP: a real, minimal reader for the PKZIP central-directory format
// (stored + deflate methods), using only node:zlib for decompression -
// verified against a real hand-built archive and against zlib's actual
// maxOutputLength error shape before this was written (see header comment).
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
const MAX_ZIP_COMMENT_LENGTH = 65535

interface ZipCentralDirEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

function isZipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_FILE_SIGNATURE
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const searchStart = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_ZIP_COMMENT_LENGTH)
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  throw new Error('not a valid ZIP archive: end of central directory record not found')
}

function parseCentralDirectory(buffer: Buffer): ZipCentralDirEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer)
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
  let offset = buffer.readUInt32LE(eocdOffset + 16)

  const entries: ZipCentralDirEntry[] = []
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`not a valid ZIP archive: malformed central directory entry at offset ${offset}`)
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntryData(buffer: Buffer, entry: ZipCentralDirEntry, maxOutputBytes: number): Buffer {
  const offset = entry.localHeaderOffset
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`not a valid ZIP archive: malformed local file header for "${entry.name}"`)
  }
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLength + extraLength
  const compressedData = buffer.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.method === 0) return compressedData // stored, no compression
  if (entry.method !== 8) {
    throw new Error(`unsupported ZIP compression method ${entry.method} for "${entry.name}" (only stored/deflate are supported)`)
  }
  return inflateRawSync(compressedData, { maxOutputLength: maxOutputBytes })
}

// ---------------------------------------------------------------------------
// Directory walk - real fs traversal, symlinks never followed (a symlink
// could otherwise escape the sandboxed workspace root or create a cycle),
// node_modules/.git skipped as noise, every file size-checked via
// fs.statSync BEFORE it is read into memory.
// ---------------------------------------------------------------------------

const SKIPPED_DIR_NAMES = new Set(['node_modules', '.git'])

function walkDirectory(root: string, limits: ResolvedLimits): Array<{ path: string; buffer: Buffer }> {
  const results: Array<{ path: string; buffer: Buffer }> = []
  let totalBytes = 0

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (SKIPPED_DIR_NAMES.has(entry.name)) continue
        visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue

      if (results.length >= limits.maxFileCount) {
        throw new IngestionLimitExceededError('fileCount', limits.maxFileCount, results.length + 1)
      }

      const size = statSync(fullPath).size
      if (size > limits.maxEntryBytes) {
        throw new IngestionLimitExceededError('entryBytes', limits.maxEntryBytes, size, fullPath)
      }
      totalBytes += size
      if (totalBytes > limits.maxTotalBytes) {
        throw new IngestionLimitExceededError('totalBytes', limits.maxTotalBytes, totalBytes, fullPath)
      }

      results.push({ path: relative(root, fullPath).split(sep).join('/'), buffer: readFileSync(fullPath) })
    }
  }

  visit(root)
  return results
}

// ---------------------------------------------------------------------------
// ProjectPackIngestor
// ---------------------------------------------------------------------------

export class ProjectPackIngestor {
  async ingestWorkspace(targetPathOrBuffer: string | Buffer, options: IngestOptions = {}): Promise<ProjectWorkspaceGraph> {
    const limits = resolveLimits(options)

    if (Buffer.isBuffer(targetPathOrBuffer)) {
      if (targetPathOrBuffer.length > limits.maxTotalBytes) {
        throw new IngestionLimitExceededError('totalBytes', limits.maxTotalBytes, targetPathOrBuffer.length)
      }
      if (isZipBuffer(targetPathOrBuffer)) return this.ingestZipBuffer(targetPathOrBuffer, limits)
      return finalizeGraph(new Map([['candidate', classifyAndParseFile('candidate', targetPathOrBuffer, limits)]]), 'single-file')
    }

    const stat = statSync(targetPathOrBuffer)
    if (stat.isDirectory()) {
      return finalizeGraph(
        new Map(walkDirectory(targetPathOrBuffer, limits).map(({ path, buffer }) => [path, classifyAndParseFile(path, buffer, limits)])),
        'directory'
      )
    }

    if (stat.size > limits.maxTotalBytes) {
      throw new IngestionLimitExceededError('totalBytes', limits.maxTotalBytes, stat.size, targetPathOrBuffer)
    }
    const buffer = readFileSync(targetPathOrBuffer)
    const name = basename(targetPathOrBuffer)
    if (isZipBuffer(buffer)) return this.ingestZipBuffer(buffer, limits)
    return finalizeGraph(new Map([[name, classifyAndParseFile(name, buffer, limits)]]), 'single-file')
  }

  private ingestZipBuffer(buffer: Buffer, limits: ResolvedLimits): ProjectWorkspaceGraph {
    const centralDirEntries = parseCentralDirectory(buffer).filter((e) => !e.name.endsWith('/'))
    if (centralDirEntries.length > limits.maxFileCount) {
      throw new IngestionLimitExceededError('fileCount', limits.maxFileCount, centralDirEntries.length)
    }

    const files = new Map<string, WorkspaceFileEntry>()
    let totalBytes = 0
    for (const entry of centralDirEntries) {
      if (entry.uncompressedSize > limits.maxEntryBytes) {
        throw new IngestionLimitExceededError('entryBytes', limits.maxEntryBytes, entry.uncompressedSize, entry.name)
      }
      totalBytes += entry.uncompressedSize
      if (totalBytes > limits.maxTotalBytes) {
        throw new IngestionLimitExceededError('totalBytes', limits.maxTotalBytes, totalBytes, entry.name)
      }

      const remainingBudget = limits.maxTotalBytes - (totalBytes - entry.uncompressedSize)
      let data: Buffer
      try {
        data = readZipEntryData(buffer, entry, Math.min(limits.maxEntryBytes, remainingBudget))
      } catch (error) {
        // A real zip-bomb: the entry's DECLARED size passed the check above,
        // but the actual inflated output tried to exceed the byte budget
        // anyway. Node's zlib reports this as RangeError/ERR_BUFFER_TOO_LARGE
        // (verified directly before writing this code) - re-surfaced as our
        // own limit error; anything else (e.g. a genuinely corrupt entry) is
        // NOT a size problem and is left to propagate as-is.
        if (error instanceof RangeError && (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new IngestionLimitExceededError('entryBytes', limits.maxEntryBytes, entry.uncompressedSize, entry.name)
        }
        throw error
      }

      const path = entry.name.split('\\').join('/')
      files.set(path, classifyAndParseFile(path, data, limits))
    }
    return finalizeGraph(files, 'zip')
  }
}

/** Extracts { path: text } for every text-bearing file - the shape needed by worker-pool-worker.ts's 'topology' task to give a candidate wider repository context (see WorkerVerifyTask.workspaceFiles). */
export function toWorkspaceFiles(graph: ProjectWorkspaceGraph): Record<string, string> {
  const result: Record<string, string> = {}
  for (const file of graph.files.values()) {
    if (file.text !== undefined) result[file.path] = file.text
  }
  return result
}
