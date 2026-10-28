import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./upscale-pack', () => ({ requireUpscalePack: vi.fn() }))
vi.mock('./upscale-export', () => ({ encodeWithUpscale: vi.fn() }))
vi.mock('./export-encoder', () => ({
  exportEncoders: vi.fn(), softwareEncoder: vi.fn(), integratedDecodeDevice: vi.fn()
}))
vi.mock('./export-space', () => ({ ensureDiskSpace: vi.fn(), ensureFaceExportDiskSpace: vi.fn() }))
vi.mock('./face-export', () => ({ encodeWithFaces: vi.fn() }))
vi.mock('./intel-device', () => ({ restrictedIntelRenderNode: vi.fn() }))
vi.mock('./privileged-export', () => ({ encodeWithPrivilegedGpu: vi.fn() }))
vi.mock('./face-preview-cache', () => ({ tryReuseFacePreview: vi.fn() }))
vi.mock('./jobs', () => ({ jobs: { run: vi.fn() } }))

import { buildFilterGraph } from './exporter'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const ffprobe = join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe')
const fps = 30
const duration = 2

let directory: string

function request(canvas: ExportRequest['canvas'], projectDuration = duration,
  focusZooms: ExportRequest['focusZooms'] = [{ id: 'circle', start: 0.2, duration: 1.2, zoom: 2, focusX: 0, focusY: 1, mode: 'circle' }]): ExportRequest {
  return {
    canvas,
    sources: [{
      id: 'source',
      metadata: {
        path: '/blue.mp4', name: 'blue.mp4', size: 1, modifiedAt: 1, duration: projectDuration,
        width: canvas.width, height: canvas.height, fps, videoCodec: 'rawvideo', hasAudio: false
      }
    }],
    segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: projectDuration }],
    overlays: [],
    outputPath: join(directory, 'unused.mp4'),
    focusZooms
  }
}

function runFfmpeg(args: string[]): Buffer {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
    ...args
  ], {
    encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1' }
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8').trim() || `ffmpeg exited with ${result.status ?? result.signal}`)
  return result.stdout
}

function runTimedFfmpeg(args: string[]): number {
  const started = performance.now()
  runFfmpeg(args)
  return performance.now() - started
}

function graph(requestValue: ExportRequest): { graph: string; videoLabel: string; audioLabel: string } {
  return buildFilterGraph(requestValue, [])
}

function redPixels(frame: Buffer, width: number, height: number): number {
  let count = 0
  for (let offset = 0; offset < width * height * 4; offset += 4) {
    if ((frame[offset] ?? 0) > 180 && (frame[offset + 1] ?? 0) < 80 && (frame[offset + 2] ?? 0) < 80 && (frame[offset + 3] ?? 0) > 180) count += 1
  }
  return count
}

function blackPixels(frame: Buffer, width: number, height: number): number {
  let count = 0
  for (let offset = 0; offset < width * height * 4; offset += 4) {
    if ((frame[offset] ?? 0) < 100 && (frame[offset + 1] ?? 0) < 100 && (frame[offset + 2] ?? 0) < 100 && (frame[offset + 3] ?? 0) > 180) count += 1
  }
  return count
}

function pixel(frame: Buffer, width: number, x: number, y: number): Buffer {
  const offset = (y * width + x) * 4
  return frame.subarray(offset, offset + 4)
}

function expectBasePixelClose(actual: Buffer, expected: Buffer, label: string): void {
  for (const channel of [0, 1, 2]) {
    expect(Math.abs((actual[channel] ?? 0) - (expected[channel] ?? 0)), `${label} channel ${channel}`).toBeLessThanOrEqual(1)
  }
  expect(actual[3], `${label} alpha`).toBe(expected[3])
}

function probeDuration(path: string): number {
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || `ffprobe exited with ${result.status ?? result.signal}`)
  return Number(result.stdout.trim())
}

describe('CPU circular focus zoom export', () => {
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'otc-focus-zoom-real-'))
    vi.stubEnv('otc_CPU_ONLY', '1')
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it('renders a portrait edge-focused circle, draws a partial then full red/black arc, and preserves duration', () => {
    const canvas = { width: 180, height: 320, fps, fit: 'contain' as const }
    const project = request(canvas)
    const filter = graph(project)
    const videoOnlyGraph = `${filter.graph};[${filter.audioLabel}]anullsink`
    const raw = runFfmpeg([
      '-f', 'lavfi', '-i', `color=c=blue:s=${canvas.width}x${canvas.height}:r=${fps}:d=${duration}`,
      '-filter_complex', videoOnlyGraph, '-map', `[${filter.videoLabel}]`, '-an', '-frames:v', String(fps),
      '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'
    ])
    const frameBytes = canvas.width * canvas.height * 4
    expect(raw.length).toBe(frameBytes * fps)
    const frame = (index: number): Buffer => raw.subarray(index * frameBytes, (index + 1) * frameBytes)
    expect(redPixels(frame(0), canvas.width, canvas.height)).toBe(0)
    const partial = redPixels(frame(16), canvas.width, canvas.height)
    const full = redPixels(frame(21), canvas.width, canvas.height)
    expect(partial).toBeGreaterThan(0)
    expect(full).toBeGreaterThan(partial)
    expect(blackPixels(frame(21), canvas.width, canvas.height)).toBeGreaterThan(0)
    // The composited base remains visible outside the bounded ring; no full-frame mask leaks out.
    expect([...pixel(frame(18), canvas.width, canvas.width - 1, 0)]).toEqual([...pixel(frame(0), canvas.width, canvas.width - 1, 0)])

    const patternedInput = `testsrc2=size=${canvas.width}x${canvas.height}:rate=${fps}:duration=${duration}`
    const patternedGraph = graph(project)
    const patterned = runFfmpeg([
      '-f', 'lavfi', '-i', patternedInput,
      '-filter_complex', `${patternedGraph.graph};[${patternedGraph.audioLabel}]anullsink`,
      '-map', `[${patternedGraph.videoLabel}]`, '-an', '-frames:v', String(fps),
      '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'
    ])
    const referenceGraph = graph(request(canvas, duration, []))
    const reference = runFfmpeg([
      '-f', 'lavfi', '-i', patternedInput,
      '-filter_complex', `${referenceGraph.graph};[${referenceGraph.audioLabel}]anullsink`,
      '-map', `[${referenceGraph.videoLabel}]`, '-an', '-frames:v', String(fps),
      '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'
    ])
    const patternedFrame = (index: number): Buffer => patterned.subarray(index * frameBytes, (index + 1) * frameBytes)
    const referenceFrame = (index: number): Buffer => reference.subarray(index * frameBytes, (index + 1) * frameBytes)
    // The ring is transparent away from its outline. Compare a strong interior grid and
    // exterior points against the lossless raw reference, allowing only one RGB rounding
    // step from FFmpeg's pixel-format conversion; magnification/cropping would exceed it.
    const outputFrame = patternedFrame(18)
    const referenceOutputFrame = referenceFrame(18)
    for (const y of [256, 268, 280, 292, 304]) {
      for (const x of [16, 28, 40, 52, 64]) {
        expectBasePixelClose(pixel(outputFrame, canvas.width, x, y), pixel(referenceOutputFrame, canvas.width, x, y), `interior ${x},${y}`)
      }
    }
    for (const [x, y] of [[canvas.width - 1, 0], [canvas.width - 1, 280], [90, 260], [90, 300]] as const) {
      expectBasePixelClose(pixel(outputFrame, canvas.width, x, y), pixel(referenceOutputFrame, canvas.width, x, y), `exterior ${x},${y}`)
    }

    const longProject = request(canvas, 3)
    const longFilter = graph(longProject)
    const gate = ":enable='between(t\\,0.200000\\,1.400000)'"
    expect(longFilter.graph.split(gate)).toHaveLength(2)
    const ungatedGraph = longFilter.graph.replaceAll(gate, '')
    const renderArgs = (filterGraph: string): string[] => [
      '-f', 'lavfi', '-i', `color=c=blue:s=${canvas.width}x${canvas.height}:r=${fps}:d=3`,
      '-filter_complex', `${filterGraph};[${longFilter.audioLabel}]anullsink`, '-map', `[${longFilter.videoLabel}]`,
      '-an', '-frames:v', String(fps * 3), '-f', 'null', '-'
    ]
    const gatedMilliseconds = runTimedFfmpeg(renderArgs(longFilter.graph))
    const ungatedMilliseconds = runTimedFfmpeg(renderArgs(ungatedGraph))
    // Keep this as a diagnostic comparison rather than a host-speed assertion: the important
    // invariant is that the active graph contains timeline gates and both paths render cleanly.
    expect(gatedMilliseconds).toBeGreaterThan(0)
    expect(ungatedMilliseconds).toBeGreaterThan(0)
    expect(Number.isFinite(gatedMilliseconds / ungatedMilliseconds)).toBe(true)
    console.info(`FOCUS_CIRCLE_RENDER gated_ms=${gatedMilliseconds.toFixed(1)} ungated_ms=${ungatedMilliseconds.toFixed(1)}`)

    const lateProject = request(canvas, 3, [{
      id: 'late-circle', start: 2, duration: 0.6, zoom: 9, focusX: 0, focusY: 1, mode: 'circle'
    }])
    const lateFilter = graph(lateProject)
    expect(lateFilter.graph).toContain('color=c=black@0.0:s=18x18:r=30:d=0.600000,setpts=PTS+2.000000/TB')
    expect(lateFilter.graph).not.toContain('d=2.600000,setpts=')
    runFfmpeg([
      '-f', 'lavfi', '-i', `color=c=blue:s=${canvas.width}x${canvas.height}:r=${fps}:d=3`,
      '-filter_complex', `${lateFilter.graph};[${lateFilter.audioLabel}]anullsink`,
      '-map', `[${lateFilter.videoLabel}]`, '-an', '-frames:v', String(fps * 3), '-f', 'null', '-'
    ])

    const output = join(directory, 'portrait-circle.mp4')
    runFfmpeg([
      '-f', 'lavfi', '-i', `color=c=blue:s=${canvas.width}x${canvas.height}:r=${fps}:d=${duration}`,
      '-filter_complex', filter.graph, '-map', `[${filter.videoLabel}]`, '-map', `[${filter.audioLabel}]`,
      '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-t', String(duration), output
    ])
    expect(probeDuration(output)).toBeCloseTo(duration, 2)
  }, 30_000)
})
