import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
import { ffmpegPath, ffprobePath } from './binaries'
import { buildFilterGraph, prepareTimelineInputs } from './exporter'
import { applyPreviewSeek, preparePreviewSeek, previewSeekPlan, type PreviewSeekPlan } from './preview-seek'
import { previewFilterGraph, validatedPreviewRange, type PreviewRange } from './preview-range'

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./jobs', () => ({ jobs: { run: vi.fn() } }))
vi.mock('./face-worker', () => ({ restrictedIntelRenderNode: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./privileged-export', () => ({ encodeWithPrivilegedGpu: vi.fn() }))
vi.mock('./face-export', () => ({ encodeWithFaces: vi.fn() }))
vi.mock('./face-preview-cache', () => ({ tryReuseFacePreview: vi.fn().mockResolvedValue(false) }))

const width = 64
const height = 36
const range: PreviewRange = [6, 7]
const audioRate = 48_000
const directory = mkdtempSync(join(tmpdir(), 'otc-preview-seek-real-'))
const sources = new Map<number, string>()
const preciseSources = new Map<number, string>()

interface VideoProbe {
  streams?: { width?: number; height?: number; r_frame_rate?: string; duration?: string; codec_name?: string }[]
}

interface AudioProbe {
  streams?: { index?: number }[]
}

function runFfmpeg(args: string[]): void {
  const result = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `ffmpeg exited with ${result.status ?? result.signal}`)
}

function createSource(fps: number, container = 'mkv'): string {
  const path = join(directory, `source-${fps}.${container}`)
  const rate = fps === 60000 / 1001 ? '60000/1001' : String(fps)
  runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${rate}:duration=12`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${audioRate}:duration=12`,
    '-map', '0:v:0', '-map', '1:a:0', '-t', '12', '-c:v', 'ffv1', '-level', '3', '-threads', '1',
    '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', String(audioRate), '-ac', '2', path
  ])
  return path
}

function project(fps: number, sourceStart: number): ExportRequest {
  const path = sources.get(fps)
  if (!path) throw new Error(`missing source for ${fps}`)
  return {
    canvas: { width, height, fps, fit: 'contain' },
    sources: [{ id: 'source', metadata: {
      path, name: 'source.mkv', size: 1, modifiedAt: 1, duration: 12,
      width, height, fps, videoCodec: 'ffv1', hasAudio: true
    } }],
    segments: [{ id: 'segment', sourceId: 'source', sourceStart, sourceEnd: sourceStart + 9 }],
    overlays: [], outputPath: join(directory, `output-${fps}-${sourceStart}.mp4`)
  }
}

async function render(projectRequest: ExportRequest, selectedRange: PreviewRange, seek: boolean, name: string): Promise<{
  video: Buffer; audio: Buffer; seek?: PreviewSeekPlan; segmentCount: number
}> {
  const started = Date.now()
  const args = ['-threads', '1']
  const prepared = seek ? await preparePreviewSeek(projectRequest, selectedRange) : { request: projectRequest, seek: undefined }
  const plan = prepared.seek
  const graphRequest = prepareTimelineInputs(prepared.request, args, plan)
  const base = applyPreviewSeek(buildFilterGraph(graphRequest, []), plan)
  const filter = previewFilterGraph(base, selectedRange)
  const duration = selectedRange[1] - selectedRange[0]
  const videoPath = join(directory, `${name}.rgb`)
  const audioPath = join(directory, `${name}.pcm`)
  runFfmpeg([
    ...args, '-filter_complex_threads', '4', '-filter_complex', filter.graph,
    '-map', `[${filter.videoLabel}]`, '-t', String(duration), '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', videoPath,
    '-map', `[${filter.audioLabel}]`, '-t', String(duration), '-ar', String(audioRate), '-ac', '2', '-f', 's16le', audioPath
  ])
  const output = { video: readFileSync(videoPath), audio: readFileSync(audioPath), seek: plan, segmentCount: graphRequest.segments.length }
  console.info(`PREVIEW_SEEK_RENDER name=${name} wall_ms=${Date.now() - started} video_sha256=${createHash('sha256').update(output.video).digest('hex')} audio_sha256=${createHash('sha256').update(output.audio).digest('hex')}`)
  return output
}

describe('selected-preview input seeking preserves composition bytes', () => {
  beforeAll(() => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    sources.set(30, createSource(30))
    sources.set(60000 / 1001, createSource(60000 / 1001))
    preciseSources.set(30, createSource(30, 'nut'))
    preciseSources.set(60000 / 1001, createSource(60000 / 1001, 'nut'))
  })

  it.each([
    [30, 0, 0, 1], [30, 1, 1, 1], [30, 1.25, 1, 1],
    [60000 / 1001, 0, 0, 1], [60000 / 1001, 1, 1, 1], [60000 / 1001, 1.25, 1, 1],
    [30, 1.25, 1, 2], [60000 / 1001, 1.25, 1, 2], [60000 / 1001, 0, 0, 3]
  ])('seeks a later clip without shifting frames or audio at %s fps, prefix %s, source %s, %s preceding clips', async (fps, prefixStart, sourceStart, preceding) => {
    const later = project(fps, sourceStart)
    const precise = preciseSources.get(fps)
    const source = later.sources[0]
    if (!precise || !source) throw new Error('missing precise-timing test source')
    source.metadata = { ...source.metadata, path: precise }
    const selectedSegment = later.segments[0]
    if (!selectedSegment) throw new Error('missing test segment')
    const prefix = { id: 'prefix', sourceId: 'source', sourceStart: prefixStart, sourceEnd: 9 }
    const before = (9 - prefixStart) * preceding
    const prefixes = Array.from({ length: preceding }, (_, index) => ({ ...prefix, id: `prefix-${index}` }))
    const complete: ExportRequest = { ...later, segments: [...prefixes, selectedSegment], videoTransitions: [
      { id: 'opening', start: 0, duration: 1, into: { effect: 'fade', duration: 1 } },
      { id: 'ending', start: before + 8, duration: 1, out: { effect: 'fade', duration: 1 } }
    ] }
    const selected = validatedPreviewRange([before + 6, before + 7], complete)
    if (!selected) throw new Error('missing selected range')
    const full = await render(complete, selected, false, `later-full-${fps}-${prefixStart}`)
    const narrowed = await render(complete, selected, true, `later-seek-${fps}-${prefixStart}`)
    expect(narrowed.segmentCount).toBe(1)
    expect(narrowed.seek?.audioOffset).toBe(before)
    expect(narrowed.seek?.offset).toBeGreaterThan(selected[0] - 2 - 1 / fps)
    expect(full.video.length).toBe(Math.round((selected[1] - selected[0]) * fps) * width * height * 3)
    expect(narrowed.video.equals(full.video)).toBe(true)
    expect(narrowed.audio.equals(full.audio)).toBe(true)
  }, 60_000)

  it.each([
    ['30fps from source start', 30, 0],
    ['30fps from nonzero source start', 30, 1],
    ['59.94fps from source start', 60000 / 1001, 0],
    ['59.94fps from nonzero source start', 60000 / 1001, 1]
  ])('matches exact RGB frames and audio for %s', async (_name, fps, sourceStart) => {
    const projectRequest = project(fps, sourceStart)
    const plan = previewSeekPlan(projectRequest, range)
    expect(plan?.offset).toBe(Math.floor((range[0] - 2) * fps) / fps)
    const full = await render(projectRequest, range, false, `full-${fps}-${sourceStart}`)
    const sought = await render(projectRequest, range, true, `seek-${fps}-${sourceStart}`)
    expect(sought.video).toEqual(full.video)
    expect(sought.audio).toEqual(full.audio)
  }, 60_000)
})

const optionalProject = process.env.otc_PREVIEW_SEEK_PROJECT

describe('optional selected-project CPU validation', () => {
  it.skipIf(!optionalProject)('matches the later selected range in an existing project', async () => {
    if (!optionalProject) throw new Error('optional project path disappeared')
    const snapshot = JSON.parse(readFileSync(optionalProject, 'utf8')) as ExportRequest
    const request: ExportRequest = { ...snapshot, canvas: { ...snapshot.canvas, width, height }, outputPath: join(directory, 'project-unused.mp4') }
    expect(request.overlays).toHaveLength(0)
    const start = Number(process.env.otc_PREVIEW_SEEK_PROJECT_START ?? snapshot.faceBlurs?.at(-1)?.start)
    const selected = validatedPreviewRange([start, start + 1], request)
    if (!selected) throw new Error('optional project range was unexpectedly empty')
    const started = performance.now()
    const full = await render(request, selected, false, 'project-full')
    const fullMs = performance.now() - started
    const seekStarted = performance.now()
    const sought = await render(request, selected, true, 'project-seek')
    const seekMs = performance.now() - seekStarted
    process.stdout.write(`${JSON.stringify({
      test: 'selected-project', fullMs, seekMs,
      videoEqual: sought.video.equals(full.video), audioEqual: sought.audio.equals(full.audio),
      frames: sought.video.length / (width * height * 3), audioSamples: sought.audio.length / 4,
      selected, preparationStart: sought.seek?.offset, segmentCount: sought.segmentCount
    })}\n`)
    expect(sought.segmentCount).toBe(1)
    expect(sought.seek?.offset).toBeGreaterThan(selected[0] - 2 - 1 / request.canvas.fps)
    expect(sought.video.equals(full.video)).toBe(true)
    expect(sought.audio.equals(full.audio)).toBe(true)
  }, 600_000)
})

const optionalHevc = process.env.otc_PREVIEW_SEEK_HEVC_PATH
const hasOptionalHevc = Boolean(optionalHevc && existsSync(optionalHevc))
const optionalHevcStart = Number(process.env.otc_PREVIEW_SEEK_HEVC_START ?? '204.470933')

function probeOptionalHevc(path: string): { fps: number; duration: number; hasAudio: boolean; codec: string; width: number; height: number } {
  const video = spawnSync(ffprobePath(), [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,duration,codec_name', '-of', 'json', path
  ], { encoding: 'utf8' })
  const audio = spawnSync(ffprobePath(), ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'json', path], { encoding: 'utf8' })
  if (video.status !== 0 || audio.status !== 0) throw new Error('ffprobe failed for optional HEVC input')
  const videoProbe = JSON.parse(video.stdout) as VideoProbe
  const audioProbe = JSON.parse(audio.stdout) as AudioProbe
  const stream = videoProbe.streams?.[0]
  const [numerator, denominator] = (stream?.r_frame_rate ?? '').split('/').map(Number)
  if (numerator === undefined || denominator === undefined) throw new Error('optional HEVC input lacks frame rate metadata')
  const fps = numerator / denominator
  const duration = Number(stream?.duration)
  const hasAudio = Array.isArray(audioProbe.streams) && audioProbe.streams.length > 0
  if (!stream || !Number.isFinite(fps) || !Number.isFinite(duration) || !stream.width || !stream.height || !stream.codec_name) {
    throw new Error('optional HEVC input lacks usable stream metadata')
  }
  return { fps, duration, hasAudio, codec: stream.codec_name, width: stream.width, height: stream.height }
}

describe('optional selected-preview HEVC validation', () => {
  it.skipIf(!hasOptionalHevc)('matches selected RGB frames and audio against the full path', async () => {
    if (!optionalHevc) throw new Error('optional HEVC path disappeared')
    const metadata = probeOptionalHevc(optionalHevc)
    expect(metadata.codec).toMatch(/hevc/i)
    expect(metadata.duration).toBeGreaterThan(optionalHevcStart + 2)
    const initialRequest: ExportRequest = {
      canvas: { width: 64, height: 36, fps: metadata.fps, fit: 'contain' },
      sources: [{ id: 'source', metadata: {
        path: optionalHevc, name: 'optional-hevc', size: 1, modifiedAt: 1, duration: metadata.duration,
        width: metadata.width, height: metadata.height, fps: metadata.fps, videoCodec: metadata.codec, hasAudio: metadata.hasAudio
      } }],
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: optionalHevcStart + 2 }],
      overlays: [], outputPath: join(directory, 'optional-hevc.mp4')
    }
    const selected = validatedPreviewRange([optionalHevcStart, optionalHevcStart + 1], initialRequest)
    if (!selected) throw new Error('optional HEVC range was unexpectedly empty')
    const initialSegment = initialRequest.segments[0]
    if (!initialSegment || initialSegment.kind === 'freeze') throw new Error('optional HEVC segment was unexpectedly empty')
    const request: ExportRequest = { ...initialRequest, segments: [{ ...initialSegment, sourceEnd: selected[1] + 1 }] }
    const full = await render(request, selected, false, 'optional-hevc-full')
    const sought = await render(request, selected, true, 'optional-hevc-seek')
    expect(sought.video).toEqual(full.video)
    expect(sought.audio).toEqual(full.audio)
  }, 600_000)
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})
