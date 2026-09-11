import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  ExportRequest,
  ImageOverlay,
  MediaAnimationPreset,
  Overlay,
  ProjectCanvas
} from '../src/types'

vi.mock('../src/main/binaries', () => ({
  ffmpegPath: () => '/ffmpeg',
  ffprobePath: () => '/ffprobe'
}))
vi.mock('../src/main/jobs', () => ({ jobs: { run: vi.fn() } }))

import { buildFilterGraph } from '../src/main/exporter'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const canvas: ProjectCanvas = { width: 320, height: 180, fps: 24, fit: 'contain' }
const shortCanvas: ProjectCanvas = { width: 180, height: 320, fps: 24, fit: 'cover' }
const animations = ['fade', 'pop', 'bounce', 'shake'] as const
type VideoOverlay = Extract<Overlay, { type: 'video' }>
type AnimatedMediaOverlay = ImageOverlay | VideoOverlay

let directory: string
let basePath: string
let imagePath: string
let videoPath: string

function runFfmpeg(args: string[]): void {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `ffmpeg exited with ${result.status ?? result.signal}`)
}

function createInputs(): void {
  directory = mkdtempSync(join(tmpdir(), 'media-animation-'))
  basePath = join(directory, 'base.mp4')
  imagePath = join(directory, 'overlay.png')
  videoPath = join(directory, 'overlay.mp4')
  runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=black:size=320x180:rate=24:duration=2',
    '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', basePath
  ])
  runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=white:size=64x64:rate=1:duration=1',
    '-frames:v', '1', '-vf', "format=rgba,geq=r='255':g='255':b='255':a='128'", imagePath
  ])
  runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=white:size=64x64:rate=24:duration=1',
    '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', videoPath
  ])
}

function imageOverlay(animation: MediaAnimationPreset, overrides: Partial<ImageOverlay> = {}): ImageOverlay {
  return {
    id: 'image-overlay', type: 'image', name: 'Image overlay', path: imagePath,
    start: 0.5, duration: 1, zIndex: 1, x: 0.25, y: 0.25, width: 0.5, height: 0.5,
    opacity: 0.6, animation, ...overrides
  }
}

function videoOverlay(animation: MediaAnimationPreset, overrides: Partial<VideoOverlay> = {}): VideoOverlay {
  return {
    id: 'video-overlay', type: 'video', name: 'Video overlay', path: videoPath,
    start: 0.5, duration: 1, zIndex: 1, x: 0.25, y: 0.25, width: 0.5, height: 0.5,
    opacity: 0.6, animation, loop: false, audioEnabled: false, hasAudio: false,
    volume: 1, sourceIn: 0, sourceDuration: 1, ...overrides
  }
}

function runOverlayExport(overlay: AnimatedMediaOverlay, projectCanvas = canvas): string {
  const source = {
    path: basePath, name: 'base.mp4', size: 1, modifiedAt: 1, duration: 2,
    width: 320, height: 180, fps: 24, videoCodec: 'h264', hasAudio: false
  }
  const timing = [overlay.duration, overlay.animationDuration ?? 'default', overlay.animationFadeIn ?? 'default', overlay.animationFadeOut ?? 'default'].join('-')
  const request: ExportRequest = {
    canvas: projectCanvas,
    sources: [{ id: 'base', metadata: source }],
    outputPath: join(directory, `${overlay.id}-${overlay.animation ?? 'none'}-${timing}-${projectCanvas.width}x${projectCanvas.height}.mp4`),
    segments: [{ id: 'base-segment', sourceId: 'base', sourceStart: 0, sourceEnd: 2 }],
    overlays: [overlay]
  }
  const { graph, videoLabel } = buildFilterGraph(request, [{ overlay, index: 1 }])
  const output = request.outputPath
  const overlayInput = overlay.type === 'image' ? ['-loop', '1'] : []
  runFfmpeg([
    '-threads', '1', '-i', basePath,
    ...overlayInput, '-i', overlay.path,
    '-filter_complex_threads', '4', '-filter_complex', graph,
    '-map', `[${videoLabel}]`, '-map', '[aout]', '-t', '2',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', output
  ])
  return output
}

function readFrame(path: string, time: number, width: number, height: number): Buffer {
  const frame = execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', path,
    '-ss', String(time), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ])
  expect(frame.length).toBe(width * height * 3)
  return frame
}

function readFrameIndex(path: string, index: number, width: number, height: number): Buffer {
  const frame = execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', path,
    '-vf', `select='eq(n\\,${index})'`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ])
  expect(frame.length).toBe(width * height * 3)
  return frame
}

function meanRegion(frame: Buffer, width: number, height: number, x: number, y: number, regionWidth: number, regionHeight: number): number {
  let sum = 0
  let count = 0
  const top = Math.max(0, Math.min(height, y))
  const bottom = Math.max(top, Math.min(height, y + regionHeight))
  const left = Math.max(0, Math.min(width, x))
  const right = Math.max(left, Math.min(width, x + regionWidth))
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const offset = (row * width + column) * 3
      sum += (frame[offset] ?? 0) + (frame[offset + 1] ?? 0) + (frame[offset + 2] ?? 0)
      count += 3
    }
  }
  return sum / Math.max(1, count)
}

function centerMean(frame: Buffer, width: number, height: number): number {
  return meanRegion(frame, width, height, Math.floor(width / 2) - 4, Math.floor(height / 2) - 4, 8, 8)
}

function difference(left: Buffer, right: Buffer): number {
  let sum = 0
  for (let index = 0; index < left.length; index += 1) sum += Math.abs((left[index] ?? 0) - (right[index] ?? 0))
  return sum / Math.max(1, left.length)
}

function expectSettledOverlay(frame: Buffer, width: number, height: number, alpha: 'half' | 'opaque'): number {
  const center = centerMean(frame, width, height)
  const outside = meanRegion(frame, width, height, 2, 2, 8, 8)
  expect(outside).toBeLessThan(8)
  if (alpha === 'half') {
    expect(center).toBeGreaterThan(45)
    expect(center).toBeLessThan(110)
  } else {
    expect(center).toBeGreaterThan(110)
    expect(center).toBeLessThan(195)
  }
  return center
}

describe('CPU export media animations', () => {
  beforeAll(createInputs)
  afterAll(() => { rmSync(directory, { recursive: true, force: true }) })

  it('renders image and video pop, bounce, shake, and fade animations in their bounds', () => {
    for (const type of ['image', 'video'] as const) {
      for (const animation of animations) {
        const overlay = type === 'image' ? imageOverlay(animation) : videoOverlay(animation)
        const output = runOverlayExport(overlay)
        const early = readFrame(output, 0.58, canvas.width, canvas.height)
        const settled = readFrame(output, 1.1, canvas.width, canvas.height)
        readFrame(output, 1.9, canvas.width, canvas.height)
        expectSettledOverlay(settled, canvas.width, canvas.height, type === 'image' ? 'half' : 'opaque')
        const change = difference(early, settled)
        expect(change).toBeGreaterThan(animation === 'shake' ? 0.1 : 1)
      }
    }
  }, 60_000)

  it('honors custom fade ramps, zero-length ramps, short defaults, and Short geometry', () => {
    for (const type of ['image', 'video'] as const) {
      const overlay = type === 'image'
        ? imageOverlay('fade', { animationFadeIn: 0.4, animationFadeOut: 0.2 })
        : videoOverlay('fade', { animationFadeIn: 0.4, animationFadeOut: 0.2 })
      const output = runOverlayExport(overlay)
      const onset = centerMean(readFrame(output, 0.6, canvas.width, canvas.height), canvas.width, canvas.height)
      const plateau = centerMean(readFrame(output, 1.05, canvas.width, canvas.height), canvas.width, canvas.height)
      const ending = centerMean(readFrame(output, 1.42, canvas.width, canvas.height), canvas.width, canvas.height)
      expect(onset).toBeLessThan(plateau * 0.65)
      expect(ending).toBeLessThan(plateau * 0.65)
      expectSettledOverlay(readFrame(output, 1.05, canvas.width, canvas.height), canvas.width, canvas.height, type === 'image' ? 'half' : 'opaque')
      readFrame(output, 1.9, canvas.width, canvas.height)
    }

    for (const type of ['image', 'video'] as const) {
      const zero = runOverlayExport(type === 'image'
        ? imageOverlay('fade', { animationFadeIn: 0, animationFadeOut: 0 })
        : videoOverlay('fade', { animationFadeIn: 0, animationFadeOut: 0 }))
      const zeroStart = centerMean(readFrame(zero, 0.54, canvas.width, canvas.height), canvas.width, canvas.height)
      const zeroLast = centerMean(readFrameIndex(zero, 35, canvas.width, canvas.height), canvas.width, canvas.height)
      const zeroBoundary = centerMean(readFrameIndex(zero, 36, canvas.width, canvas.height), canvas.width, canvas.height)
      expect(zeroStart).toBeGreaterThan(45)
      expect(zeroLast).toBeGreaterThan(45)
      expect(zeroBoundary).toBeLessThan(8)
    }

    const short = runOverlayExport(imageOverlay('fade', { duration: 0.2 }))
    const shortEarly = centerMean(readFrame(short, 0.54, canvas.width, canvas.height), canvas.width, canvas.height)
    const shortPlateau = centerMean(readFrame(short, 0.62, canvas.width, canvas.height), canvas.width, canvas.height)
    const shortLate = centerMean(readFrame(short, 0.65, canvas.width, canvas.height), canvas.width, canvas.height)
    expect(shortEarly).toBeLessThan(shortPlateau * 0.85)
    expect(shortLate).toBeLessThan(shortPlateau * 0.85)

    const shortCanvasOutput = runOverlayExport(imageOverlay('fade', { animationFadeIn: 0, animationFadeOut: 0 }), shortCanvas)
    const shortFrame = readFrame(shortCanvasOutput, 1, shortCanvas.width, shortCanvas.height)
    readFrame(shortCanvasOutput, 1.9, shortCanvas.width, shortCanvas.height)
    expectSettledOverlay(shortFrame, shortCanvas.width, shortCanvas.height, 'half')
    const fullShort = runOverlayExport(videoOverlay('pop', { x: 0, y: 0, width: 1, height: 1 }), shortCanvas)
    const fullShortFrame = readFrame(fullShort, 1.1, shortCanvas.width, shortCanvas.height)
    readFrame(fullShort, 1.9, shortCanvas.width, shortCanvas.height)
    const fullShortCorner = meanRegion(fullShortFrame, shortCanvas.width, shortCanvas.height, 2, 2, 8, 8)
    const fullShortCenter = centerMean(fullShortFrame, shortCanvas.width, shortCanvas.height)
    expect(fullShortCorner).toBeGreaterThan(110)
    expect(fullShortCenter).toBeGreaterThan(110)
  }, 60_000)

  it('honors motion duration and zero-length motion in exported media', () => {
    for (const type of ['image', 'video'] as const) {
      for (const animation of ['pop', 'bounce', 'shake'] as const) {
        const overlay = type === 'image' ? imageOverlay(animation) : videoOverlay(animation)
        const output = runOverlayExport({ ...overlay, animationDuration: 0.8 })
        // Sample early enough that Shake's decaying displacement survives pixel rounding.
        const moving = readFrameIndex(output, 15, canvas.width, canvas.height)
        const settled = readFrameIndex(output, 33, canvas.width, canvas.height)
        expect(difference(moving, settled)).toBeGreaterThan(animation === 'shake' ? 0.1 : 1)
        const instant = runOverlayExport({ ...overlay, animationDuration: 0 })
        const first = readFrameIndex(instant, 13, canvas.width, canvas.height)
        const last = readFrameIndex(instant, 33, canvas.width, canvas.height)
        expect(difference(first, last)).toBeLessThan(0.2)
        expectSettledOverlay(first, canvas.width, canvas.height, type === 'image' ? 'half' : 'opaque')
      }
    }
  }, 60_000)
})
