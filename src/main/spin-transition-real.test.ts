import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, VideoTransition } from '../types'
import { timelineDuration } from '../segment-time'

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./binaries', () => ({
  ffmpegPath: () => join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  ffprobePath: () => join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe')
}))
vi.mock('./jobs', () => ({ jobs: { run: vi.fn() } }))
vi.mock('./intel-device', () => ({ restrictedIntelRenderNode: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./privileged-export', () => ({ encodeWithPrivilegedGpu: vi.fn() }))
vi.mock('./face-export', () => ({ encodeWithFaces: vi.fn() }))
vi.mock('./face-preview-cache', () => ({ tryReuseFacePreview: vi.fn().mockResolvedValue(false) }))

import { buildFilterGraph, prepareTimelineInputs } from './exporter'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const ffprobe = join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe')
const width = 64
const height = 36
const fps = 24
const duration = 1.5
const sourceFrameCount = Math.round(fps * duration)
const frameBytes = width * height

let directory: string
let firstPath: string
let secondPath: string

function ffmpegBase(): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1']
}

function runFfmpeg(args: string[]): Buffer {
  const result = spawnSync(ffmpeg, [...ffmpegBase(), ...args], {
    encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1' }
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8').trim() || `ffmpeg exited with ${result.status ?? result.signal}`)
  return result.stdout
}

function createPattern(path: string, inverted: boolean): void {
  const luma = inverted ? '170+X+2*Y+N' : '30+2*X+Y+N'
  runFfmpeg([
    '-f', 'lavfi', '-i', `nullsrc=s=${width}x${height}:r=${fps}:d=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=${inverted ? 660 : 440}:sample_rate=48000:duration=${duration}`,
    '-vf', `geq=lum='${luma}':cb=128:cr=128`, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', '-c:a', 'pcm_s16le', '-shortest', path
  ])
}

function metadata(path: string, name: string) {
  return { path, name, size: 1, modifiedAt: 1, duration, width, height, fps, videoCodec: 'ffv1', hasAudio: true }
}

function request(transition: VideoTransition): ExportRequest {
  return {
    canvas: { width, height, fps, fit: 'contain' },
    sources: [
      { id: 'first', metadata: metadata(firstPath, 'first.mkv') },
      { id: 'second', metadata: metadata(secondPath, 'second.mkv') }
    ],
    segments: [
      { id: 'first-segment', sourceId: 'first', sourceStart: 0, sourceEnd: duration },
      { id: 'second-segment', sourceId: 'second', sourceStart: 0, sourceEnd: duration, transition }
    ],
    overlays: [],
    outputPath: join(directory, 'unused.mkv')
  }
}

function frameBuffers(project: ExportRequest): Buffer[] {
  const inputArgs: string[] = []
  const filter = buildFilterGraph(prepareTimelineInputs(project, inputArgs), [])
  const raw = runFfmpeg([
    ...inputArgs, '-filter_complex', `${filter.graph};[${filter.audioLabel}]anullsink`,
    '-map', `[${filter.videoLabel}]`, '-an', '-frames:v', String(Math.round(timelineDuration(project.segments) * fps)),
    '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'
  ])
  if (raw.length % frameBytes !== 0) throw new Error(`Raw output is not frame-aligned: ${raw.length} bytes`)
  return Array.from({ length: raw.length / frameBytes }, (_, index) => raw.subarray(index * frameBytes, (index + 1) * frameBytes))
}

function readSourceFrames(path: string): Buffer[] {
  const raw = runFfmpeg(['-i', path, '-map', '0:v:0', '-an', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'])
  if (raw.length % frameBytes !== 0) throw new Error(`Source output is not frame-aligned: ${raw.length} bytes`)
  return Array.from({ length: raw.length / frameBytes }, (_, index) => raw.subarray(index * frameBytes, (index + 1) * frameBytes))
}

function maxDifference(left: Buffer, right: Buffer): number {
  let maximum = 0
  for (let index = 0; index < frameBytes; index += 1) maximum = Math.max(maximum, Math.abs((left[index] ?? 0) - (right[index] ?? 0)))
  return maximum
}

function renderOutput(project: ExportRequest, output: string): void {
  const inputArgs: string[] = []
  const filter = buildFilterGraph(prepareTimelineInputs(project, inputArgs), [])
  runFfmpeg([
    ...inputArgs, '-filter_complex', filter.graph,
    '-map', `[${filter.videoLabel}]`, '-map', `[${filter.audioLabel}]`,
    '-c:v', 'ffv1', '-c:a', 'pcm_s16le', output
  ])
}

function probe(path: string): { duration: number; types: string[] } {
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || `ffprobe exited with ${result.status ?? result.signal}`)
  const parsed = JSON.parse(result.stdout) as { format?: { duration?: string }; streams?: { codec_type?: string }[] }
  return { duration: Number(parsed.format?.duration), types: (parsed.streams ?? []).map((stream) => stream.codec_type ?? '') }
}

describe('CPU spin transition export', () => {
  beforeAll(() => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    directory = mkdtempSync(join(tmpdir(), 'otc-spin-transition-real-'))
    firstPath = join(directory, 'first.mkv')
    secondPath = join(directory, 'second.mkv')
    createPattern(firstPath, false)
    createPattern(secondPath, true)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it('rotates both clips, covers corners, and preserves video/audio duration', () => {
    const spin = frameBuffers(request({ effect: 'spin', duration: 0.5 }))
    const fade = frameBuffers(request({ effect: 'fade', duration: 0.5 }))
    const first = readSourceFrames(firstPath)
    const second = readSourceFrames(secondPath)
    expect(spin).toHaveLength(sourceFrameCount * 2)
    expect(maxDifference(spin[0] ?? Buffer.alloc(frameBytes), first[0] ?? Buffer.alloc(frameBytes))).toBeLessThanOrEqual(2)
    expect(maxDifference(spin[42] ?? Buffer.alloc(frameBytes), fade[42] ?? Buffer.alloc(frameBytes))).toBeGreaterThan(8)
    expect(Math.min(...(spin[42] ?? Buffer.alloc(frameBytes, 255)))).toBeGreaterThan(0)
    expect(maxDifference(spin.at(-1) ?? Buffer.alloc(frameBytes), second.at(-1) ?? Buffer.alloc(frameBytes))).toBeLessThanOrEqual(2)

    const output = join(directory, 'spin.mkv')
    renderOutput(request({ effect: 'spin', duration: 0.5 }), output)
    const result = probe(output)
    expect(result.duration).toBeCloseTo(duration * 2, 2)
    expect(result.types).toEqual(expect.arrayContaining(['video', 'audio']))
  }, 30_000)
})
