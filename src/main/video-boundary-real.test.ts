import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
import { timelineDuration } from '../segment-time'

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./binaries', () => ({
  ffmpegPath: () => join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  ffprobePath: () => join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe')
}))
vi.mock('./jobs', () => ({ jobs: { run: vi.fn() } }))
vi.mock('./face-worker', () => ({ restrictedIntelRenderNode: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./privileged-export', () => ({ encodeWithPrivilegedGpu: vi.fn() }))
vi.mock('./face-export', () => ({ encodeWithFaces: vi.fn() }))
vi.mock('./face-preview-cache', () => ({ tryReuseFacePreview: vi.fn().mockResolvedValue(false) }))

import { buildFilterGraph, prepareTimelineInputs } from './exporter'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const width = 64
const height = 36
const fps = 60
const duration = 1
const sourceFrames = fps * duration
const frameBytes = width * height

let directory: string
let firstPath: string
let secondPath: string

function runFfmpeg(args: string[]): Buffer {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1', ...args
  ], {
    encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1' }
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.toString('utf8').trim() || `ffmpeg exited with ${result.status ?? result.signal}`
    throw new Error(detail)
  }
  return result.stdout
}

function createSource(path: string, first: boolean): void {
  const expression = first ? '40+N' : '200-N'
  runFfmpeg([
    '-f', 'lavfi', '-i', `nullsrc=s=${width}x${height}:r=${fps}:d=${duration}`,
    '-vf', `geq=lum='${expression}':cb=128:cr=128`, '-frames:v', String(sourceFrames),
    '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', path
  ])
}

function metadata(path: string, name: string) {
  return { path, name, size: 1, modifiedAt: 1, duration, width, height, fps, videoCodec: 'ffv1', hasAudio: false }
}

function request(firstStart = 0, firstEnd = duration, secondStart = 0, secondEnd = duration): ExportRequest {
  return {
    canvas: { width, height, fps, fit: 'contain' },
    sources: [
      { id: 'first', metadata: metadata(firstPath, 'first.mkv') },
      { id: 'second', metadata: metadata(secondPath, 'second.mkv') }
    ],
    segments: [
      { id: 'first-segment', sourceId: 'first', sourceStart: firstStart, sourceEnd: firstEnd },
      { id: 'second-segment', sourceId: 'second', sourceStart: secondStart, sourceEnd: secondEnd }
    ],
    overlays: [],
    outputPath: join(directory, 'unused.mp4')
  }
}

function renderFrames(project: ExportRequest): number[] {
  const inputArgs: string[] = []
  const prepared = prepareTimelineInputs(project, inputArgs)
  const filter = buildFilterGraph(prepared, [])
  const raw = runFfmpeg([
    ...inputArgs,
    '-filter_complex', `${filter.graph};[${filter.audioLabel}]anullsink`,
    '-map', `[${filter.videoLabel}]`, '-an', '-frames:v', String(Math.round(timelineDuration(project.segments) * fps)),
    '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'
  ])
  if (raw.length % frameBytes !== 0) throw new Error(`Raw output is not frame-aligned: ${raw.length} bytes`)
  return Array.from({ length: raw.length / frameBytes }, (_, index) => {
    let total = 0
    const frame = raw.subarray(index * frameBytes, (index + 1) * frameBytes)
    for (const value of frame) total += value
    return Math.round(total / (width * height))
  })
}

function sourceMarkers(path: string): number[] {
  const raw = runFfmpeg(['-i', path, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'])
  if (raw.length % frameBytes !== 0) throw new Error(`Source output is not frame-aligned: ${raw.length} bytes`)
  return Array.from({ length: raw.length / frameBytes }, (_, index) => {
    let total = 0
    const frame = raw.subarray(index * frameBytes, (index + 1) * frameBytes)
    for (const value of frame) total += value
    return Math.round(total / (width * height))
  })
}

describe('CPU real video clip boundaries', () => {
  beforeAll(() => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    directory = mkdtempSync(join(tmpdir(), 'otc-video-boundary-real-'))
    firstPath = join(directory, 'first.mkv')
    secondPath = join(directory, 'second.mkv')
    createSource(firstPath, true)
    createSource(secondPath, false)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it('concatenates physical-EOF clips without black or repeated frames', () => {
    const first = sourceMarkers(firstPath)
    const second = sourceMarkers(secondPath)
    const rendered = renderFrames(request())
    expect(first).toHaveLength(sourceFrames)
    expect(second).toHaveLength(sourceFrames)
    expect(new Set(first)).toHaveProperty('size', sourceFrames)
    expect(new Set(second)).toHaveProperty('size', sourceFrames)
    expect(rendered).toHaveLength(sourceFrames * 2)
    expect(rendered).toEqual([...first, ...second])
  })

  it('preserves same-fps trimmed source slices in order', () => {
    const first = sourceMarkers(firstPath)
    const second = sourceMarkers(secondPath)
    const rendered = renderFrames(request(0.2, 0.7, 0.3, 0.8))
    expect(rendered).toHaveLength(sourceFrames)
    expect(rendered).toEqual([...first.slice(12, 42), ...second.slice(18, 48)])
  })
})
