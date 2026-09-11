import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { AssetMetadata, MediaMetadata } from '../types'
import { ffmpegPath, ffprobePath } from './binaries'
import { jobs } from './jobs'

const execFileAsync = promisify(execFile)
const waveformCache = new Map<string, Promise<number[]>>()
const proxyJobs = new Map<string, Promise<string>>()
let proxyQueue: Promise<void> = Promise.resolve()
let proxyClosed = false
const PROXY_SHUTDOWN_MESSAGE = 'Proxy generation cancelled during shutdown'
// Preserve short-range detail without sending raw PCM across IPC.
const MAX_WAVEFORM_PEAKS = 50_000
const MAX_WAVEFORM_CACHE_ENTRIES = 32
interface ProbeStream {
  codec_type: 'video' | 'audio'
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  tags?: { rotate?: string }
  side_data_list?: { rotation?: number }[]
}

interface ProbeResult {
  format: { duration?: string; size?: string; filename?: string }
  streams: ProbeStream[]
}

function parseRate(rate?: string): number {
  if (!rate || rate === '0/0') return 0
  const [numerator, denominator] = rate.split('/').map(Number)
  if (!numerator || !denominator) return 0
  return numerator / denominator
}

async function readProbe(path: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    ffprobePath(),
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
    { maxBuffer: 16 * 1024 * 1024 }
  )
  return JSON.parse(stdout) as ProbeResult
}

function stream(result: ProbeResult, type: ProbeStream['codec_type']): ProbeStream | undefined {
  return result.streams.find((item) => item.codec_type === type)
}

export function firstPositiveNumber(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

export function firstFrameRate(...values: unknown[]): number {
  for (const value of values) {
    const parsed = parseRate(typeof value === 'string' ? value : undefined)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

export function proxyVideoFilter(): string {
  return 'scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2'
}

export function proxyArgs(
  metadata: Pick<MediaMetadata, 'path' | 'fps'>,
  temporaryPath: string
): string[] {
  const frameRate = metadata.fps > 0 ? Math.max(24, Math.round(metadata.fps)) : 30
  return [
    '-hide_banner',
    '-y',
    '-threads',
    '2',
    '-i',
    metadata.path,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-filter_threads',
    '4',
    '-vf',
    proxyVideoFilter(),
    '-c:v',
    'libx264',
    '-threads',
    '4',
    '-preset',
    'ultrafast',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(frameRate),
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    temporaryPath
  ]
}

function rotationOf(video: ProbeStream): number {
  const sideData = video.side_data_list?.find((item) => typeof item.rotation === 'number')
  for (const value of [sideData?.rotation, video.tags?.rotate]) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

export function displayDimensions(width: number, height: number, rotation: number): {
  width: number
  height: number
} {
  const normalized = ((Math.round(rotation) % 360) + 360) % 360
  return normalized === 90 || normalized === 270
    ? { width: height, height: width }
    : { width, height }
}

export async function probeMedia(path: string): Promise<MediaMetadata> {
  const result = await readProbe(path)
  const video = stream(result, 'video')
  if (!video) throw new Error('This file is not a video.')
  const audio = stream(result, 'audio')
  const fileStat = await stat(path)
  const dimensions = displayDimensions(
    firstPositiveNumber(video.width),
    firstPositiveNumber(video.height),
    rotationOf(video)
  )
  const duration = firstPositiveNumber(result.format.duration, video.duration)
  if (Math.min(dimensions.width, dimensions.height) === 0) {
    throw new Error('This video has no usable frames.')
  }

  return {
    path,
    name: basename(path),
    size: firstPositiveNumber(result.format.size, fileStat.size),
    modifiedAt: fileStat.mtimeMs,
    duration,
    width: dimensions.width,
    height: dimensions.height,
    fps: firstFrameRate(video.avg_frame_rate, video.r_frame_rate),
    videoCodec: video.codec_name ?? 'unknown',
    hasAudio: Boolean(audio)
  }
}

export async function probeAsset(path: string): Promise<AssetMetadata> {
  const result = await readProbe(path)
  const video = stream(result, 'video')
  const audio = stream(result, 'audio')
  return {
    duration: firstPositiveNumber(result.format.duration, video?.duration, audio?.duration, 3),
    hasAudio: Boolean(audio)
  }
}

export function proxyCacheKey(metadata: MediaMetadata): string {
  return createHash('sha256')
    .update(`${metadata.path}\0${metadata.size}\0${metadata.modifiedAt}\0${metadata.duration}`)
    .digest('hex')
    .slice(0, 24)
}

async function validProxy(path: string): Promise<boolean> {
  try {
    const [file, probe] = await Promise.all([stat(path), readProbe(path)])
    return file.size > 1024 && Boolean(stream(probe, 'video')) && firstPositiveNumber(probe.format.duration) > 0
  } catch {
    return false
  }
}

export async function pruneProxyCache(
  directory: string,
  maximumBytes = 10 * 1024 ** 3,
  preservedPath?: string
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = (await Promise.all(entries
    .filter((entry) => entry.isFile()
      && entry.name.endsWith('.mp4')
      && !entry.name.endsWith('.partial.mp4'))
    .map(async (entry) => {
      const path = join(directory, entry.name)
      const details = await stat(path)
      return { path, size: details.size, modifiedAt: details.mtimeMs }
    })))
    .sort((left, right) => left.modifiedAt - right.modifiedAt)
  let total = files.reduce((sum, file) => sum + file.size, 0)
  for (const file of files) {
    if (total <= maximumBytes) break
    if (file.path === preservedPath) continue
    await rm(file.path, { force: true })
    total -= file.size
  }
}

async function generateProxy(metadata: MediaMetadata): Promise<string> {
  const cacheRoot = process.env.XDG_CACHE_HOME ?? join(app.getPath('home'), '.cache')
  const cacheDirectory = join(cacheRoot, 'otc', 'proxies')
  await mkdir(cacheDirectory, { recursive: true })
  const key = proxyCacheKey(metadata)
  const outputPath = join(cacheDirectory, `${key}.mp4`)
  if (await validProxy(outputPath)) {
    return outputPath
  }
  await rm(outputPath, { force: true })

  const jobId = randomUUID()
  const temporaryPath = join(cacheDirectory, `.${key}.${jobId}.partial.mp4`)
  try {
    await jobs.run(ffmpegPath(), proxyArgs(metadata, temporaryPath), 'proxy', metadata.duration, jobId)
    // Never expose the cache filename until FFprobe accepts the completed temp
    // file. Rename on the same filesystem makes the cache update atomic.
    if (!await validProxy(temporaryPath)) throw new Error('The generated playback proxy is invalid')
    await rename(temporaryPath, outputPath)
    await pruneProxyCache(cacheDirectory, 10 * 1024 ** 3, outputPath)
    return outputPath
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export function createProxy(metadata: MediaMetadata): Promise<string> {
  const key = proxyCacheKey(metadata)
  const existing = proxyJobs.get(key)
  if (existing) return existing
  if (proxyClosed) return Promise.reject(new Error(PROXY_SHUTDOWN_MESSAGE))

  const scheduled = proxyQueue.then(async () => {
    if (proxyClosed) throw new Error(PROXY_SHUTDOWN_MESSAGE)
    return generateProxy(metadata)
  })
  const pending = scheduled.finally(() => {
    if (proxyJobs.get(key) === pending) proxyJobs.delete(key)
  })
  proxyQueue = pending.then(() => undefined, () => undefined)
  proxyJobs.set(key, pending)
  return pending
}

export function shutdownProxyJobs(): Promise<void> {
  proxyClosed = true
  return proxyQueue
}

export function peaksFromPcm(buffer: Buffer, bucketCount = MAX_WAVEFORM_PEAKS): number[] {
  const sampleCount = Math.floor(buffer.byteLength / 4)
  if (sampleCount === 0) return []
  const peaks = Array.from({ length: Math.min(bucketCount, sampleCount) }, () => 0)
  for (let index = 0; index < sampleCount; index += 1) {
    const bucket = Math.min(peaks.length - 1, Math.floor(index / sampleCount * peaks.length))
    const sample = Math.abs(buffer.readFloatLE(index * 4))
    peaks[bucket] = Math.max(peaks[bucket] ?? 0, Number.isFinite(sample) ? sample : 0)
  }
  const maximum = Math.max(...peaks, 0.01)
  return peaks.map((peak) => Math.min(1, peak / maximum))
}

async function createWaveform(path: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0',
      '-vn', '-ac', '1', '-ar', '100', '-f', 'f32le', 'pipe:1'
    ], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })
    return peaksFromPcm(stdout)
  } catch {
    return []
  }
}

async function waveformCacheKey(path: string): Promise<string | null> {
  try {
    const file = await stat(path)
    return `${path}\0${file.size}\0${file.mtimeMs}`
  } catch {
    return null
  }
}

function cacheWaveform(key: string, path: string): Promise<number[]> {
  const pending = createWaveform(path).then((peaks) => {
    if (peaks.length === 0 && waveformCache.get(key) === pending) waveformCache.delete(key)
    return peaks
  })
  waveformCache.set(key, pending)
  // FIFO eviction bounds retained peak arrays while keeping recent source identities usable.
  while (waveformCache.size > MAX_WAVEFORM_CACHE_ENTRIES) {
    const oldest = waveformCache.keys().next().value
    if (oldest === undefined) break
    waveformCache.delete(oldest)
  }
  return pending
}

export async function waveformFor(path: string): Promise<number[]> {
  const key = await waveformCacheKey(path)
  if (key === null) return []
  return waveformCache.get(key) ?? cacheWaveform(key, path)
}
