import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, ImageOverlay } from '../types'
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
import { previewFilterGraph, validatedPreviewRange, type PreviewRange } from './preview-range'
import { createSession } from '../renderer/src/model/timeline'
import { insertSourceAtOutputTime } from '../renderer/src/model/segment-ranges'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const width = 64
const height = 36
const fps = 30
const audioRate = 48_000
const audioChannels = 2
const rgbFrameBytes = width * height * 3
const audioSampleBytes = audioChannels * 4

let directory: string
let sourcePath: string
let overlayPath: string

function runFfmpeg(args: string[]): void {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `ffmpeg exited with ${result.status ?? result.signal}`)
}

function createInputs(): void {
  directory = mkdtempSync(join(tmpdir(), 'otc-preview-range-real-'))
  sourcePath = join(directory, 'source.mkv')
  overlayPath = join(directory, 'overlay.png')
  runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=4`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${audioRate}:duration=4`,
    '-map', '0:v:0', '-map', '1:a:0', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', String(audioRate), '-ac', String(audioChannels), sourcePath
  ])
  runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=red:size=16x16:rate=1`, '-frames:v', '1', '-pix_fmt', 'rgba', overlayPath
  ])
}

function request(): ExportRequest {
  const source = {
    path: sourcePath, name: 'source.mp4', size: 1, modifiedAt: 1, duration: 4,
    width, height, fps, videoCodec: 'h264', hasAudio: true
  }
  const overlay: ImageOverlay = {
    id: 'overlay', type: 'image', name: 'red overlay', path: overlayPath,
    start: 1, duration: 1, zIndex: 1, x: 0.25, y: 0.25, width: 0.5, height: 0.5,
    opacity: 0.9, animation: 'fade', animationFadeIn: 0.25, animationFadeOut: 0.25
  }
  return {
    canvas: { width, height, fps, fit: 'contain' },
    sources: [{ id: 'source', metadata: source }],
    segments: [
      { id: 'fast', sourceId: 'source', sourceStart: 0, sourceEnd: 1, playbackRate: 2 },
      { kind: 'freeze', id: 'freeze', sourceId: 'source', sourceTime: 1.5, duration: 0.5 },
      { id: 'slow', sourceId: 'source', sourceStart: 2, sourceEnd: 3, playbackRate: 0.5 }
    ],
    overlays: [overlay],
    videoTransitions: [{
      id: 'video-transition', start: 0, duration: 3,
      into: { effect: 'dissolve', duration: 0.25 },
      out: { effect: 'hblur', duration: 0.25 }
    }],
    outputPath: join(directory, 'unused.mp4')
  }
}

function rawOutputs(project: ExportRequest, range: PreviewRange | undefined, name: string): { video: Buffer; audio: Buffer } {
  const inputArgs = ['-threads', '1']
  const graphRequest = prepareTimelineInputs(project, inputArgs)
  if (project.overlays.length) inputArgs.push('-loop', '1', '-i', overlayPath)
  const baseFilter = buildFilterGraph(graphRequest, graphRequest.overlays.map((overlay, index) => ({ overlay, index: graphRequest.sources.length + index })))
  const filter = previewFilterGraph(baseFilter, range)
  const duration = range ? range[1] - range[0] : timelineDuration(project.segments)
  const videoPath = join(directory, `${name}.rgb`)
  const audioPath = join(directory, `${name}.pcm`)
  runFfmpeg([
    ...inputArgs, '-filter_complex_threads', '4', '-filter_complex', `${filter.graph};[${filter.videoLabel}]format=yuv420p[testvideo]`,
    '-map', '[testvideo]', '-t', String(duration), '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', videoPath,
    '-map', `[${filter.audioLabel}]`, '-t', String(duration), '-ar', String(audioRate), '-ac', String(audioChannels), '-f', 'f32le', audioPath
  ])
  return { video: readFileSync(videoPath), audio: readFileSync(audioPath) }
}

function frames(raw: Buffer): Buffer[] {
  if (raw.length % rgbFrameBytes !== 0) throw new Error(`RGB output is not frame-aligned: ${raw.length} bytes`)
  return Array.from({ length: raw.length / rgbFrameBytes }, (_, index) => raw.subarray(index * rgbFrameBytes, (index + 1) * rgbFrameBytes))
}

function meanChannel(frame: Buffer, channel: number, x: number, y: number, regionWidth: number, regionHeight: number): number {
  let sum = 0
  let count = 0
  for (let row = y; row < y + regionHeight; row += 1) {
    for (let column = x; column < x + regionWidth; column += 1) {
      sum += frame[(row * width + column) * 3 + channel] ?? 0
      count += 1
    }
  }
  return sum / Math.max(1, count)
}

describe('CPU selected-preview composition', () => {
  beforeAll(() => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    createInputs()
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it('matches the selected RGB frames and audio duration to the full composition', () => {
    const project = request()
    const range = validatedPreviewRange([2 / fps - 0.00001, 62 / fps - 0.00001], project)
    if (!range) throw new Error('expected a nonzero selected range')
    expect(range).toEqual([2 / fps, 62 / fps])

    const full = rawOutputs(project, undefined, 'full')
    const partial = rawOutputs(project, range, 'partial')
    const fullFrames = frames(full.video)
    const partialFrames = frames(partial.video)
    const startFrame = Math.round(range[0] * fps)

    expect(fullFrames).toHaveLength(Math.round(timelineDuration(project.segments) * fps))
    expect(partialFrames).toHaveLength(Math.round((range[1] - range[0]) * fps))
    for (const [index, frame] of partialFrames.entries()) {
      expect(frame).toEqual(fullFrames[startFrame + index])
    }

    // The middle segment is a freeze; the animated overlay starts later, so these frames must clone exactly.
    expect(fullFrames[16]).toEqual(fullFrames[28])
    // The selected span includes the animated overlay and both speed-changed segments.
    const overlayRamp = fullFrames[35]
    const overlayPlateau = fullFrames[45]
    if (!overlayRamp || !overlayPlateau) throw new Error('expected overlay frames')
    const rampContrast = meanChannel(overlayRamp, 0, 16, 9, 32, 18) - meanChannel(overlayRamp, 1, 16, 9, 32, 18)
    const plateauContrast = meanChannel(overlayPlateau, 0, 16, 9, 32, 18) - meanChannel(overlayPlateau, 1, 16, 9, 32, 18)
    expect(rampContrast).toBeGreaterThan(20)
    expect(plateauContrast).toBeGreaterThan(rampContrast + 10)

    const expectedFullAudio = Math.round(timelineDuration(project.segments) * audioRate) * audioSampleBytes
    const expectedPartialAudio = Math.round((range[1] - range[0]) * audioRate) * audioSampleBytes
    const audioTolerance = audioRate * audioSampleBytes * 0.02
    expect(Math.abs(full.audio.length - expectedFullAudio)).toBeLessThan(audioTolerance)
    expect(partial.audio.length).toBe(expectedPartialAudio)
  }, 60_000)

  it('renders a moving overlap when appending at physical source EOF', () => {
    const project = request()
    const source = project.sources[0]
    if (!source) throw new Error('missing source')
    const grayPath = join(directory, 'eof-motion.mkv')
    const blackPath = join(directory, 'insert-black.mkv')
    runFfmpeg(['-i', sourcePath, '-vf', 'hue=s=0', '-c:v', 'ffv1', '-threads', '1', '-c:a', 'copy', grayPath])
    runFfmpeg(['-f', 'lavfi', '-i', `color=black:size=${width}x${height}:rate=${fps}:duration=2`, '-c:v', 'ffv1', '-threads', '1', blackPath])
    const session = createSession({ ...source.metadata, path: grayPath })
    const reference = frames(rawOutputs({ ...project, ...session }, undefined, 'eof-reference').video)
    const inserted = insertSourceAtOutputTime(session, {
      id: 'black', playbackPath: blackPath, waveform: [],
      metadata: { ...source.metadata, path: blackPath, duration: 2, hasAudio: false }
    }, 4, { into: { effect: 'fade', duration: 1 } })
    const result = frames(rawOutputs({ ...project, ...inserted }, undefined, 'eof-overlap').video)
    expect(result).toHaveLength(5 * fps)
    for (const frameIndex of [96, 108]) {
      const frame = result[frameIndex]
      const movingSource = reference[frameIndex]
      if (!frame || !movingSource) throw new Error('missing overlap frame')
      const weight = 1 - (frameIndex / fps - 3)
      const meanError = frame.reduce((sum, value, byte) => sum + Math.abs(value - (movingSource[byte] ?? 0) * weight), 0) / frame.length
      expect(meanError).toBeLessThan(3)
    }
  })

  it('renders continuing footage through a transition without changing timeline duration', () => {
    const project = request()
    // Neutral chroma isolates motion continuity from xfade's chroma resampling.
    const grayscale = join(directory, 'motion.mkv')
    runFfmpeg(['-i', sourcePath, '-vf', 'hue=s=0', '-c:v', 'ffv1', '-threads', '1', '-c:a', 'copy', grayscale])
    const source = project.sources[0]
    if (!source) throw new Error('missing test source')
    source.metadata = { ...source.metadata, path: grayscale }
    project.segments = [
      { id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 1.5 },
      { id: 'second', sourceId: 'source', sourceStart: 1.5, sourceEnd: 3, transition: { effect: 'dissolve', duration: 0.5 } }
    ]
    project.videoTransitions = []
    project.overlays = []
    const output = rawOutputs(project, undefined, 'moving-transition')
    expect(frames(output.video)).toHaveLength(3 * fps)
    // Adjacent cuts of the same source must remain continuous through a fade.
    project.segments[1] = { id: 'second', sourceId: 'source', sourceStart: 1.5, sourceEnd: 3, transition: { effect: 'fade', duration: 0.5 } }
    const transitioned = frames(rawOutputs(project, undefined, 'continuous-transition').video)
    project.segments = [{ id: 'whole', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }]
    const original = frames(rawOutputs(project, undefined, 'continuous-original').video)
    for (let index = Math.round(1.5 * fps); index < 2 * fps; index++) {
      const a = transitioned[index]
      const b = original[index]
      if (!a || !b) throw new Error('missing transition frame')
      const meanError = a.reduce((sum, value, byte) => sum + Math.abs(value - (b[byte] ?? 0)), 0) / a.length
      expect(meanError).toBeLessThan(2)
    }
  }, 60_000)
})
