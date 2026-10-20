import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiEnhancementMode, ExportRequest, JobProgress } from '../types'
import { aiEnhancementPlan, type AiEnhancementPlan } from '../ai-enhancement'

type ElectronSend = (...args: unknown[]) => void
const electronMock = vi.hoisted(() => ({ send: undefined as ElectronSend | undefined }))
vi.mock('electron', async () => {
  const { homedir } = await import('node:os')
  const path = await import('node:path')
  return {
    app: { isPackaged: false, getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`Unexpected Electron path: ${name}`)
      const configHome = process.env.XDG_CONFIG_HOME ?? ''
      return path.join(configHome.length > 0 ? configHome : path.join(homedir(), '.config'), 'OneTrackCat')
    } },
    BrowserWindow: { getAllWindows: () => electronMock.send
      ? [{ webContents: { send: electronMock.send } }]
      : [] }
  }
})

import { ffmpegPath, ffprobePath } from './binaries'
import { encodeWithAi } from './ai-export'
import { requireAiPack, type AiPack } from './ai-pack'
import { cancelFaceExport, hasActiveFaceExports } from './face-process'
import { buildFilterGraph } from './exporter'

const width = 160
const height = 90
const sourceFps = 24
const sourceFrames = 3
const duration = sourceFrames / sourceFps
const outputFps = 60
const expectedOutputFrames = Math.ceil(duration * outputFps)

interface MediaStream {
  codec_type?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  nb_read_frames?: string
  duration?: string
  tags?: Record<string, string>
}

interface MediaProbe {
  format?: { duration?: string; tags?: Record<string, string> }
  streams?: MediaStream[]
  chapters?: unknown[]
}

function probeMedia(path: string): MediaProbe {
  return JSON.parse(execFileSync(ffprobePath(), [
    '-v', 'error', '-count_frames', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', path
  ], { encoding: 'utf8' })) as MediaProbe
}

function stream(probe: MediaProbe, kind: string): MediaStream {
  const result = probe.streams?.find((candidate) => candidate.codec_type === kind)
  if (!result) throw new Error(`${kind} stream is missing`)
  return result
}

function rational(value: string | undefined): number {
  const parts = (value ?? '0/1').split('/').map(Number)
  const numerator = parts[0] ?? 0
  const denominator = parts[1] ?? 1
  return denominator ? numerator / denominator : 0
}

function createFixture(ffmpeg: string, path: string, width: number, height: number, fps: number, frames: number, duration: number): void {
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-hwaccel', 'none', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=1`, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1',
    '-map', '0:v:0', '-map', '1:a:0', '-frames:v', String(frames), '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-shortest', '-movflags', 'use_metadata_tags',
    '-metadata', 'title=PRIVATE TITLE', '-metadata', 'artist=PRIVATE AUTHOR', '-metadata', 'location=PRIVATE LOCATION', path
  ])
}

async function sourceSnapshot(path: string): Promise<Buffer> {
  const sourceMetadata = JSON.stringify(probeMedia(path))
  expect(sourceMetadata).toContain('PRIVATE AUTHOR')
  expect(sourceMetadata).toContain('PRIVATE LOCATION')
  return readFile(path)
}

async function expectExportOutput(
  ffmpeg: string,
  input: string,
  output: string,
  sourceBefore: Buffer,
  width: number,
  height: number,
  fps: number,
  expectedFrames: number,
  duration: number
): Promise<void> {
  const result = probeMedia(output)
  const video = stream(result, 'video')
  const audio = stream(result, 'audio')
  expect(video.width).toBe(width)
  expect(video.height).toBe(height)
  expect(rational(video.avg_frame_rate ?? video.r_frame_rate)).toBeCloseTo(fps, 5)
  expect(Number(video.nb_read_frames)).toBe(expectedFrames)
  expect(Math.abs(Number(result.format?.duration) - duration)).toBeLessThanOrEqual(1 / fps + 0.01)
  expect(audio.codec_type).toBe('audio')
  expect(execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', output, '-map', '0:a:0', '-f', 's16le', 'pipe:1'
  ], { maxBuffer: 2 * 1024 * 1024 }).length).toBeGreaterThan(1_000)
  const outputMetadata = JSON.stringify(result)
  expect(outputMetadata).not.toContain('PRIVATE AUTHOR')
  expect(outputMetadata).not.toContain('PRIVATE LOCATION')
  expect(result.chapters ?? []).toHaveLength(0)
  expect(await readFile(input)).toEqual(sourceBefore)
}

function testMode(): AiEnhancementMode {
  const mode = process.env.otc_AI_TEST_MODE ?? 'turbo'
  if (mode !== 'turbo' && mode !== 'base') throw new Error('otc_AI_TEST_MODE must be turbo or base')
  return mode
}

async function testPack(spatial: boolean, mode?: AiEnhancementMode): Promise<AiPack> {
  const directory = process.env.otc_AI_TEST_PACK_DIR
  if (!spatial) return requireAiPack(directory ? { spatial: false, directory } : { spatial: false })
  if (!mode) throw new Error('A FlashVSR+ mode is required for the spatial test')
  const modelsRoot = process.env.otc_AI_TEST_MODELS_DIR
  if (!modelsRoot) throw new Error('otc_AI_TEST_MODELS_DIR is required for the spatial test')
  const models = join(modelsRoot, mode)
  if (!(await stat(models)).isDirectory()) throw new Error(`AI test models directory is missing: ${models}`)
  const runtime = await requireAiPack(directory ? { spatial: false, directory } : { spatial: false })
  return { ...runtime, mode, models }
}

afterEach(() => {
  electronMock.send = undefined
  vi.unstubAllEnvs()
})

describe.skipIf(process.env.otc_AI_PACK_TEST !== '1')('real CPU AI export pipeline', () => {
  it('interpolates a tiny video while retaining audio and stripping metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-ai-export-real-'))
    try {
      vi.stubEnv('otc_CPU_ONLY', '1')
      const ffmpeg = ffmpegPath()
      const input = join(directory, 'input.mp4')
      const output = join(directory, 'output.mp4')

      createFixture(ffmpeg, input, width, height, sourceFps, sourceFrames, duration)

      const sourceBefore = await sourceSnapshot(input)

      const request: ExportRequest = {
        canvas: { width, height, fps: sourceFps, fit: 'contain' },
        sources: [], segments: [], overlays: [], outputPath: output, aiEnhance: {}
      }
      // Resolve a tiny RIFE-only context for this real pipeline test. UHD Flash
      // restoration is qualified separately on its required discrete GPU.
      const plan: AiEnhancementPlan = {
        canvas: { ...request.canvas, fps: outputFps },
        spatial: false, interpolate: true, mode: 'turbo'
      }
      const pack = await testPack(false)
      await encodeWithAi(request, ['-hide_banner', '-y', '-i', input], {
        graph: '[0:v:0]format=rgb24[vout];[0:a:0]anull[aout]', videoLabel: 'vout', audioLabel: 'aout'
      }, directory, output, duration, 'real-ai-export', { plan, pack })
      await expectExportOutput(ffmpeg, input, output, sourceBefore, width, height, outputFps, expectedOutputFrames, duration)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)
})

async function runGpuSpatialExport(cancelOnProgress: boolean, portrait = false): Promise<void> {
  if (process.env.otc_CPU_ONLY === '1') throw new Error('The spatial test requires GPU execution')
  const workRoot = process.env.otc_AI_TEST_WORK_ROOT
  if (!workRoot) throw new Error('otc_AI_TEST_WORK_ROOT is required for the spatial test')
  if (!(await stat(workRoot)).isDirectory()) throw new Error(`AI test work root is missing: ${workRoot}`)
  const mode = testMode()
  const pack = await testPack(true, mode)
  const gpuWidth = portrait ? 1080 : 3840, gpuHeight = portrait ? 1920 : 2160
  // Exercise the fractional near-60 zoom/padding boundary from the reported failure.
  const gpuFps = portrait ? 30 : 58.436707235803205, gpuFrames = 4, gpuDuration = gpuFrames / gpuFps, rangeStart = 1 / gpuFps
  const outputWidth = portrait ? 2160 : gpuWidth, outputHeight = portrait ? 3840 : gpuHeight
  const jobId = cancelOnProgress ? 'real-gpu-ai-export-cancel' : 'real-gpu-ai-export'
  const hardware = new Set<string>()
  let directory: string | undefined, cancelIssued = false, cancelResult: boolean | undefined
  try {
    directory = await mkdtemp(join(workRoot, 'otc-ai-export-real-gpu-'))
    const ffmpeg = ffmpegPath()
    const input = join(directory, 'input.mp4')
    const output = join(directory, 'output.mp4')
    createFixture(ffmpeg, input, gpuWidth, gpuHeight, gpuFps, gpuFrames, gpuDuration)
    const sourceBefore = await sourceSnapshot(input)
    const request: ExportRequest = {
      canvas: { width: gpuWidth, height: gpuHeight, fps: gpuFps, fit: 'contain' },
      sources: [{ id: 'source', metadata: {
        path: input, name: 'input.mp4', size: sourceBefore.length, modifiedAt: 1,
        width: gpuWidth, height: gpuHeight, fps: gpuFps, duration: gpuDuration,
        videoCodec: 'h264', hasAudio: true
      } }],
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: gpuDuration }],
      overlays: [], outputPath: output, aiEnhance: { mode },
      focusZooms: portrait ? [] : [{
        id: 'closeup', start: rangeStart, duration: 2 / gpuFps, zoom: 2, focusX: 0.5, focusY: 0.5
      }]
    }
    const plan = aiEnhancementPlan(request.canvas, mode, request.focusZooms)
    const graph = buildFilterGraph(request, [])
    if (!portrait) {
      expect(plan.spatialRanges).toEqual([[rangeStart, 3 / gpuFps]])
      expect(graph.graph).toContain('zoompan=')
    }
    expect(pack.models).toBe(join(process.env.otc_AI_TEST_MODELS_DIR ?? '', mode))
    electronMock.send = (channel, payload) => {
      if (channel !== 'job:progress' || !payload || typeof payload !== 'object') return
      const progress = payload as Partial<JobProgress>
      if (progress.id !== jobId || progress.phase !== 'enhancing') return
      if (progress.hardwareLabel) hardware.add(progress.hardwareLabel)
      if (cancelOnProgress && !cancelIssued && progress.hardwareLabel === 'dGPU' &&
          typeof progress.progress === 'number' && progress.progress > rangeStart) {
        cancelIssued = true
        cancelResult = cancelFaceExport(jobId)
      }
    }
    const running = encodeWithAi(request, ['-hide_banner', '-y', '-i', input], graph,
      directory, output, gpuDuration, jobId, { plan, pack })
    if (!cancelOnProgress) {
      await running
      expect(hardware).toEqual(new Set(['dGPU']))
      await expectExportOutput(ffmpeg, input, output, sourceBefore, outputWidth, outputHeight, 60,
        Math.ceil(gpuDuration * 60), gpuDuration)
      return
    }
    const failure = await running.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('Job cancelled')
    expect(cancelIssued).toBe(true)
    expect(cancelResult).toBe(true)
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(directory, 'ai-video.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(hasActiveFaceExports()).toBe(false)
    expect(await readFile(input)).toEqual(sourceBefore)
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true })
  }
}

describe.skipIf(process.env.otc_AI_GPU_TEST !== '1')('real GPU spatial AI export', () => {
  it('restores only the selected native 4K close-up range', async () => {
    await runGpuSpatialExport(false)
  }, 600_000)
})

describe.skipIf(process.env.otc_AI_GPU_CANCEL_TEST !== '1')('real GPU AI export cancellation', () => {
  it('cancels cooperatively after dGPU enhancement begins', async () => {
    await runGpuSpatialExport(true)
  }, 600_000)
})

describe.skipIf(process.env.otc_AI_GPU_PORTRAIT_TEST !== '1')('real GPU portrait AI export', () => {
  it('exports a portrait Short with Flash restoration, RIFE, and audio', async () => {
    await runGpuSpatialExport(false, true)
  }, 600_000)
})
