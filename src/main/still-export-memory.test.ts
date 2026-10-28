import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, ImageOverlay, TextOverlay } from '../types'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./binaries', () => ({
  ffmpegPath: () => join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  ffprobePath: () => join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe')
}))
vi.mock('./jobs', () => ({ jobs: { run: vi.fn() } }))
vi.mock('./intel-device', () => ({ restrictedIntelRenderNode: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./privileged-export', () => ({ encodeWithPrivilegedGpu: vi.fn() }))
vi.mock('./face-export', () => ({ encodeWithFaces: vi.fn() }))
vi.mock('./face-preview-cache', () => ({ tryReuseFacePreview: vi.fn().mockResolvedValue(false) }))

import { buildFilterGraph } from './exporter'
import { overlayInputArgs } from './export-inputs'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const width = 64
const height = 48
const fps = 25
const duration = 1.2
const overlayStart = 0.17
const overlayDuration = 0.73
const frameBytes = width * height * 3

let directory: string
let sourcePath: string
let imagePath: string
let textDataUrl: string
const baseFrames = new Map<number, Buffer>()

interface RenderedGraph {
  raw: Buffer
  pts: number[]
}

function runFfmpeg(args: string[], loglevel = 'error'): { stdout: Buffer; stderr: string } {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', loglevel, '-nostdin', '-y', ...args], {
    encoding: 'buffer',
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1' },
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.error) throw result.error
  const stderr = result.stderr.toString('utf8')
  if (result.status !== 0) {
    throw new Error(`ffmpeg exited with ${result.status ?? result.signal}: ${stderr.trim()}`)
  }
  return { stdout: result.stdout, stderr }
}

function assertPatternedAlpha(path: string, expectedWidth: number, expectedHeight: number): void {
  const raw = runFfmpeg([
    '-i', path, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'
  ]).stdout
  expect(raw).toHaveLength(expectedWidth * expectedHeight * 4)
  const alpha = Array.from({ length: raw.length / 4 }, (_, index) => raw[index * 4 + 3] ?? 0)
  expect(Math.max(...alpha)).toBeGreaterThan(0)
  expect(Math.min(...alpha)).toBeLessThan(255)
}

function createFixtures(): void {
  directory = mkdtempSync(join(tmpdir(), 'otc-still-export-memory-'))
  sourcePath = join(directory, 'source.mkv')
  imagePath = join(directory, 'image.png')
  const textPath = join(directory, 'text.png')
  runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=2`,
    '-an', '-c:v', 'ffv1', '-threads', '1', '-pix_fmt', 'yuv420p', sourcePath
  ])
  runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=black@0.0:size=18x12:rate=1,format=rgba',
    '-vf', 'drawbox=x=0:y=0:w=9:h=6:color=red@0.7:t=fill:replace=1,drawbox=x=9:y=6:w=9:h=6:color=white@0.3:t=fill:replace=1',
    '-frames:v', '1', '-pix_fmt', 'rgba', imagePath
  ])
  runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=black@0.0:size=2x2:rate=1,format=rgba',
    '-vf', 'drawbox=x=0:y=0:w=1:h=1:color=magenta@0.7:t=fill:replace=1,drawbox=x=1:y=1:w=1:h=1:color=white@0.3:t=fill:replace=1',
    '-frames:v', '1', '-pix_fmt', 'rgba', textPath
  ])
  assertPatternedAlpha(imagePath, 18, 12)
  assertPatternedAlpha(textPath, 2, 2)
  textDataUrl = `data:image/png;base64,${readFileSync(textPath).toString('base64')}`
}

function sourceMetadata(): ExportRequest['sources'][number]['metadata'] {
  return {
    path: sourcePath,
    name: 'synthetic-still-memory-source.mkv',
    size: 1,
    modifiedAt: 1,
    duration: 2,
    width,
    height,
    fps,
    videoCodec: 'ffv1',
    hasAudio: false
  }
}

function textOverlay(animation?: TextOverlay['animation'], opacity = 0.9): TextOverlay {
  return {
    id: `text-${animation ?? 'static'}`,
    type: 'text',
    name: `synthetic ${animation ?? 'static'} text`,
    start: overlayStart,
    duration: overlayDuration,
    zIndex: 1,
    x: 0.25,
    y: 0.25,
    width: 0.5,
    height: 0.25,
    opacity,
    text: 'STILL',
    fontFamily: 'sans-serif',
    fontSize: 12,
    color: '#fff',
    outlineColor: '#000',
    outlineWidth: 1,
    shadow: false,
    align: 'center',
    ...(animation ? { animation, animationDuration: 0.35, animationFadeIn: 0.2, animationFadeOut: 0.2 } : {}),
    renderedTextBitmap: { dataUrl: textDataUrl, x: 8, y: 8, anchorX: 18, anchorY: 12 }
  }
}

function imageOverlay(animation: Exclude<ImageOverlay['animation'], undefined> | null = 'fade', opacity = 0.9): ImageOverlay {
  return {
    id: 'image-fade',
    type: 'image',
    name: 'synthetic fading image',
    path: imagePath,
    start: overlayStart,
    duration: overlayDuration,
    zIndex: 1,
    x: 0.25,
    y: 0.25,
    width: 0.5,
    height: 0.5,
    opacity,
    ...(animation !== null ? { animation, animationFadeIn: 0.2, animationFadeOut: 0.2 } : {})
  }
}

function request(overlay?: TextOverlay | ImageOverlay, canvasFps = fps): ExportRequest {
  return {
    canvas: { width, height, fps: canvasFps, fit: 'contain' },
    sources: [{ id: 'source', metadata: sourceMetadata() }],
    segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: duration }],
    overlays: overlay ? [overlay] : [],
    outputPath: join(directory, 'unused.mp4')
  }
}

function stripStillTpad(graph: string): string {
  return graph.replace(/tpad=stop_mode=clone:stop_duration=[0-9.]+,trim=/g, 'trim=')
}

function restoreLegacyIdentityMixers(graph: string): string {
  return graph.replace(/,null(\[ov\d+\])/g, ',colorchannelmixer=aa=1$1')
}

function renderGraph(inputArgs: string[], graph: string, videoLabel: string, frameRate = fps): RenderedGraph {
  const frameCount = Math.round(duration * frameRate)
  const checkedGraph = `${graph};[aout]anullsink;[${videoLabel}]showinfo[checked]`
  const result = runFfmpeg([
    ...inputArgs,
    '-filter_threads', '1',
    '-filter_complex_threads', '1',
    '-filter_complex', checkedGraph,
    '-map', '[checked]',
    '-frames:v', String(frameCount),
    '-fps_mode', 'passthrough',
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    'pipe:1'
  ], 'info')
  const pts = Array.from(result.stderr.matchAll(/pts:\s*(-?\d+)\s+pts_time:([-+0-9.]+)/g), (match) => Number(match[2]))
  if (pts.length !== frameCount) {
    const showinfo = result.stderr.split('\n').filter((line) => line.includes('showinfo')).slice(-3).join('\n')
    throw new Error(`expected ${frameCount} showinfo timestamps, got ${pts.length}: ${showinfo}`)
  }
  if (result.stdout.length % frameBytes !== 0) {
    throw new Error(`unexpected raw RGB size ${result.stdout.length}`)
  }
  return { raw: result.stdout, pts }
}

async function renderPair(overlay: TextOverlay | ImageOverlay, canvasFps = fps): Promise<{
  current: RenderedGraph
  baseline: RenderedGraph
  currentArgs: string[]
  graph: string
}> {
  const project = request(overlay, canvasFps)
  const currentArgs = ['-threads', '1', '-i', sourcePath]
  const baselineArgs = [...currentArgs]
  const prepared = []
  for (const [index, currentOverlay] of project.overlays.entries()) {
    const args = await overlayInputArgs(currentOverlay, directory)
    expect(args).not.toContain('-loop')
    currentArgs.push(...args)
    // Reconstruct the pre-fix input: an image2 stream looped at its 25-fps default.
    baselineArgs.push('-loop', '1', '-framerate', String(fps), ...args)
    prepared.push({ overlay: currentOverlay, index: index + 1 })
  }
  const filter = buildFilterGraph(project, prepared)
  expect(filter.graph).toContain(`tpad=stop_mode=clone:stop_duration=${overlayDuration.toFixed(6)},trim=`)
  const baselineGraph = restoreLegacyIdentityMixers(stripStillTpad(filter.graph))
  if (overlay.opacity === 1) {
    expect(filter.graph).toContain(',null[ov')
    expect(baselineGraph).toContain(',colorchannelmixer=aa=1[ov')
  }
  return {
    current: renderGraph(currentArgs, filter.graph, filter.videoLabel, canvasFps),
    baseline: renderGraph(baselineArgs, baselineGraph, filter.videoLabel, canvasFps),
    currentArgs,
    graph: filter.graph
  }
}

function baseRender(frameRate: number): Buffer {
  const cached = baseFrames.get(frameRate)
  if (cached) return cached
  const project = request(undefined, frameRate)
  const filter = buildFilterGraph(project, [])
  const raw = renderGraph(['-threads', '1', '-i', sourcePath], filter.graph, filter.videoLabel, frameRate).raw
  baseFrames.set(frameRate, raw)
  return raw
}

function differentFrames(left: Buffer, right: Buffer, frameCount: number): number[] {
  return Array.from({ length: frameCount }, (_, index) => index)
    .filter((index) => !left.subarray(index * frameBytes, (index + 1) * frameBytes)
      .equals(right.subarray(index * frameBytes, (index + 1) * frameBytes)))
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('CPU still-overlay export memory regression', () => {
  beforeAll(() => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    createFixtures()
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    ['static text', () => textOverlay()],
    ['opaque static text', () => textOverlay(undefined, 1)],
    ['animated text fade', () => textOverlay('fade')],
    ['animated text pop', () => textOverlay('pop')],
    ['image fade', () => imageOverlay()],
    ['opaque static image', () => imageOverlay(null, 1)]
  ])('keeps %s pixels and frame timing after still-input reduction', async (_name, makeOverlay) => {
    const result = await renderPair(makeOverlay())
    expect(result.current.raw.length).toBe(frameBytes * Math.round(duration * fps))
    const frameCount = Math.round(duration * fps)
    expect(differentFrames(result.current.raw, result.baseline.raw, frameCount)).toEqual([])
    expect(differentFrames(result.current.raw, baseRender(fps), frameCount).length).toBeGreaterThan(0)
    expect(sha256(result.current.raw)).toBe(sha256(result.baseline.raw))
    expect(result.current.pts).toEqual(result.baseline.pts)
    expect(result.current.pts).toHaveLength(Math.round(duration * fps))
    expect(result.current.pts[0]).toBe(0)
    expect(result.current.pts[1]).toBeCloseTo(1 / fps, 6)
    expect(result.currentArgs).not.toContain('-loop')
    expect(result.graph).toMatch(/tpad=stop_mode=clone:stop_duration=0\.730000,trim=/)
  }, 60_000)

  it('keeps a 60-fps canvas upsample byte-identical to the legacy still stream', async () => {
    const result = await renderPair(textOverlay('pop'), 60)
    const frameCount = Math.round(duration * 60)
    expect(result.current.raw.length).toBe(frameBytes * frameCount)
    expect(differentFrames(result.current.raw, result.baseline.raw, frameCount)).toEqual([])
    expect(differentFrames(result.current.raw, baseRender(60), frameCount).length).toBeGreaterThan(0)
    expect(sha256(result.current.raw)).toBe(sha256(result.baseline.raw))
    expect(result.current.pts).toEqual(result.baseline.pts)
    expect(result.current.pts).toHaveLength(frameCount)
    expect(result.current.pts[0]).toBe(0)
    expect(result.current.pts[1]).toBeCloseTo(1 / 60, 6)
    expect(result.currentArgs).not.toContain('-loop')
    expect(result.graph).toMatch(/tpad=stop_mode=clone:stop_duration=0\.730000,trim=/)
  }, 60_000)
})
