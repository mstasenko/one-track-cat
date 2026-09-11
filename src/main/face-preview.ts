import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ExportRequest, FacePreviewResult } from '../types'
import { timelineDuration } from '../segment-time'
import { exportVideo } from './exporter'
import { requireFacePack } from './face-pack'
import {
  invalidateFacePreview,
  loadFacePreviewRange,
  rememberFacePreview,
  rememberFacePreviewRange,
  snapshotFacePreview,
  snapshotFacePreviewRange
} from './face-preview-cache'
import { mediaUrl } from './media-protocol'
import type { SessionPathRegistry } from './path-registry'
import { validatedPreviewRange } from './preview-range'

let rendering = false

const rangeTolerance = 0.0001
const maximumRangePreviews = 128

function fullPreviewRange(request: ExportRequest): [number, number] {
  return [0, timelineDuration(request.segments)]
}

function outputPathForRange(directory: string, request: ExportRequest, range: readonly [number, number]): string {
  const startFrame = Math.round(range[0] * request.canvas.fps)
  const endFrame = Math.round(range[1] * request.canvas.fps)
  return join(directory, `preview-${startFrame}-${endFrame}.mp4`)
}

async function publishLatestPreview(outputPath: string, latestPath: string): Promise<boolean> {
  if (outputPath === latestPath) return true
  const temporaryPath = `${latestPath}.${randomUUID()}.tmp`
  try {
    // Keep each range file's inode and ctime unchanged; a hard link would make
    // replacing this alias invalidate its saved full-file stamp. A symlink avoids copying media.
    await symlink(basename(outputPath), temporaryPath)
    await rename(temporaryPath, latestPath)
    return true
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    return false
  }
}

function hasFaceEffectInRange(request: ExportRequest, range: readonly [number, number]): boolean {
  return (request.faceBlurs ?? []).some((effect) => {
    const effectEnd = effect.start + effect.duration
    return effect.start < range[1] && effectEnd > range[0]
  })
}

function validStoredRange(
  value: readonly [number, number],
  request: ExportRequest
): [number, number] | undefined {
  const [start, end] = value
  const duration = timelineDuration(request.segments)
  const fps = request.canvas.fps
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return undefined
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0) return undefined
  if (start >= duration) return undefined
  const timelineEnd = Math.ceil(duration * fps) / fps
  if (end > timelineEnd + rangeTolerance) return undefined
  return [start, end]
}

interface RangePreviewCandidate {
  path: string
  startFrame: number
  endFrame: number
  modifiedAt: number
}

function rangeFrames(name: string): [number, number] | undefined {
  const match = /^preview-(\d+)-(\d+)\.mp4$/.exec(name)
  if (!match) return undefined
  const startFrame = Number(match[1])
  const endFrame = Number(match[2])
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || endFrame <= startFrame) return undefined
  return [startFrame, endFrame]
}

async function rangePreviewCandidates(directory: string): Promise<RangePreviewCandidate[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map(async (entry): Promise<RangePreviewCandidate | undefined> => {
        const frames = rangeFrames(entry.name)
        if (!frames) return undefined
        const path = join(directory, entry.name)
        try {
          const metadata = await stat(path)
          if (!metadata.isFile()) return undefined
          return { path, startFrame: frames[0], endFrame: frames[1], modifiedAt: metadata.mtimeMs }
        } catch {
          return undefined
        }
      }))
    return candidates
      .filter((candidate): candidate is RangePreviewCandidate => candidate !== undefined)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
  } catch {
    return []
  }
}

async function pruneRangePreviews(candidates: RangePreviewCandidate[]): Promise<void> {
  // A valid project has at most 100 non-overlapping face ranges, so entries
  // beyond this larger bound cannot still be active previews.
  await Promise.all(candidates.slice(maximumRangePreviews).flatMap(({ path }) => [
    rm(path, { force: true }),
    rm(`${path.slice(0, -4)}.json`, { force: true })
  ])).catch(() => undefined)
}

function rangeMatchesFrames(range: readonly [number, number], startFrame: number, endFrame: number, fps: number): boolean {
  return Math.round(range[0] * fps) === startFrame && Math.round(range[1] * fps) === endFrame
}

export async function previewFaces(
  value: unknown,
  paths: SessionPathRegistry,
  trustedExport: (request: unknown, registry: SessionPathRegistry) => Promise<ExportRequest>
): Promise<string> {
  if (rendering) throw new Error('A face preview is already being rendered')
  rendering = true
  try {
    await requireFacePack()
    if (!value || typeof value !== 'object') throw new Error('Invalid preview request')
    const directory = join(app.getPath('userData'), 'face-preview')
    await mkdir(directory, { recursive: true })
    const latestPath = await paths.allowWrite(join(directory, 'preview.mp4'))
    const input = value as Record<string, unknown>
    const trustedRequest = await trustedExport({ ...input, outputPath: latestPath }, paths)
    const range = validatedPreviewRange(input.previewRange, trustedRequest)
    const storedRange = range ?? fullPreviewRange(trustedRequest)
    const outputPath = await paths.allowWrite(outputPathForRange(directory, trustedRequest, storedRange))
    const request = { ...trustedRequest, outputPath }
    if (!request.faceBlurs?.length) throw new Error('Apply a Blur faces effect before previewing')
    const key = await snapshotFacePreview(request)
    const rangeKey = await snapshotFacePreviewRange(request, storedRange)
    await invalidateFacePreview(latestPath)
    if (range) await exportVideo(request, range)
    else await exportVideo(request)
    if (key && rangeKey && (!range || hasFaceEffectInRange(request, range))) {
      const completedKey = await snapshotFacePreview(request)
      const completedRangeKey = await snapshotFacePreviewRange(request, storedRange)
      if (completedKey === key && completedRangeKey === rangeKey && await publishLatestPreview(outputPath, latestPath)) {
        await rememberFacePreview(key, latestPath, storedRange)
        await rememberFacePreviewRange(rangeKey, outputPath, storedRange)
        await pruneRangePreviews(await rangePreviewCandidates(directory))
      }
    }
    return `${mediaUrl(await paths.allowRead(outputPath))}?preview=${randomUUID()}`
  } finally {
    rendering = false
  }
}

export async function restoreFaces(
  value: unknown,
  paths: SessionPathRegistry,
  trustedExport: (request: unknown, registry: SessionPathRegistry) => Promise<ExportRequest>
): Promise<FacePreviewResult[]> {
  if (!value || typeof value !== 'object') return []
  try {
    const directory = join(app.getPath('userData'), 'face-preview')
    const outputPath = await paths.allowWrite(join(directory, 'preview.mp4'))
    const request = { ...(await trustedExport({ ...(value as Record<string, unknown>), outputPath }, paths)), outputPath }
    if (!request.faceBlurs?.length) return []
    const restored: FacePreviewResult[] = []
    for (const candidate of (await rangePreviewCandidates(directory)).slice(0, maximumRangePreviews)) {
      const fps = request.canvas.fps
      const fileRange = validStoredRange([candidate.startFrame / fps, candidate.endFrame / fps], request)
      if (!fileRange || !rangeMatchesFrames(fileRange, candidate.startFrame, candidate.endFrame, fps)) continue
      const key = await snapshotFacePreviewRange(request, fileRange)
      if (!key) continue
      const record = await loadFacePreviewRange(key, candidate.path)
      if (!record) continue
      const range = validStoredRange(record.range, request)
      if (!range || !rangeMatchesFrames(range, candidate.startFrame, candidate.endFrame, fps)
        || outputPathForRange(directory, request, range) !== candidate.path) continue
      restored.push({ url: `${mediaUrl(await paths.allowRead(candidate.path))}?preview=${randomUUID()}`, start: range[0], end: range[1] })
    }
    return restored
  } catch {
    return []
  }
}
