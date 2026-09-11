import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, VideoTransition } from '../types'

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

import { buildFilterGraph } from './exporter'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const width = 64
const height = 36
const fps = 10
const sampleRate = 48_000
const channels = 2
const clipDuration = 0.5
const timelineDuration = clipDuration * 2
const expectedFrames = timelineDuration * sampleRate
const expectedBytes = expectedFrames * channels * Float32Array.BYTES_PER_ELEMENT

let directory: string
let leftPath: string
let rightPath: string

function runFfmpeg(args: string[]): Buffer {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1', ...args
  ], {
    encoding: 'buffer', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1' }
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.toString('utf8').trim() || `ffmpeg exited with ${result.status ?? result.signal}`
    throw new Error(detail)
  }
  return result.stdout
}

function createSource(path: string, color: string, level: number): void {
  runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=${color}:size=${width}x${height}:rate=${fps}:duration=${clipDuration}`,
    '-f', 'lavfi', '-i', `aevalsrc=${level}|${level}:channel_layout=stereo:sample_rate=${sampleRate}:d=${clipDuration}`,
    '-map', '0:v:0', '-map', '1:a:0', '-t', String(clipDuration),
    '-c:v', 'ffv1', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_f32le', '-ar', String(sampleRate), '-ac', String(channels), path
  ])
}

function request(transition?: VideoTransition): ExportRequest {
  const metadata = (path: string, name: string) => ({
    path, name, size: 1, modifiedAt: 1, duration: clipDuration, width, height, fps,
    videoCodec: 'ffv1', hasAudio: true
  })
  return {
    canvas: { width, height, fps, fit: 'contain' },
    sources: [
      { id: 'left', metadata: metadata(leftPath, 'left.mkv') },
      { id: 'right', metadata: metadata(rightPath, 'right.mkv') }
    ],
    segments: [
      { id: 'left-segment', sourceId: 'left', sourceStart: 0, sourceEnd: clipDuration },
      { id: 'right-segment', sourceId: 'right', sourceStart: 0, sourceEnd: clipDuration, ...(transition ? { transition } : {}) }
    ],
    overlays: [],
    outputPath: join(directory, 'unused.mp4')
  }
}

function decodeSourceAudio(path: string): Buffer {
  return runFfmpeg([
    '-i', path, '-map', '0:a:0', '-vn', '-ar', String(sampleRate), '-ac', String(channels),
    '-f', 'f32le', 'pipe:1'
  ])
}

function renderAudio(project: ExportRequest, name: string): Buffer {
  const filter = buildFilterGraph(project, [])
  const output = join(directory, `${name}.f32le`)
  runFfmpeg([
    '-i', leftPath, '-i', rightPath, '-filter_complex', filter.graph,
    '-map', `[${filter.videoLabel}]`, '-frames:v', String(timelineDuration * fps), '-f', 'null', '-',
    '-map', `[${filter.audioLabel}]`, '-ar', String(sampleRate), '-ac', String(channels), '-f', 'f32le', output
  ])
  return readFileSync(output)
}

function samples(raw: Buffer): Float32Array {
  if (raw.length % (channels * Float32Array.BYTES_PER_ELEMENT) !== 0) throw new Error('PCM is not frame-aligned')
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT)
}

function maxAdjacentStep(raw: Buffer, startFrame: number, endFrame: number): number {
  const data = samples(raw)
  let maximum = 0
  for (let frame = Math.max(1, startFrame); frame < Math.min(endFrame, data.length / channels); frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const current = data[frame * channels + channel] ?? 0
      const previous = data[(frame - 1) * channels + channel] ?? 0
      maximum = Math.max(maximum, Math.abs(current - previous))
    }
  }
  return maximum
}

function mean(raw: Buffer, startFrame: number, endFrame: number): number {
  const data = samples(raw)
  let total = 0
  let count = 0
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      total += data[frame * channels + channel] ?? 0
      count += 1
    }
  }
  return total / count
}

describe('real audio clip boundaries', () => {
  beforeAll(() => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    directory = mkdtempSync(join(tmpdir(), 'otc-audio-boundary-real-'))
    leftPath = join(directory, 'left.mkv')
    rightPath = join(directory, 'right.mkv')
    createSource(leftPath, 'blue', 0.4)
    createSource(rightPath, 'red', -0.4)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    { name: 'no visual transition', transition: undefined },
    { name: 'fade visual transition', transition: { effect: 'fade' as const, duration: 0.2 } }
  ])('$name keeps audio continuous and timeline length unchanged', ({ transition }) => {
    const rawConcat = Buffer.concat([decodeSourceAudio(leftPath), decodeSourceAudio(rightPath)])
    const output = renderAudio(request(transition), transition ? 'fade' : 'none')
    const boundary = expectedFrames / 2
    const edge = sampleRate * 0.01

    expect(Math.abs(samples(output).length / channels - expectedFrames)).toBeLessThanOrEqual(1)
    expect(output.length).toBe(expectedBytes)
    expect(Math.abs(mean(output, sampleRate * 0.1, sampleRate * 0.4) - 0.4)).toBeLessThan(0.03)
    expect(Math.abs(mean(output, sampleRate * 0.6, sampleRate * 0.9) + 0.4)).toBeLessThan(0.03)

    const rawBoundaryStep = maxAdjacentStep(rawConcat, boundary - edge, boundary + edge)
    const filteredBoundaryStep = maxAdjacentStep(output, boundary - edge, boundary + edge)
    expect(rawBoundaryStep).toBeGreaterThan(0.7)
    expect(filteredBoundaryStep).toBeLessThan(rawBoundaryStep * 0.2)
  })
})
