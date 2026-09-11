import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { app } from 'electron'
import { dirname, join } from 'node:path'
import type { ExportRequest, FaceBlurEffect } from '../types'
import { ffmpegPath } from './binaries'
import { captureCacheStream, detectionCacheMaximumBytes } from './face-detection-stream'
import { snapshotFacePreview } from './face-preview-cache'

export { detectionCacheMaximumBytes }

const cacheDirectoryName = 'face-preview'
const cacheFileName = 'detections.cache'
const cacheMetadataFileName = 'detections.cache.json'
const maximumMetadataBytes = 64 * 1024
const detectionCacheMetadataVersion = 1 as const

interface FileStamp {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  dev: number
}

interface DetectionCacheRecord {
  baseKey: string
  path: string
  stamp: FileStamp
  frameRanges: [number, number][]
  policies: DetectionPolicyInterval[]
}

interface PersistedDetectionCacheRecord {
  version: typeof detectionCacheMetadataVersion
  baseKey: string
  stamp: FileStamp
  frameRanges: [number, number][]
  policies: DetectionPolicyInterval[]
}

interface DetectionPolicyInterval {
  start: number
  end: number
  sensitivity: number
  detail: FaceBlurEffect['detail']
}

interface DetectionCacheIdentity {
  baseKey: string
  policies: DetectionPolicyInterval[]
}

export interface FaceDetectionCacheSession {
  workerArgs: string[]
  hasCompleteDetections?: boolean
  onWorkerStderr?: (stream: Readable) => Promise<void>
  commit: () => Promise<void>
  cleanup: () => Promise<void>
}

let cacheRecord: DetectionCacheRecord | undefined

function userDataPath(): string | undefined {
  try {
    const path = app.getPath('userData')
    return path || undefined
  } catch {
    return undefined
  }
}

export function faceDetectionCachePath(): string | undefined {
  const userData = userDataPath()
  return userData ? join(userData, cacheDirectoryName, cacheFileName) : undefined
}

export function clearFaceDetectionCache(): void {
  cacheRecord = undefined
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

function cacheMetadataPath(path: string): string {
  return join(dirname(path), cacheMetadataFileName)
}

function validFileStamp(value: unknown): value is FileStamp {
  if (!value || typeof value !== 'object') return false
  const stamp = value as Record<string, unknown>
  const size = stamp.size
  const mtimeMs = stamp.mtimeMs
  const ctimeMs = stamp.ctimeMs
  const ino = stamp.ino
  const dev = stamp.dev
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= detectionCacheMaximumBytes
    && typeof mtimeMs === 'number' && Number.isFinite(mtimeMs) && mtimeMs >= 0
    && typeof ctimeMs === 'number' && Number.isFinite(ctimeMs) && ctimeMs >= 0
    && typeof ino === 'number' && Number.isSafeInteger(ino) && ino >= 0
    && typeof dev === 'number' && Number.isSafeInteger(dev) && dev >= 0
}

function validFrameRanges(value: unknown): value is [number, number][] {
  if (!Array.isArray(value) || value.length > 1024) return false
  const ranges = value as unknown[]
  let previousEnd = -1
  for (const item of ranges) {
    if (!Array.isArray(item) || item.length !== 2) return false
    const pair = item as unknown[]
    const start = pair[0]
    const end = pair[1]
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0
      || typeof end !== 'number' || !Number.isSafeInteger(end) || end <= start
      || start < previousEnd) return false
    previousEnd = end
  }
  return true
}

function validPolicy(value: unknown): value is DetectionPolicyInterval {
  if (!value || typeof value !== 'object') return false
  const policy = value as Record<string, unknown>
  const start = policy.start
  const end = policy.end
  const sensitivity = policy.sensitivity
  const detail = policy.detail
  return typeof start === 'number' && Number.isSafeInteger(start) && start >= 0
    && typeof end === 'number' && Number.isSafeInteger(end) && end > start
    && typeof sensitivity === 'number' && Number.isFinite(sensitivity)
    && sensitivity >= 0 && sensitivity <= 1
    && (detail === 'standard' || detail === 'small')
}

function validPolicies(value: unknown): value is DetectionPolicyInterval[] {
  return Array.isArray(value) && value.length <= 100 && value.every(validPolicy)
}

function validPersistedRecord(value: unknown): value is PersistedDetectionCacheRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const version = record.version
  const baseKey = record.baseKey
  return version === detectionCacheMetadataVersion
    && typeof baseKey === 'string' && /^[0-9a-f]{64}$/.test(baseKey)
    && validFileStamp(record.stamp)
    && validFrameRanges(record.frameRanges)
    && validPolicies(record.policies)
}

async function readPersistedCacheRecord(path: string): Promise<DetectionCacheRecord | undefined> {
  try {
    const metadataPath = cacheMetadataPath(path)
    const metadataStamp = await stat(metadataPath)
    if (!metadataStamp.isFile() || metadataStamp.size > maximumMetadataBytes) return undefined
    const text = await readFile(metadataPath, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > maximumMetadataBytes) return undefined
    const value: unknown = JSON.parse(text)
    if (!validPersistedRecord(value)) return undefined
    const cacheStamp = await fileStamp(path)
    if (!cacheStamp || !sameStamp(cacheStamp, value.stamp)) return undefined
    return {
      baseKey: value.baseKey,
      path,
      stamp: value.stamp,
      frameRanges: value.frameRanges,
      policies: value.policies
    }
  } catch {
    return undefined
  }
}

async function writePersistedCacheRecord(path: string, record: DetectionCacheRecord): Promise<void> {
  const metadataPath = cacheMetadataPath(path)
  const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`
  const metadata: PersistedDetectionCacheRecord = {
    version: detectionCacheMetadataVersion,
    baseKey: record.baseKey,
    stamp: record.stamp,
    frameRanges: record.frameRanges,
    policies: record.policies
  }
  const serialized = JSON.stringify(metadata)
  if (Buffer.byteLength(serialized, 'utf8') > maximumMetadataBytes) throw new Error('Detection cache metadata is too large')
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, metadataPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

const cacheIdentityFaceEffect: FaceBlurEffect = {
  id: 'cache-identity',
  start: 0,
  duration: 0.0001,
  sensitivity: 0.5,
  detail: 'standard',
  holdSeconds: 0,
  strength: 0,
  style: 'blur'
}

function baseIdentityRequest(request: ExportRequest): ExportRequest {
  return {
    ...request,
    faceBlurs: [cacheIdentityFaceEffect]
  }
}

function detectionPolicyIntervals(request: ExportRequest): DetectionPolicyInterval[] {
  const fps = request.canvas.fps
  return (request.faceBlurs ?? []).map((effect) => ({
    start: Math.ceil(effect.start * fps),
    end: Math.ceil((effect.start + effect.duration) * fps),
    sensitivity: effect.sensitivity,
    detail: effect.detail
  })).sort((left, right) => left.start - right.start || left.end - right.end
    || left.sensitivity - right.sensitivity || left.detail.localeCompare(right.detail))
}

async function cacheIdentity(request: ExportRequest): Promise<DetectionCacheIdentity | undefined> {
  try {
    const previewKey = await snapshotFacePreview(baseIdentityRequest(request))
    const workerStamp = await fileStamp(ffmpegPath())
    if (!previewKey || !workerStamp) return undefined
    return {
      baseKey: createHash('sha256').update(previewKey).update(JSON.stringify(workerStamp)).digest('hex'),
      policies: detectionPolicyIntervals(request)
    }
  } catch {
    return undefined
  }
}

function samePolicy(left: DetectionPolicyInterval | undefined, right: DetectionPolicyInterval | undefined): boolean {
  if (!left || !right) return left === right
  return left.start === right.start && left.end === right.end
    && left.sensitivity === right.sensitivity && left.detail === right.detail
}

function policyAtFrame(policies: DetectionPolicyInterval[], frame: number): DetectionPolicyInterval | undefined {
  return policies.find((policy) => policy.start <= frame && frame < policy.end)
}

function compatibleFrameRange(
  [start, stop]: [number, number],
  oldPolicies: DetectionPolicyInterval[],
  newPolicies: DetectionPolicyInterval[]
): boolean {
  const boundaries = [start, stop]
  for (const policy of [...oldPolicies, ...newPolicies]) {
    if (policy.start > start && policy.start < stop) boundaries.push(policy.start)
    if (policy.end > start && policy.end < stop) boundaries.push(policy.end)
  }
  boundaries.sort((left, right) => left - right)
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const frame = boundaries[index]
    if (frame === undefined) return false
    if (!samePolicy(policyAtFrame(oldPolicies, frame), policyAtFrame(newPolicies, frame))) return false
  }
  return true
}

function compatibleCachedRanges(
  ranges: [number, number][],
  oldPolicies: DetectionPolicyInterval[],
  newPolicies: DetectionPolicyInterval[]
): boolean {
  return ranges.every((range) => compatibleFrameRange(range, oldPolicies, newPolicies))
}

function samePolicies(left: DetectionPolicyInterval[], right: DetectionPolicyInterval[]): boolean {
  return left.length === right.length && left.every((policy, index) => samePolicy(policy, right[index]))
}

async function copyPreviousCache(
  path: string,
  jobDirectory: string,
  identity: DetectionCacheIdentity
): Promise<{ path: string; frameRanges: [number, number][] } | undefined> {
  let record = cacheRecord
  if (!record) {
    record = await readPersistedCacheRecord(path)
    if (record) cacheRecord = record
  }
  if (!record || record.baseKey !== identity.baseKey || record.path !== path
    || !compatibleCachedRanges(record.frameRanges, record.policies, identity.policies)) return undefined
  const before = await fileStamp(record.path)
  if (!before || !sameStamp(before, record.stamp)) return undefined
  const inputPath = join(jobDirectory, 'input.cache')
  try {
    await copyFile(record.path, inputPath, constants.COPYFILE_FICLONE)
    const after = await fileStamp(record.path)
    if (!after || !sameStamp(before, after)) {
      await rm(inputPath, { force: true })
      return undefined
    }
    return { path: inputPath, frameRanges: record.frameRanges }
  } catch {
    await rm(inputPath, { force: true }).catch(() => undefined)
    return undefined
  }
}

function coversFaceEffects(ranges: [number, number][], request: ExportRequest): boolean {
  const effects = request.faceBlurs ?? []
  return effects.length > 0 && effects.every((effect) => {
    const first = Math.ceil(effect.start * request.canvas.fps)
    const end = Math.ceil((effect.start + effect.duration) * request.canvas.fps)
    return ranges.some(([start, stop]) => start <= first && stop >= end)
  })
}

function noCacheSession(): FaceDetectionCacheSession {
  return {
    workerArgs: [],
    commit: () => Promise.resolve(),
    cleanup: () => Promise.resolve()
  }
}

export async function prepareFaceDetectionCache(
  sourceRequest: ExportRequest,
  frameOffset: number
): Promise<FaceDetectionCacheSession> {
  if (!sourceRequest.faceBlurs?.length || !Number.isSafeInteger(frameOffset) || frameOffset < 0) return noCacheSession()
  const path = faceDetectionCachePath()
  const identity = await cacheIdentity(sourceRequest)
  if (!path || !identity) return noCacheSession()
  const directory = dirname(path)
  let jobDirectory: string
  try {
    await mkdir(directory, { recursive: true })
    jobDirectory = await mkdtemp(join(directory, 'detections-job-'))
  } catch {
    return noCacheSession()
  }

  const input = await copyPreviousCache(path, jobDirectory, identity)
  const outputPath = join(jobDirectory, 'output.cache')
  let captureUsable = false
  let captureFinished = false
  let frameRanges: [number, number][] = []
  let cleaned = false
  const workerArgs = [
    ...(input ? ['--detections-cache', input.path] : []),
    '--emit-detections', '--frame-offset', String(frameOffset)
  ]
  const onWorkerStderr = async (stream: Readable): Promise<void> => {
    captureFinished = false
    await captureCacheStream(stream, outputPath, (usable, ranges) => {
      captureUsable = usable
      frameRanges = ranges
      captureFinished = true
    })
  }
  const commit = async (): Promise<void> => {
    if (!captureFinished || !captureUsable || cleaned) return
    let replaced = false
    try {
      const currentIdentity = await cacheIdentity(sourceRequest)
      if (!currentIdentity || currentIdentity.baseKey !== identity.baseKey
        || !samePolicies(currentIdentity.policies, identity.policies)) return
      const outputStamp = await fileStamp(outputPath)
      if (!outputStamp || outputStamp.size > detectionCacheMaximumBytes) return
      await rename(outputPath, path)
      replaced = true
      const stamp = await fileStamp(path)
      if (!stamp) throw new Error('Detection cache disappeared after commit')
      const nextRecord = { baseKey: identity.baseKey, path, stamp, frameRanges, policies: currentIdentity.policies }
      await writePersistedCacheRecord(path, nextRecord)
      cacheRecord = nextRecord
    } catch {
      if (replaced) {
        cacheRecord = undefined
        await rm(cacheMetadataPath(path), { force: true }).catch(() => undefined)
      }
      // Cache persistence is best effort; the completed export remains authoritative.
    }
  }
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
  return { workerArgs, hasCompleteDetections: coversFaceEffects(input?.frameRanges ?? [], sourceRequest), onWorkerStderr, commit, cleanup }
}
