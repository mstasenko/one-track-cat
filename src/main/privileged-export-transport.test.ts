import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
import type { FaceCommand, FacePipelineOptions } from './face-process'

const probe = vi.hoisted(() => ({
  execFile: vi.fn<(executable: string, args: string[], options: object, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => void>()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, default: { ...actual, execFile: probe.execFile }, execFile: probe.execFile }
})
vi.mock('./binaries', () => ({
  ffmpegPath: () => process.cwd() + '/node_modules/ffmpeg-static/ffmpeg',
  hardwareFfmpegCandidates: () => [process.cwd() + '/node_modules/ffmpeg-static/ffmpeg']
}))
vi.mock('./face-process', async () => {
  const actual = await vi.importActual<typeof import('./face-process')>('./face-process')
  const executable = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
  const runFacePipeline = vi.fn(async (
    commands: [FaceCommand, FaceCommand, FaceCommand],
    id: string,
    duration: number,
    options?: FacePipelineOptions
  ): Promise<void> => {
    const [decoder, , muxer] = commands
    const replacement: FaceCommand = {
      executable,
      args: [
        '-hide_banner', '-loglevel', 'error', '-filter_threads', '4', '-threads', '4',
        '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '64x64', '-framerate', '10',
        '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '1', '-f', 'nut', 'pipe:1'
      ]
    }
    return actual.runFacePipeline([decoder, replacement, muxer], id, duration, options)
  })
  return { ...actual, runFacePipeline }
})

import { encodeWithPrivilegedGpu } from './privileged-export'

let directory: string | undefined
beforeEach(() => {
  probe.execFile.mockImplementation((_executable, _args, _options, callback) => {
    callback(null, { stdout: ' V..... h264_vaapi\n', stderr: '' })
  })
})
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('privileged ordinary-video transport', () => {
  it('round-trips RGB frames through NUT and remuxes AAC without GPU access', async () => {
    directory = await mkdtemp(join(tmpdir(), 'otc-privileged-export-'))
    const output = join(directory, 'out.mp4')
    const request: ExportRequest = {
      canvas: { width: 64, height: 64, fps: 10, fit: 'contain' },
      sources: [], segments: [], overlays: [], outputPath: output
    }

    await encodeWithPrivilegedGpu(
      request,
      [
        '-hide_banner', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=10:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1'
      ],
      { graph: '[0:v]format=yuv420p[video];[1:a]anull[audio]', videoLabel: 'video', audioLabel: 'audio' },
      directory, output, 1, 'transport', '/dev/dri/renderD128'
    )

    const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
    const frames = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    expect(frames.length).toBe(64 * 64 * 3 * 10)
    expect(frames[0]).toBeGreaterThan(240)
    const audio = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-map', '0:a:0', '-f', 's16le', 'pipe:1'])
    expect(audio.length).toBeGreaterThan(80_000)
  }, 15_000)
})
