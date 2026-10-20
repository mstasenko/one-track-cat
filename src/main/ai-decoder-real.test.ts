import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }))
import { buildFilterGraph, prepareTimelineInputs } from './exporter'
import { decoderCommand, rawVideoEncoderCommand } from './face-export'
import { softwareEncoder } from './export-encoder'
import { ffprobePath } from './binaries'
import { privilegedVideoEncoderCommand } from './privileged-export'

it.each([30, 60000 / 1001, 58.436707235803205])('preserves the exact AI frame count after close-ups at %s fps', (fps) => {
  vi.stubEnv('otc_CPU_ONLY', '1')
  const directory = mkdtempSync(join(tmpdir(), 'otc-ai-decoder-'))
  try {
    const duration = 13.747083612431425
    const request: ExportRequest = {
      canvas: { width: 32, height: 18, fps, fit: 'contain' },
      sources: [{ id: 'source', metadata: {
        path: '/unused/synthetic.mp4', name: 'synthetic.mp4', size: 1, modifiedAt: 1,
        duration: 20, width: 32, height: 18, fps, videoCodec: 'h264', hasAudio: true
      } }],
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 2, sourceEnd: 2 + duration }],
      overlays: [], outputPath: join(directory, 'unused.mp4'),
      focusZooms: [{ id: 'zoom', start: 1, duration: 10, zoom: 3, focusX: 0.5, focusY: 0.5 }]
    }
    const filter = buildFilterGraph(prepareTimelineInputs(request), [])
    const frames = Math.ceil(duration * fps)
    const command = decoderCommand([
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      `testsrc2=size=32x18:rate=${fps}:duration=14[out0];sine=sample_rate=48000:duration=14[out1]`
    ], {
      ...filter,
      graph: `${filter.graph};[${filter.videoLabel}]tpad=stop_mode=clone:stop=${frames}[aiinput]`,
      videoLabel: 'aiinput'
    }, duration, join(directory, 'audio.m4a'), frames)
    // Cover development, CI fallback and (when built) packaged FFmpeg clocks.
    const executables = [command.executable, join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
      join(process.cwd(), 'dist', 'ffmpeg-vaapi', 'ffmpeg')]
    for (const executable of new Set(executables.filter(existsSync))) {
      const result = spawnSync(executable, command.args, { maxBuffer: 4 * 1024 * 1024 })
      expect(result.status, result.stderr.toString()).toBe(0)
      expect(result.stdout.length / (32 * 18 * 3)).toBe(frames)
      expect(result.stderr.toString()).not.toContain('frame duplication too large')
    }
  } finally {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('retains the exact bounded AI output instead of rounding its fractional duration', () => {
  vi.stubEnv('otc_CPU_ONLY', '1')
  const directory = mkdtempSync(join(tmpdir(), 'otc-ai-encoder-'))
  try {
    const duration = 4 / 58.436707235803205
    const output = join(directory, 'output.mp4')
    const command = rawVideoEncoderCommand(softwareEncoder(), 32, 18, 60, duration, output, 5)
    const encoded = spawnSync(command.executable, command.args, { input: Buffer.alloc(5 * 32 * 18 * 3) })
    expect(encoded.status, encoded.stderr.toString()).toBe(0)
    const probe = spawnSync(ffprobePath(), [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', output
    ], { encoding: 'utf8' })
    expect(probe.status, probe.stderr).toBe(0)
    expect(Number(probe.stdout.trim())).toBe(5)
    expect(rawVideoEncoderCommand(softwareEncoder(), 32, 18, 60, duration, output).args).toContain('-t')
    const privileged = privilegedVideoEncoderCommand({ width: 32, height: 18, fps: 60 },
      duration, '/dev/dri/renderD128', command.executable, 'rgb24', 5)
    expect(privileged.args.filter((arg, index) => arg === '-frames:v' && privileged.args[index + 1] === '5')).toHaveLength(3)
  } finally {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  }
})
