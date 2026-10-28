import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
import { ffmpegPath } from './binaries'
import { buildFilterGraph, prepareTimelineInputs } from './exporter'
import { applyPreviewSeek, preparePreviewSeek, previewSeekPlan, type PreviewSeekPlan } from './preview-seek'
import { previewFilterGraph, validatedPreviewRange, type PreviewRange } from './preview-range'

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./jobs', () => ({ jobs: { run: vi.fn() } }))
vi.mock('./intel-device', () => ({ restrictedIntelRenderNode: vi.fn().mockResolvedValue(undefined) }))
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

function createHevcSource(): string {
  const path = join(directory, 'long-gop-hevc.mkv')
  runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x48:rate=24:duration=6`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${audioRate}:duration=6`,
    '-map', '0:v:0', '-map', '1:a:0', '-t', '6',
    '-af', 'asetpts=PTS+0.125/TB',
    '-c:v', 'libx265', '-preset', 'ultrafast',
    '-x265-params', 'keyint=48:min-keyint=48:scenecut=0:open-gop=0:pools=1:frame-threads=1:log-level=error',
    '-threads', '1', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-ar', String(audioRate), '-ac', '2', path
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

describe('generated long-GOP HEVC selected-preview validation', () => {
  let hevcSource: string

  beforeAll(() => {
    hevcSource = createHevcSource()
  })

  it('matches selected RGB frames and audio for nonzero source offsets in a later clip', async () => {
    const fps = 24
    const metadata = {
      path: hevcSource, name: 'generated-long-gop-hevc.mkv', size: 1, modifiedAt: 1, duration: 6,
      width, height: 48, fps, videoCodec: 'hevc', hasAudio: true
    }
    const request: ExportRequest = {
      canvas: { width, height: 48, fps, fit: 'contain' },
      sources: [{ id: 'source', metadata }],
      segments: [
        { id: 'prefix', sourceId: 'source', sourceStart: 0.5, sourceEnd: 2.5 },
        { id: 'selected', sourceId: 'source', sourceStart: 1, sourceEnd: 5.5 }
      ],
      overlays: [], outputPath: join(directory, 'generated-hevc-unused.mp4')
    }
    const selected = validatedPreviewRange([4.1, 5.1], request)
    if (!selected) throw new Error('generated HEVC range was unexpectedly empty')
    const full = await render(request, selected, false, 'generated-hevc-full')
    const sought = await render(request, selected, true, 'generated-hevc-seek')
    expect(sought.segmentCount).toBe(1)
    expect(sought.seek?.audioOffset).toBe(2)
    expect(sought.seek?.offset).toBeGreaterThan(selected[0] - 2 - 1 / fps)
    expect(sought.video).toEqual(full.video)
    expect(sought.audio).toEqual(full.audio)
  }, 60_000)
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})
