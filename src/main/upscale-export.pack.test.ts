import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
import type { UpscalePlan } from '../upscale'

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
import { encodeWithUpscale } from './upscale-export'
import { requireUpscalePack, type UpscalePack } from './upscale-pack'

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

async function testPack(): Promise<UpscalePack> {
  const directory = process.env.otc_UPSCALE_TEST_PACK_DIR
  return requireUpscalePack(directory ? { spatial: false, directory } : { spatial: false })
}

afterEach(() => {
  electronMock.send = undefined
  vi.unstubAllEnvs()
})

describe('Upscale pack: CPU export', () => {
  it('exports a tiny RIFE video with audio and clean metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-upscale-export-real-'))
    try {
      vi.stubEnv('otc_CPU_ONLY', '1')
      const ffmpeg = ffmpegPath()
      const input = join(directory, 'input.mp4')
      const output = join(directory, 'output.mp4')

      createFixture(ffmpeg, input, width, height, sourceFps, sourceFrames, duration)

      const sourceBefore = await sourceSnapshot(input)

      const request: ExportRequest = {
        canvas: { width, height, fps: sourceFps, fit: 'contain' },
        sources: [], segments: [], overlays: [], outputPath: output, upscale: {}
      }
      // Keep this integration check RIFE-only: Flash restoration requires
      // mode-specific prepared models and a discrete GPU, covered natively.
      const plan: UpscalePlan = {
        canvas: { ...request.canvas, fps: outputFps },
        spatial: false, interpolate: true, mode: 'turbo'
      }
      const pack = await testPack()
      await encodeWithUpscale(request, ['-hide_banner', '-y', '-i', input], {
        graph: '[0:v:0]format=rgb24[vout];[0:a:0]anull[aout]', videoLabel: 'vout', audioLabel: 'aout'
      }, directory, output, duration, 'real-upscale-export', { plan, pack })
      await expectExportOutput(ffmpeg, input, output, sourceBefore, width, height, outputFps, expectedOutputFrames, duration)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
