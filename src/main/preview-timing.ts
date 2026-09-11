import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExportRequest, SourceSegment } from '../types'
import { ffprobePath } from './binaries'

const execFileAsync = promisify(execFile)
const FRAME_EPSILON = 1e-6
const RATE_EPSILON = 1e-9

interface ProbeStream {
  avg_frame_rate?: unknown
  r_frame_rate?: unknown
  start_time?: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parsePositiveRational(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value.trim().split('/')
  if (parts.length !== 2) return undefined
  const numerator = Number(parts[0])
  const denominator = Number(parts[1])
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) return undefined
  const rate = numerator / denominator
  return Number.isFinite(rate) && rate > 0 ? rate : undefined
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function validProbe(stdout: unknown, canvasFps: number): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(stdout))
  } catch {
    return false
  }
  const result = record(parsed)
  const streams = result?.streams
  if (!Array.isArray(streams) || streams.length !== 1) return false
  const stream = record(streams[0]) as ProbeStream | undefined
  if (!stream) return false
  const startTime = parseFiniteNumber(stream.start_time)
  const averageRate = parsePositiveRational(stream.avg_frame_rate)
  const baseRate = parsePositiveRational(stream.r_frame_rate)
  return startTime === 0 && averageRate !== undefined && baseRate !== undefined
    && Math.abs(averageRate - canvasFps) <= RATE_EPSILON
    && Math.abs(baseRate - canvasFps) <= RATE_EPSILON
}

async function validSourceHeader(path: string, canvasFps: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath(),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate,start_time', '-of', 'json', path],
      { maxBuffer: 64 * 1024, timeout: 5000 }
    )
    return validProbe(stdout, canvasFps)
  } catch {
    return false
  }
}

function sourceFor(request: ExportRequest, segment: SourceSegment): ExportRequest['sources'][number] | undefined {
  return request.sources.find((source) => source.id === segment.sourceId)
}

function validSegment(request: ExportRequest, segment: SourceSegment, canvasFps: number): ExportRequest['sources'][number] | undefined {
  if (segment.kind === 'freeze' || (segment.playbackRate !== undefined && segment.playbackRate !== 1)) return undefined
  const source = sourceFor(request, segment)
  const metadata = source?.metadata
  if (!source || !metadata || typeof metadata.path !== 'string' || metadata.path.length === 0) return undefined
  if (!Number.isFinite(metadata.fps) || metadata.fps <= 0 || metadata.fps !== canvasFps) return undefined
  if (!Number.isFinite(segment.sourceStart) || !Number.isFinite(segment.sourceEnd)
    || segment.sourceStart < 0 || segment.sourceEnd <= segment.sourceStart) return undefined
  return source
}

function prefixFrameCount(segment: SourceSegment, fps: number): number | undefined {
  if (segment.kind === 'freeze') return undefined
  const startFrame = Math.ceil(segment.sourceStart * fps - FRAME_EPSILON)
  const endFrame = Math.ceil(segment.sourceEnd * fps - FRAME_EPSILON)
  const count = endFrame - startFrame
  return Number.isSafeInteger(count) && count >= 2 ? count : undefined
}

function concatOffset(frameCounts: readonly number[], fps: number): number {
  let totalFrames = 0
  let offsetUs = 0
  for (const frameCount of frameCounts) {
    const lastUs = offsetUs + Math.round((frameCount - 1) * 1e6 / fps)
    totalFrames += frameCount
    offsetUs = Math.round(lastUs * totalFrames / (totalFrames - 1))
  }
  // This mirrors FFmpeg concat's mean-frame duration on microsecond timestamps;
  // raw edit durations can drift by one frame at fractional rates.
  return offsetUs / 1e6
}

export async function previewTimelineOffset(request: ExportRequest, index: number): Promise<number | undefined> {
  if (!Number.isInteger(index) || index <= 0 || index >= request.segments.length) return undefined
  const canvasFps = request.canvas.fps
  if (!Number.isFinite(canvasFps) || canvasFps <= 0) return undefined

  const sourcePaths = new Set<string>()
  const frameCounts: number[] = []
  for (const [position, segment] of request.segments.slice(0, index + 1).entries()) {
    const source = validSegment(request, segment, canvasFps)
    if (!source) return undefined
    sourcePaths.add(source.metadata.path)
    if (position < index) {
      const count = prefixFrameCount(segment, canvasFps)
      if (count === undefined) return undefined
      frameCounts.push(count)
    }
  }

  for (const path of sourcePaths) {
    if (!await validSourceHeader(path, canvasFps)) return undefined
  }

  return concatOffset(frameCounts, canvasFps)
}
