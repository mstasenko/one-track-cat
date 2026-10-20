import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, open, rm, link } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AiModelDownloadPhase, AiModelDownloadProgress } from '../types'

import { isObject, normalizeArtifact, normalizeArtifacts, modelManifestArtifacts,
  type ModelArtifact, type ModelManifest, type NormalizedArtifact } from './model-download-schema'
export { parseModelManifest, readModelManifest, modelArtifactDestination, modelManifestArtifacts } from './model-download-schema'
export type { ModelArtifact, ModelManifestArtifact, ModelManifest } from './model-download-schema'

export type ModelDownloadPhase = AiModelDownloadPhase
export type ModelDownloadProgress = AiModelDownloadProgress

export type ModelDownloadProgressCallback = (progress: ModelDownloadProgress) => void

export type ModelArtifactDownloader = (
  artifacts: readonly ModelArtifact[],
  signal: AbortSignal,
  onProgress?: ModelDownloadProgressCallback
) => Promise<void> | void

const MAX_VERIFIED_ARTIFACTS = 256

const verifiedArtifactMemo = new Set<string>()

class OversizedPartError extends Error {
  constructor() {
    super('The response exceeded the pinned artifact size')
    this.name = 'OversizedPartError'
  }
}

interface ProgressTrackerOptions {
  readonly name: string
  readonly total: number
  readonly phase: ModelDownloadPhase
  readonly initial: number
  readonly callback?: ModelDownloadProgressCallback
}

export function progressMetrics(
  downloadedBytes: number,
  totalBytes: number,
  started: bigint,
  transferredBytes: number
): Pick<ModelDownloadProgress, 'downloadedBytes' | 'totalBytes' | 'percent' | 'bytesPerSecond' | 'etaSeconds'> {
  const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000
  const bytesPerSecond = transferredBytes > 0 && elapsed > 0 ? transferredBytes / elapsed : null
  const etaSeconds = bytesPerSecond && downloadedBytes < totalBytes
    ? (totalBytes - downloadedBytes) / bytesPerSecond
    : downloadedBytes >= totalBytes ? 0 : null
  return {
    downloadedBytes,
    totalBytes,
    percent: Math.min(100, Math.max(0, downloadedBytes / totalBytes * 100)),
    bytesPerSecond,
    etaSeconds
  }
}

class ProgressTracker {
  private readonly started = process.hrtime.bigint()
  private readonly initial: number
  private readonly options: ProgressTrackerOptions
  private last = -1

  constructor(options: ProgressTrackerOptions) {
    this.options = options
    this.initial = options.initial
  }

  emit(downloaded: number, force = false): void {
    if (!this.options.callback || (!force && downloaded === this.last)) return
    this.last = downloaded
    const transferred = Math.max(0, downloaded - this.initial)
    this.options.callback({
      name: this.options.name,
      phase: this.options.phase,
      ...progressMetrics(downloaded, this.options.total, this.started, transferred)
    })
  }
}

function abortError(): Error {
  const error = new Error('Model download cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

async function existingPath(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function artifactIdentityKey(info: Awaited<ReturnType<typeof lstat>>): string {
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
}

function verificationKey(artifact: NormalizedArtifact, info: Awaited<ReturnType<typeof lstat>>): string {
  return JSON.stringify([
    artifact.destination,
    artifact.bytes,
    artifact.sha256,
    info.dev,
    info.ino,
    info.size,
    info.mtimeMs,
    info.ctimeMs
  ])
}

function rememberVerifiedArtifact(key: string): void {
  verifiedArtifactMemo.add(key)
  if (verifiedArtifactMemo.size > MAX_VERIFIED_ARTIFACTS) {
    const oldest = verifiedArtifactMemo.values().next().value
    if (oldest !== undefined) verifiedArtifactMemo.delete(oldest)
  }
}

async function removePart(path: string): Promise<void> {
  const info = await existingPath(path)
  if (!info) return
  if (info.isDirectory()) throw new Error('The model partial path is a directory')
  await rm(path, { force: true })
}

async function hashFile(
  path: string,
  artifact: NormalizedArtifact,
  signal: AbortSignal,
  callback?: ModelDownloadProgressCallback
): Promise<boolean> {
  const tracker = new ProgressTracker({
    name: artifact.name,
    total: artifact.bytes,
    phase: 'verifying',
    initial: 0,
    callback
  })
  tracker.emit(0, true)
  throwIfAborted(signal)
  const hash = createHash('sha256')
  let bytes = 0
  const stream = createReadStream(path)
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal)
      const data = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)
      bytes += data.byteLength
      if (bytes > artifact.bytes) return false
      hash.update(data)
      tracker.emit(bytes)
    }
  } finally {
    stream.destroy()
  }
  if (bytes !== artifact.bytes) return false
  tracker.emit(bytes, true)
  throwIfAborted(signal)
  return hash.digest('hex') === artifact.sha256
}

async function verifyFinalArtifact(
  artifact: NormalizedArtifact,
  info: Awaited<ReturnType<typeof lstat>>,
  signal: AbortSignal,
  callback?: ModelDownloadProgressCallback
): Promise<boolean> {
  if (!info.isFile() || info.size !== artifact.bytes) return false
  throwIfAborted(signal)
  const key = verificationKey(artifact, info)
  if (verifiedArtifactMemo.has(key)) return true
  if (!await hashFile(artifact.destination, artifact, signal, callback)) return false
  const current = await existingPath(artifact.destination)
  if (!current || !current.isFile() || artifactIdentityKey(info) !== artifactIdentityKey(current)) return false
  rememberVerifiedArtifact(verificationKey(artifact, current))
  return true
}

function parseIntegerHeader(value: string, header: string): number {
  const trimmed = value.trim()
  if (!/^(?:0|[1-9]\d*)$/u.test(trimmed)) throw new Error(`Invalid ${header} header`)
  const number = Number(trimmed)
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${header} header`)
  return number
}

function responseContentLength(response: Response): number | undefined {
  const value = response.headers.get('content-length')
  return value === null ? undefined : parseIntegerHeader(value, 'Content-Length')
}

function responseWriteOffset(response: Response, offset: number, artifact: NormalizedArtifact): number {
  if (!response.ok) throw new Error(`Model download returned HTTP ${response.status}`)
  if (offset > 0) {
    if (response.status === 200) {
      const contentLength = responseContentLength(response)
      if (contentLength !== undefined && contentLength !== artifact.bytes) {
        throw new Error('The restart response has a misleading Content-Length')
      }
      return 0
    }
    if (response.status !== 206) throw new Error(`Model range request returned HTTP ${response.status}`)
    const contentRange = response.headers.get('content-range')
    const match = contentRange?.trim().match(/^bytes (\d+)-(\d+)\/(\d+)$/u)
    if (!match) throw new Error('The range response has an invalid Content-Range')
    const [startText, endText, totalText] = match.slice(1)
    if (!startText || !endText || !totalText) throw new Error('The range response has an invalid Content-Range')
    const start = parseIntegerHeader(startText, 'Content-Range')
    const end = parseIntegerHeader(endText, 'Content-Range')
    const total = parseIntegerHeader(totalText, 'Content-Range')
    if (start !== offset || end !== artifact.bytes - 1 || total !== artifact.bytes) {
      throw new Error('The range response has a misleading Content-Range')
    }
    const contentLength = responseContentLength(response)
    if (contentLength !== undefined && contentLength !== artifact.bytes - offset) {
      throw new Error('The range response has a misleading Content-Length')
    }
    return offset
  }
  if (response.status === 206) throw new Error('Unexpected partial response without a range request')
  const contentLength = responseContentLength(response)
  if (contentLength !== undefined && contentLength !== artifact.bytes) {
    throw new Error('The response has a misleading Content-Length')
  }
  return 0
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  throwIfAborted(signal)
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      // Wait for cancellation to settle the pending read before its lock is
      // released by the caller.
      void reader.cancel().then(
        () => reject(abortError()),
        () => reject(abortError())
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then((result) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }, (error: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, data: Uint8Array): Promise<void> {
  let written = 0
  while (written < data.byteLength) {
    const result = await file.write(data, written, data.byteLength - written)
    if (result.bytesWritten <= 0) throw new Error('The model partial write made no progress')
    written += result.bytesWritten
  }
}

async function copyResponse(
  response: Response,
  path: string,
  offset: number,
  artifact: NormalizedArtifact,
  signal: AbortSignal,
  expectedPart: Awaited<ReturnType<typeof lstat>> | undefined,
  callback?: ModelDownloadProgressCallback
): Promise<void> {
  if (!response.body) throw new Error('The model response has an empty body')
  const tracker = new ProgressTracker({
    name: artifact.name,
    total: artifact.bytes,
    phase: 'downloading',
    initial: offset,
    callback
  })
  tracker.emit(offset, true)
  throwIfAborted(signal)
  // Never follow a substituted partial or truncate before validating its descriptor.
  // Exclusive creation also rejects a file inserted while fetch was pending.
  const flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
    (expectedPart ? constants.O_APPEND : constants.O_CREAT | constants.O_EXCL)
  const file = await open(path, flags, 0o600)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 ||
        (expectedPart && artifactIdentityKey(info) !== artifactIdentityKey(expectedPart)))
      throw new Error('The model partial changed before opening')
    if (offset === 0 && expectedPart) await file.truncate(0)
  } catch (error) {
    await file.close()
    throw error
  }
  const reader = response.body.getReader()
  let received = 0
  let madeProgress = false
  try {
    for (;;) {
      const result = await readChunk(reader, signal)
      if (result.done) break
      const data = result.value
      if (data.byteLength === 0) continue
      if (offset + received + data.byteLength > artifact.bytes) throw new OversizedPartError()
      await writeAll(file, data)
      received += data.byteLength
      madeProgress = true
      tracker.emit(offset + received)
    }
    if (!madeProgress) throw new Error('The model response made no progress')
    if (offset + received !== artifact.bytes) throw new Error('The model response ended before the pinned size')
    await file.sync()
  } finally {
    reader.releaseLock()
    await file.close()
  }
  tracker.emit(artifact.bytes, true)
}

async function publishPart(partPath: string, destination: string): Promise<void> {
  const destinationInfo = await existingPath(destination)
  if (destinationInfo) throw new Error('The model destination is already occupied')
  // A same-directory hard link publishes without the overwrite semantics of rename(2).
  // Removing the deterministic part after linking leaves one atomic, verified final file.
  try {
    await link(partPath, destination)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error('The model destination is already occupied')
    }
    throw error
  }
  await rm(partPath, { force: true })
}

async function downloadOne(
  artifact: NormalizedArtifact,
  signal: AbortSignal,
  callback?: ModelDownloadProgressCallback
): Promise<void> {
  throwIfAborted(signal)
  await mkdir(dirname(artifact.destination), { recursive: true })
  const finalInfo = await existingPath(artifact.destination)
  if (finalInfo) {
    if (!finalInfo.isFile()) throw new Error('The model destination is already occupied')
    if (await verifyFinalArtifact(artifact, finalInfo, signal, callback)) {
      throwIfAborted(signal)
      return
    }
    throw new Error('The occupied model destination does not match the pinned artifact')
  }

  const partPath = `${artifact.destination}.part`
  let partInfo = await existingPath(partPath)
  if (partInfo) {
    if (!partInfo.isFile()) throw new Error('The model partial path is not a regular file')
    if (partInfo.size > artifact.bytes) {
      await removePart(partPath)
      partInfo = undefined
    } else if (partInfo.size === artifact.bytes) {
      if (await hashFile(partPath, artifact, signal, callback)) {
        await publishPart(partPath, artifact.destination)
        return
      }
      await removePart(partPath)
      partInfo = undefined
    }
  }

  const offset = partInfo ? Number(partInfo.size) : 0
  throwIfAborted(signal)
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined
  const response = await fetch(artifact.url, { headers, signal })
  throwIfAborted(signal)
  const writeOffset = responseWriteOffset(response, offset, artifact)
  try {
    await copyResponse(response, partPath, writeOffset, artifact, signal, partInfo, callback)
  } catch (error) {
    if (error instanceof OversizedPartError) await removePart(partPath)
    throw error
  }
  if (!await hashFile(partPath, artifact, signal, callback)) {
    await removePart(partPath)
    throw new Error('The downloaded model does not match the pinned SHA-256')
  }
  throwIfAborted(signal)
  await publishPart(partPath, artifact.destination)
}

/** Return true only for a complete, hash-matching final file (never a .part file). */
export async function isModelArtifactComplete(
  artifact: ModelArtifact,
  signal: AbortSignal = new AbortController().signal
): Promise<boolean> {
  const normalized = normalizeArtifact(artifact)
  const info = await existingPath(normalized.destination)
  if (!info) return false
  return verifyFinalArtifact(normalized, info, signal)
}

export async function missingModelArtifactBytes(
  artifacts: readonly ModelArtifact[],
  signal: AbortSignal = new AbortController().signal
): Promise<number> {
  const normalized = normalizeArtifacts(artifacts)
  let missing = 0
  for (const artifact of normalized) {
    throwIfAborted(signal)
    if (!await isModelArtifactComplete(artifact, signal)) missing += artifact.bytes
  }
  return missing
}

export async function downloadModelArtifacts(
  artifacts: readonly ModelArtifact[],
  signal: AbortSignal,
  onProgress?: ModelDownloadProgressCallback
): Promise<void> {
  if (!isObject(signal) || typeof signal.aborted !== 'boolean') throw new Error('A valid AbortSignal is required')
  const normalized = normalizeArtifacts(artifacts)
  for (const artifact of normalized) await downloadOne(artifact, signal, onProgress)
}

/** Install missing files in order; progress uses aggregate missing bytes for a stable bar and ETA. */
export async function downloadModelManifest(
  manifest: ModelManifest,
  root: string,
  signal: AbortSignal,
  onProgress?: ModelDownloadProgressCallback,
  downloader: ModelArtifactDownloader = downloadModelArtifacts
): Promise<void> {
  const artifacts = modelManifestArtifacts(manifest, root)
  const pending: ModelArtifact[] = []
  for (const artifact of artifacts) {
    throwIfAborted(signal)
    if (!await isModelArtifactComplete(artifact, signal)) pending.push(artifact)
  }
  if (pending.length === 0) return

  const totalBytes = pending.reduce((sum, artifact) => sum + artifact.bytes, 0)
  const started = process.hrtime.bigint()
  let completedBytes = 0
  let transferredBytes = 0
  let lastDownloaded = -1
  let lastPhase: ModelDownloadPhase | undefined
  const emit = (name: string, phase: ModelDownloadPhase, downloadedBytes: number): void => {
    if (!onProgress) return
    const downloaded = Math.min(totalBytes, Math.max(0, downloadedBytes))
    if (downloaded === lastDownloaded && phase === lastPhase) return
    lastDownloaded = downloaded
    lastPhase = phase
    onProgress({
      name,
      phase,
      ...progressMetrics(downloaded, totalBytes, started, transferredBytes)
    })
  }

  for (const artifact of pending) {
    throwIfAborted(signal)
    let artifactDownloaded = 0
    let lastArtifactTransfer: number | undefined
    await downloader([artifact], signal, (progress) => {
      if (progress.phase === 'downloading') {
        if (lastArtifactTransfer === undefined) {
          // The first byte count may include a .part prefix from an earlier run.
          lastArtifactTransfer = progress.downloadedBytes
        } else {
          transferredBytes += Math.max(0, progress.downloadedBytes - lastArtifactTransfer)
          lastArtifactTransfer = progress.downloadedBytes
        }
      }
      artifactDownloaded = Math.max(artifactDownloaded, progress.downloadedBytes)
      emit(artifact.name, progress.phase, completedBytes + artifactDownloaded)
    })
    completedBytes += artifact.bytes
    emit(artifact.name, 'verifying', completedBytes)
  }
}
