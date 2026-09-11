import { createHash, randomUUID } from 'node:crypto'
import { app } from 'electron'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ExportRequest } from '../types'
import { timelineDuration } from '../segment-time'
import { ffmpegPath } from './binaries'
import { requireFacePack } from './face-pack'
import { jobs } from './jobs'

interface FileStamp {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  dev: number
}

export type FacePreviewRange = readonly [start: number, end: number]

export interface FacePreviewCacheRecord {
  key: string
  range: [number, number]
  outputStamp: FileStamp
  encodingPolicy?: number
}

interface CompletedPreview {
  key: string
  path: string
  outputStamp: FileStamp
  range?: [number, number]
  encodingPolicy?: number
}

let completedPreview: CompletedPreview | undefined

const cacheVersion = 1
const currentEncodingPolicy = 2
const cacheFileName = 'preview.json'
const maximumCacheBytes = 16 * 1024
const rangeTolerance = 0.0001

function cachePath(outputPath: string): string {
  return join(dirname(outputPath), cacheFileName)
}

function fixedPreviewPath(): string | undefined {
  try {
    const userData = app.getPath('userData')
    return userData ? join(userData, 'face-preview', 'preview.mp4') : undefined
  } catch {
    return undefined
  }
}

function requestPaths(request: ExportRequest, pack: { executable: string }): string[] {
  const sourcePaths = request.sources.map((source) => source.metadata.path)
  const overlayPaths = request.overlays
    .filter((overlay) => overlay.type !== 'text')
    .map((overlay) => overlay.path)
  const packDirectory = dirname(pack.executable)
  const worker = basename(pack.executable)
  return [...new Set([
    ...sourcePaths, ...overlayPaths,
    join(packDirectory, 'manifest.json'), join(packDirectory, 'model.xml'), join(packDirectory, 'model.bin'),
    pack.executable, join(packDirectory, `${worker}.bin`)
  ])].sort()
}

async function fileStamp(path: string): Promise<FileStamp | undefined> {
  try {
    const value = await stat(path)
    if (!value.isFile()) return undefined
    return { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, ino: value.ino, dev: value.dev }
  } catch {
    return undefined
  }
}

function sameStamp(left: FileStamp, right: FileStamp): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.ino === right.ino && left.dev === right.dev
}

export async function snapshotFacePreview(request: ExportRequest): Promise<string | undefined> {
  if (!request.faceBlurs?.length) return undefined
  let pack: { executable: string }
  try {
    pack = await requireFacePack()
  } catch {
    return undefined
  }
  const paths = requestPaths(request, pack)
  const stamps = await Promise.all(paths.map(async (path) => ({ path, stamp: await fileStamp(path) })))
  if (stamps.some(({ stamp }) => stamp === undefined)) return undefined
  const serializedRequest = JSON.stringify({ ...request, outputPath: undefined })
  return createHash('sha256').update(serializedRequest).update(JSON.stringify(stamps)).digest('hex')
}

/**
 * Snapshot only the face effects that can affect one rendered range.  A range
 * preview is intentionally independent of disjoint effects so that applying
 * another face range does not invalidate the already-rendered media.
 */
export async function snapshotFacePreviewRange(
  request: ExportRequest,
  range: FacePreviewRange
): Promise<string | undefined> {
  if (!validRange(range)) return undefined
  const faceBlurs = (request.faceBlurs ?? []).filter((effect) => {
    const effectEnd = effect.start + effect.duration
    return effect.start < range[1] && effectEnd > range[0]
  })
  if (faceBlurs.length === 0) return undefined
  return snapshotFacePreview({ ...request, faceBlurs })
}

export function clearFacePreview(): void {
  completedPreview = undefined
}

/** Remove the persisted record before a new render overwrites the fixed output. */
export async function invalidateFacePreview(path = fixedPreviewPath()): Promise<void> {
  completedPreview = undefined
  if (!path) return
  await rm(cachePath(path), { force: true }).catch(() => undefined)
}

function validRange(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false
  const start: unknown = value[0]
  const end: unknown = value[1]
  return typeof start === 'number' && Number.isFinite(start) && start >= 0
    && typeof end === 'number' && Number.isFinite(end) && end > start
}

function validStamp(value: unknown): value is FileStamp {
  if (!value || typeof value !== 'object') return false
  const stamp = value as Partial<FileStamp>
  return typeof stamp.size === 'number' && Number.isSafeInteger(stamp.size) && stamp.size > 0
    && typeof stamp.mtimeMs === 'number' && Number.isFinite(stamp.mtimeMs) && stamp.mtimeMs >= 0
    && typeof stamp.ctimeMs === 'number' && Number.isFinite(stamp.ctimeMs) && stamp.ctimeMs >= 0
    && typeof stamp.ino === 'number' && Number.isSafeInteger(stamp.ino) && stamp.ino >= 0
    && typeof stamp.dev === 'number' && Number.isSafeInteger(stamp.dev) && stamp.dev >= 0
}

function validRecord(value: unknown): value is FacePreviewCacheRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<FacePreviewCacheRecord> & { version?: unknown }
  return record.version === cacheVersion
    && typeof record.key === 'string' && record.key.length > 0 && record.key.length <= 128
    && validRange(record.range) && validStamp(record.outputStamp)
    && (record.encodingPolicy === undefined
      || (Number.isSafeInteger(record.encodingPolicy) && record.encodingPolicy >= 0))
}

function rangeCachePath(path: string): string {
  const name = basename(path)
  return join(dirname(path), name.endsWith('.mp4') ? `${name.slice(0, -4)}.json` : `${name}.json`)
}

async function readPersistedRecord(metadataPath: string): Promise<FacePreviewCacheRecord | undefined> {
  try {
    const metadata = await stat(metadataPath)
    if (!metadata.isFile() || metadata.size > maximumCacheBytes) return undefined
    const text = await readFile(metadataPath, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > maximumCacheBytes) return undefined
    const value: unknown = JSON.parse(text)
    return validRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

async function writePersistedRecord(metadataPath: string, record: FacePreviewCacheRecord): Promise<void> {
  const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(metadataPath), { recursive: true })
    await writeFile(temporaryPath, JSON.stringify({ version: cacheVersion, ...record }), { flag: 'wx' })
    await rename(temporaryPath, metadataPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export async function rememberFacePreview(key: string, path: string, range?: FacePreviewRange): Promise<void> {
  const outputStamp = await fileStamp(path)
  if (!outputStamp) {
    completedPreview = undefined
    return
  }
  const memoryRange = range && validRange(range) ? [...range] as [number, number] : undefined
  completedPreview = { key, path, outputStamp, range: memoryRange, encodingPolicy: currentEncodingPolicy }
  // Keep the historical two-argument API memory-only. Persisted records must
  // carry an explicit range so restart never has to guess the preview scope.
  if (!memoryRange) return
  await writePersistedRecord(cachePath(path), {
    key, range: memoryRange, outputStamp, encodingPolicy: currentEncodingPolicy
  }).catch(() => undefined)
}

export async function loadFacePreview(key: string, path: string): Promise<FacePreviewCacheRecord | undefined> {
  const record = await readPersistedRecord(cachePath(path))
  if (!record || record.key !== key) return undefined
  const outputStamp = await fileStamp(path)
  if (!outputStamp || !sameStamp(outputStamp, record.outputStamp)) return undefined
  return record
}

/** Persist and reload metadata for the immutable range media itself. */
export async function rememberFacePreviewRange(
  key: string,
  path: string,
  range: FacePreviewRange
): Promise<void> {
  if (!validRange(range)) return
  const outputStamp = await fileStamp(path)
  if (!outputStamp) return
  await writePersistedRecord(rangeCachePath(path), {
    key,
    range: [...range] as [number, number],
    outputStamp,
    encodingPolicy: currentEncodingPolicy
  }).catch(() => undefined)
}

export async function loadFacePreviewRange(
  key: string,
  path: string
): Promise<FacePreviewCacheRecord | undefined> {
  const record = await readPersistedRecord(rangeCachePath(path))
  if (!record || record.key !== key) return undefined
  const outputStamp = await fileStamp(path)
  if (!outputStamp || !sameStamp(outputStamp, record.outputStamp)) return undefined
  return record
}

function fullRange(range: FacePreviewRange | undefined, request: ExportRequest): boolean {
  if (!range) return true
  return Math.abs(range[0]) <= rangeTolerance
    && Math.abs(range[1] - timelineDuration(request.segments)) <= rangeTolerance
}

export async function tryReuseFacePreview(
  request: ExportRequest,
  temporaryOutput: string,
  jobId: string,
  duration: number
): Promise<boolean> {
  const key = await snapshotFacePreview(request)
  let record = completedPreview
  if (!record) {
    const path = fixedPreviewPath()
    if (key && path) {
      const persisted = await loadFacePreview(key, path)
      if (persisted) {
        record = { ...persisted, path }
        completedPreview ??= record
      }
    }
  }
  if (!record) return false
  if (record.encodingPolicy !== currentEncodingPolicy) {
    if (completedPreview === record) completedPreview = undefined
    return false
  }
  const currentOutputStamp = await fileStamp(record.path)
  if (!key || key !== record.key || !fullRange(record.range, request)
    || !currentOutputStamp || !sameStamp(currentOutputStamp, record.outputStamp)) {
    if (completedPreview === record) completedPreview = undefined
    return false
  }
  await jobs.run(ffmpegPath(), [
    '-hide_banner', '-y', '-i', record.path, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', temporaryOutput
  ], 'export', duration, jobId, 'Reusing completed face preview', { phase: 'finalizing' })
  const afterKey = await snapshotFacePreview(request)
  const afterOutputStamp = await fileStamp(record.path)
  if (completedPreview !== record || afterKey !== key || !afterOutputStamp || !sameStamp(afterOutputStamp, record.outputStamp)) {
    if (completedPreview === record) completedPreview = undefined
    return false
  }
  return true
}
