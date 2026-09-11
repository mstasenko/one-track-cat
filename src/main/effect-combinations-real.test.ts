import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, ImageOverlay, TextOverlay } from '../types'
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
import { applyPreviewSeek, previewSeekPlan } from './preview-seek'
import { previewFilterGraph, type PreviewRange } from './preview-range'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const width = 64
const height = 36
const fps = 10
const frameBytes = width * height * 3
type VideoOverlay = Extract<ExportRequest['overlays'][number], { type: 'video' }>

let directory: string
let sourcePath: string
let imagePath: string
let videoPath: string
let textPath: string
let renderId = 0

function runFfmpeg(args: string[]): Buffer {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'buffer', maxBuffer: 8 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.toString('utf8').trim() || `ffmpeg exited with ${result.status ?? result.signal}`
    throw new Error(detail)
  }
  return result.stdout
}

function createInputs(): void {
  directory = mkdtempSync(join(tmpdir(), 'otc-effect-combinations-real-'))
  sourcePath = join(directory, 'source.mkv')
  imagePath = join(directory, 'image.png')
  videoPath = join(directory, 'video.mkv')
  textPath = join(directory, 'text.png')
  runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=4`,
    '-an', '-c:v', 'ffv1', '-threads', '1', '-pix_fmt', 'yuv420p', sourcePath
  ])
  runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:size=16x16:rate=1:duration=1',
    '-frames:v', '1', '-pix_fmt', 'rgba', imagePath
  ])
  runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=green:size=16x16:rate=10:duration=1',
    '-an', '-c:v', 'ffv1', '-threads', '1', '-pix_fmt', 'yuv420p', videoPath
  ])
  runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=magenta:size=12x8:rate=1:duration=1',
    '-frames:v', '1', '-pix_fmt', 'rgba', textPath
  ])
}

function sourceMetadata() {
  return {
    path: sourcePath, name: 'source.mkv', size: 1, modifiedAt: 1, duration: 4,
    width, height, fps, videoCodec: 'ffv1', hasAudio: false
  }
}

function imageOverlay(): ImageOverlay {
  return {
    id: 'image', type: 'image', name: 'red image', path: imagePath,
    start: 0.1, duration: 0.5, zIndex: 1, x: 0, y: 0, width: 0.25, height: 0.5,
    opacity: 1, animation: 'fade', animationFadeIn: 0.1, animationFadeOut: 0.1
  }
}

function videoOverlay(): VideoOverlay {
  return {
    id: 'video', type: 'video', name: 'green video', path: videoPath,
    start: 0.15, duration: 0.4, zIndex: 2, x: 0.75, y: 0, width: 0.25, height: 0.5,
    opacity: 1, animation: 'pop', animationDuration: 0.3, loop: false,
    audioEnabled: false, hasAudio: false, volume: 1, sourceIn: 0, sourceDuration: 1
  }
}

function textOverlay(): TextOverlay {
  return {
    id: 'text', type: 'text', name: 'magenta text', start: 0.2, duration: 0.4,
    zIndex: 3, x: 0.25, y: 0.5, width: 0.5, height: 0.5, opacity: 1, text: 'TEXT',
    fontFamily: 'Anton', fontSize: 8, color: '#fff', outlineColor: '#000', outlineWidth: 1,
    shadow: false, align: 'center', animation: 'bounce', animationDuration: 0.3,
    renderedTextBitmap: {
      dataUrl: `data:image/png;base64,${readFileSync(textPath).toString('base64')}`,
      x: 26, y: 24, anchorX: 32, anchorY: 28
    }
  }
}

function composition(overrides: Partial<ExportRequest> = {}): ExportRequest {
  const image = imageOverlay()
  const video = videoOverlay()
  const text = textOverlay()
  return {
    canvas: { width, height, fps, fit: 'contain' },
    sources: [{ id: 'source', metadata: sourceMetadata() }],
    segments: [
      { id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 0.6 },
      {
        id: 'fast', sourceId: 'source', sourceStart: 1.2, sourceEnd: 1.8,
        playbackRate: 2, transition: { effect: 'fade', duration: 0.2 }
      },
      { kind: 'freeze', id: 'freeze', sourceId: 'source', sourceTime: 2, duration: 0.4 }
    ],
    overlays: [image, video, text],
    focusZooms: [{ id: 'focus', start: 0.45, duration: 0.5, zoom: 2, focusX: 0.5, focusY: 0.5 }],
    videoTransitions: [{
      id: 'range', start: 0.1, duration: 0.6,
      into: { effect: 'fade', duration: 0.4 }, out: { effect: 'hblur', duration: 0.2 }
    }],
    outputPath: join(directory, 'unused.mp4'),
    ...overrides
  }
}

function inputArgs(request: ExportRequest): { args: string[]; prepared: { overlay: ExportRequest['overlays'][number]; index: number }[] } {
  const args = ['-threads', '1', '-i', sourcePath]
  const prepared = request.overlays.map((overlay, index) => {
    if (overlay.type === 'image' || overlay.type === 'text') args.push('-loop', '1')
    args.push('-threads', '1', '-i', overlay.type === 'text' ? textPath : overlay.path)
    return { overlay, index: index + 1 }
  })
  return { args, prepared }
}

function render(request: ExportRequest, range?: PreviewRange, seek = false): Buffer {
  const args = ['-filter_threads', '1', '-filter_complex_threads', '1']
  const audioPath = join(directory, `render-${renderId++}.f32le`)
  let graphRequest = request
  const plan = seek ? previewSeekPlan(request, range) : undefined
  if (seek && !plan) throw new Error('expected a preview seek plan')
  if (plan) graphRequest = prepareTimelineInputs(request, args, plan)
  // A seeked request already contains its input arguments from prepareTimelineInputs.
  if (plan) {
    const seekArgs = args
    const filter = previewFilterGraph(applyPreviewSeek(buildFilterGraph(graphRequest, []), plan), range)
    const duration = range ? range[1] - range[0] : timelineDuration(request.segments)
    const result = runFfmpeg([
      ...seekArgs, '-filter_complex', filter.graph, '-map', `[${filter.videoLabel}]`,
      '-t', String(duration), '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
      '-map', `[${filter.audioLabel}]`, '-t', String(duration), '-ar', '48000', '-ac', '2', '-f', 'f32le', audioPath
    ])
    return result
  }
  const inputs = inputArgs(graphRequest)
  const base = buildFilterGraph(graphRequest, inputs.prepared)
  const filter = previewFilterGraph(base, range)
  const duration = range ? range[1] - range[0] : timelineDuration(request.segments)
  return runFfmpeg([
    ...inputs.args, '-filter_complex', filter.graph, '-map', `[${filter.videoLabel}]`,
    '-t', String(duration), '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    '-map', `[${filter.audioLabel}]`, '-t', String(duration), '-ar', '48000', '-ac', '2', '-f', 'f32le', audioPath
  ])
}

function frames(raw: Buffer): Buffer[] {
  if (raw.length % frameBytes !== 0) throw new Error(`RGB output is not frame-aligned: ${raw.length} bytes`)
  return Array.from({ length: raw.length / frameBytes }, (_, index) => raw.subarray(index * frameBytes, (index + 1) * frameBytes))
}

function meanRegion(frame: Buffer, x: number, y: number, regionWidth: number, regionHeight: number, channel?: number): number {
  let sum = 0
  let count = 0
  for (let row = y; row < Math.min(height, y + regionHeight); row += 1) {
    for (let column = x; column < Math.min(width, x + regionWidth); column += 1) {
      const offset = (row * width + column) * 3
      if (channel === undefined) sum += (frame[offset] ?? 0) + (frame[offset + 1] ?? 0) + (frame[offset + 2] ?? 0)
      else sum += frame[offset + channel] ?? 0
      count += channel === undefined ? 3 : 1
    }
  }
  return sum / Math.max(1, count)
}

function difference(left: Buffer, right: Buffer): number {
  let total = 0
  for (let index = 0; index < frameBytes; index += 1) total += Math.abs((left[index] ?? 0) - (right[index] ?? 0))
  return total / frameBytes
}

function magentaBias(frame: Buffer, x: number, y: number, regionWidth: number, regionHeight: number): number {
  return (meanRegion(frame, x, y, regionWidth, regionHeight, 0) + meanRegion(frame, x, y, regionWidth, regionHeight, 2)) / 2 -
    meanRegion(frame, x, y, regionWidth, regionHeight, 1)
}

describe('CPU real effect combinations', () => {
  beforeAll(() => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    createInputs()
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it('renders timeline speed/freeze/clip transition with zoom, range effects, and animated overlays', () => {
    const request = composition()
    const output = frames(render(request))
    expect(output).toHaveLength(13)

    const fadeFrame = output[3]
    const settledFrame = output[8]
    const freezeFirst = output[10]
    const freezeLast = output[12]
    if (!fadeFrame || !settledFrame || !freezeFirst || !freezeLast) throw new Error('missing effect-boundary frame')

    // Range fade/blur is on the base before visual overlays: the red image remains red while
    // an uncovered base patch darkens during the range transition.
    expect(meanRegion(fadeFrame, 0, 0, 16, 18, 0)).toBeGreaterThan(meanRegion(fadeFrame, 0, 0, 16, 18, 1) + 35)
    expect(meanRegion(fadeFrame, 32, 0, 16, 10)).toBeLessThan(meanRegion(settledFrame, 32, 0, 16, 10) - 20)
    // The animated video and bitmap-like text occupy independent layers and appear only in
    // their active windows; their actual RGB changes catch broken input preparation/order.
    expect(meanRegion(fadeFrame, 48, 0, 16, 18, 1)).toBeGreaterThan(meanRegion(fadeFrame, 48, 0, 16, 18, 0) + 25)
    expect(magentaBias(fadeFrame, 24, 22, 16, 14)).toBeGreaterThan(
      magentaBias(output[1] ?? Buffer.alloc(frameBytes), 24, 22, 16, 14) + 10
    )
    expect(difference(output[1] ?? Buffer.alloc(frameBytes), fadeFrame)).toBeGreaterThan(1)
    expect(difference(output[1] ?? Buffer.alloc(frameBytes), output[4] ?? Buffer.alloc(frameBytes))).toBeGreaterThan(1)
    // After the visual effects and camera ramp end, the freeze segment must hold one source frame.
    expect(difference(freezeFirst, freezeLast)).toBeLessThan(1)
    expect(difference(output[6] ?? Buffer.alloc(frameBytes), output[7] ?? Buffer.alloc(frameBytes))).toBeGreaterThan(0.5)

    const withoutFocus = frames(render({ ...request, focusZooms: [] }))
    const active = output[7]
    const unzoomed = withoutFocus[7]
    if (!active || !unzoomed) throw new Error('missing focus boundary frame')
    expect(difference(active, unzoomed)).toBeGreaterThan(1)
  }, 60_000)

  it('matches a prepared partial render to the full-output slice and preserves source-seek bytes', () => {
    const request = composition()
    const range: PreviewRange = [0.3, 0.9]
    const full = frames(render(request))
    const partial = frames(render(request, range))
    expect(full).toHaveLength(13)
    expect(partial).toHaveLength(6)
    expect(partial).toEqual(full.slice(3, 9))

    const seekRequest: ExportRequest = {
      ...request,
      overlays: [], focusZooms: [], videoTransitions: [],
      segments: [{ id: 'long', sourceId: 'source', sourceStart: 0, sourceEnd: 3.5 }]
    }
    const seekRange: PreviewRange = [2.2, 2.6]
    expect(previewSeekPlan(seekRequest, seekRange)).toBeDefined()
    const fullSeek = frames(render(seekRequest, seekRange))
    const sought = frames(render(seekRequest, seekRange, true))
    expect(sought).toEqual(fullSeek)
  }, 60_000)

  it('keeps image and text overlays visible across a replay segment', () => {
    const image = { ...imageOverlay(), start: 0.4, duration: 1 }
    const text = { ...textOverlay(), start: 0.4, duration: 1 }
    const request = composition({
      segments: [
        { id: 'source', sourceId: 'source', sourceStart: 0, sourceEnd: 0.6 },
        {
          id: 'replay', sourceId: 'source', sourceStart: 0, sourceEnd: 0.6,
          playbackRate: 0.5, replayGroupId: 'replay-one'
        }
      ],
      overlays: [image, text], focusZooms: [], videoTransitions: []
    })
    const output = frames(render(request))
    expect(output).toHaveLength(18)
    const first = output[5]
    const replay = output[10]
    const before = output[2]
    if (!first || !replay || !before) throw new Error('missing replay overlay frame')
    for (const frame of [first, replay]) {
      expect(meanRegion(frame, 0, 0, 16, 18, 0)).toBeGreaterThan(meanRegion(frame, 0, 0, 16, 18, 1) + 15)
      expect(magentaBias(frame, 24, 22, 16, 14)).toBeGreaterThan(magentaBias(before, 24, 22, 16, 14) + 8)
    }
  }, 60_000)
})
