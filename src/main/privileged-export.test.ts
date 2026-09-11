import { spawn } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
import type { FaceCommand } from './face-process'

const mocks = vi.hoisted(() => ({
  ffmpegPath: vi.fn(() => '/bundled/ffmpeg'),
  hardwareFfmpegCandidates: vi.fn(() => ['/bundled/ffmpeg']),
  execFile: vi.fn<(executable: string, args: string[], options: object, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => void>(),
  runFacePipeline: vi.fn(),
  jobsRun: vi.fn()
}))
const fsMocks = vi.hoisted(() => ({ readFile: vi.fn() }))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, default: { ...actual, execFile: mocks.execFile }, execFile: mocks.execFile }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, default: { ...actual, readFile: fsMocks.readFile }, readFile: fsMocks.readFile }
})
vi.mock('./binaries', () => ({ ffmpegPath: mocks.ffmpegPath, hardwareFfmpegCandidates: mocks.hardwareFfmpegCandidates }))
vi.mock('./face-process', () => ({ runFacePipeline: mocks.runFacePipeline }))
vi.mock('./jobs', () => ({ jobs: { run: mocks.jobsRun } }))

import { encodeWithPrivilegedGpu, privilegedFacePipelineCommand, privilegedVideoEncoderCommand, vaapiFfmpegPath } from './privileged-export'

const request: ExportRequest = {
  canvas: { width: 1280, height: 720, fps: 60, fit: 'contain' },
  sources: [], segments: [], overlays: [], outputPath: '/home/user/final.mp4'
}
const filter = { graph: 'graph', videoLabel: 'video', audioLabel: 'audio' }
interface PipelineCommand { executable: string; args: string[]; elevated?: boolean }
type PipelineCall = [PipelineCommand[], string, number, { label: string; hardwareLabel?: string }]

function fakeVaapiExecutable(directory: string): { executable: string; log: string } {
  const log = join(directory, 'ffmpeg-calls.log')
  const executable = join(directory, 'fake ffmpeg;trusted')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const codec = args[args.indexOf('-c:v') + 1]
const probe = args.includes('lavfi')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ probe, codec, args }) + '\\n')
if (probe && process.env.otc_FAKE_VAAPI_FAILURES.split(',').includes(codec)) process.exit(41)
if (probe) process.exit(0)
process.stdin.pipe(process.stdout)
`)
  chmodSync(executable, 0o755)
  return { executable, log }
}

describe('privileged ordinary-video export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hardwareFfmpegCandidates.mockReturnValue(['/bundled/ffmpeg'])
    fsMocks.readFile.mockReset()
    fsMocks.readFile.mockRejectedValue(new Error('sysfs unavailable'))
    mocks.execFile.mockImplementation((_executable, _args, _options, callback) => {
      callback(null, { stdout: ' V..... h264_vaapi\n', stderr: '' })
    })
    mocks.runFacePipeline.mockResolvedValue(undefined)
    mocks.jobsRun.mockResolvedValue(undefined)
  })

  it('reports a dGPU label only when the render node sysfs identity proves it', async () => {
    fsMocks.readFile.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/vendor') ? '0x8086\n' : 'PCI_SLOT_NAME=0000:03:00.0\n'))

    await encodeWithPrivilegedGpu(
      request, ['-hide_banner', '-y', '-i', '/home/user/input.mp4'], filter,
      '/home/user/otc-export-label', '/home/user/final.mp4', 1, 'label-job', '/dev/dri/renderD128'
    )

    const call = mocks.runFacePipeline.mock.calls[0]
    if (!call) throw new Error('Pipeline was not invoked')
    expect(call[3]).toMatchObject({ hardwareLabel: 'dGPU', label: 'Encoding video using dGPU' })
  })

  it('keeps only the VAAPI encoder elevated and muxes user-owned files normally', async () => {
    await encodeWithPrivilegedGpu(
      request, ['-hide_banner', '-n', '-i', '/home/user/input.mp4'], filter,
      '/home/user/otc-export-123', '/home/user/final.mp4', 3.25, 'gpu-job', '/dev/dri/renderD128'
    )

    expect(mocks.runFacePipeline).toHaveBeenCalledOnce()
    const call = mocks.runFacePipeline.mock.calls[0]
    if (!call) throw new Error('Pipeline was not invoked')
    const [commands, jobId, duration, options] = call as unknown as PipelineCall
    expect(jobId).toBe('gpu-job')
    expect(duration).toBe(3.25)
    expect(options).toEqual({
      label: 'Encoding video',
      phase: 'encoding',
      authorizationMessage: 'GPU video encoding authorization was denied, cancelled, or unavailable'
    })
    expect(commands).toHaveLength(3)
    const [decoder, encoder, muxer] = commands
    if (!decoder || !encoder || !muxer) throw new Error('Pipeline command tuple is incomplete')
    expect(decoder).toEqual({
      executable: '/bundled/ffmpeg',
      args: [
        '-hide_banner', '-n', '-i', '/home/user/input.mp4', '-y', '-filter_complex_threads', '4', '-filter_complex', 'graph',
        '-map', '[video]', '-t', '3.25', '-an', '-pix_fmt', 'rgb24', '-threads', '2', '-f', 'rawvideo', 'pipe:1',
        '-map', '[audio]', '-t', '3.25', '-vn', '-c:a', 'aac', '-b:a', '256k', '/home/user/otc-export-123/gpu-audio.m4a'
      ]
    })
    expect(decoder.elevated).toBeUndefined()
    expect(encoder).toMatchObject({ executable: '/usr/bin/pkexec', elevated: true })
    expect(encoder.args.slice(0, 7)).toEqual([
      '--disable-internal-agent', '/bin/bash', '-o', 'pipefail', '-c', expect.any(String), '--'
    ])
    expect(encoder.args).toEqual(expect.arrayContaining([
      '/bundled/ffmpeg', '/dev/dri/renderD128', 'av1_vaapi', 'hevc_vaapi', 'h264_vaapi',
      '-rc_mode', 'CQP', '-global_quality', '110', '-qp', '18'
    ]))
    expect(encoder.args).not.toContain('/home/user/otc-export-123/gpu-video.mp4')
    expect(muxer).toEqual({
      executable: '/bundled/ffmpeg',
      args: [
        '-hide_banner', '-y', '-f', 'nut', '-i', 'pipe:0', '-c:v', 'copy', '-an', '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats', '/home/user/otc-export-123/gpu-video.mp4'
      ]
    })
    expect(muxer.elevated).toBeUndefined()
    expect(mocks.jobsRun).toHaveBeenCalledWith(
      '/bundled/ffmpeg', [
        '-hide_banner', '-y', '-i', '/home/user/otc-export-123/gpu-video.mp4',
        '-i', '/home/user/otc-export-123/gpu-audio.m4a', '-map', '0:v:0', '-map', '1:a:0',
        '-c', 'copy', '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
        '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '/home/user/final.mp4'
      ], 'export', 3.25, 'gpu-job', '', { phase: 'finalizing', announce: false }
    )
  })

  it('propagates pipeline failures without attempting a mux', async () => {
    const failure = new Error('GPU pipeline failed')
    mocks.runFacePipeline.mockRejectedValue(failure)

    await expect(encodeWithPrivilegedGpu(
      request, ['-hide_banner', '-y', '-i', '/home/user/input.mp4'], filter,
      '/home/user/otc-export-456', '/home/user/final.mp4', 1, 'failed-job', '/dev/dri/renderD128'
    )).rejects.toBe(failure)
    expect(mocks.jobsRun).not.toHaveBeenCalled()
  })

  it('tries the next trusted FFmpeg candidate when the bundled binary lacks VAAPI', async () => {
    mocks.hardwareFfmpegCandidates.mockReturnValue(['/bundled/ffmpeg', '/system/ffmpeg'])
    mocks.execFile.mockImplementation((executable, _args, _options, callback) => {
      callback(null, { stdout: executable === '/system/ffmpeg' ? ' V..... h264_vaapi\n' : ' V..... libx264\n', stderr: '' })
    })

    await encodeWithPrivilegedGpu(
      request, ['-hide_banner', '-y', '-i', '/home/user/input.mp4'], filter,
      '/home/user/otc-export-789', '/home/user/final.mp4', 1, 'fallback-job', '/dev/dri/renderD128'
    )
    const call = mocks.runFacePipeline.mock.calls[0]
    if (!call) throw new Error('Pipeline was not invoked')
    const [commands] = call as unknown as PipelineCall
    expect(commands[0]?.executable).toBe('/bundled/ffmpeg')
    expect(commands[1]?.args).toContain('/system/ffmpeg')
    expect(commands[2]?.executable).toBe('/bundled/ffmpeg')
    expect(mocks.jobsRun.mock.calls[0]?.[0]).toBe('/bundled/ffmpeg')
  })

  it('accepts an AV1-only advertised VAAPI executable', async () => {
    mocks.hardwareFfmpegCandidates.mockReturnValue(['/av1/ffmpeg'])
    mocks.execFile.mockImplementation((_executable, _args, _options, callback) => {
      callback(null, { stdout: ' V..... av1_vaapi\n', stderr: '' })
    })

    await expect(vaapiFfmpegPath()).resolves.toBe('/av1/ffmpeg')
  })

  it('fails before authorization when no candidate advertises a supported VAAPI codec', async () => {
    mocks.execFile.mockImplementation((_executable, _args, _options, callback) => {
      callback(new Error('encoder unavailable'), { stdout: '', stderr: '' })
    })

    await expect(encodeWithPrivilegedGpu(
      request, ['-hide_banner', '-y', '-i', '/home/user/input.mp4'], filter,
      '/home/user/otc-export-999', '/home/user/final.mp4', 1, 'missing-codec-job', '/dev/dri/renderD128'
    )).rejects.toThrow('No FFmpeg executable with VAAPI video encoding support is available')
    expect(mocks.runFacePipeline).not.toHaveBeenCalled()
    expect(mocks.jobsRun).not.toHaveBeenCalled()
  })

  it('probes AV1, HEVC, and H.264 in order before streaming', () => {
    const command = privilegedVideoEncoderCommand(
      { width: 1280, height: 720, fps: 60 }, 3.25, '/dev/dri/renderD128', '/tmp/ffmpeg with space;trusted'
    )
    expect(command).toMatchObject({ executable: '/usr/bin/pkexec', elevated: true })
    expect(command.args.slice(0, 7)).toEqual([
      '--disable-internal-agent', '/bin/bash', '-o', 'pipefail', '-c',
      expect.any(String), '--'
    ])
    expect(command.args).toEqual(expect.arrayContaining([
      'av1_vaapi', 'hevc_vaapi', 'h264_vaapi', '-rc_mode', 'CQP', '-global_quality', '110'
    ]))
    expect(command.args).not.toContain('/tmp/ffmpeg with space;trusted -hide_banner')
  })

  it('runs the combined privileged shell pipeline with exact argv and bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-privileged-shell-'))
    try {
      const detectorLog = join(directory, 'detector-args.json')
      const encoderLog = join(directory, 'encoder-args.json')
      const detectorScript = [
        "const fs = require('node:fs')",
        'const [log, ...args] = process.argv.slice(1)',
        'fs.writeFileSync(log, JSON.stringify(args))',
        'process.stdin.pipe(process.stdout)'
      ].join(';')
      const encoderScript = [
        "const fs = require('node:fs')",
        'const [log, ...args] = process.argv.slice(1)',
        'const chunks = []',
        'process.stdin.on(\'data\', (chunk) => chunks.push(chunk))',
        "process.stdin.on('end', () => { fs.writeFileSync(log, JSON.stringify(args)); process.stdout.end(Buffer.concat(chunks)) })"
      ].join(';')
      const detector: FaceCommand = {
        executable: '/usr/bin/pkexec',
        args: ['--disable-internal-agent', process.execPath, '-e', detectorScript, detectorLog, 'space value', '$(not a command);*'],
        elevated: true
      }
      const encoder: FaceCommand = {
        executable: '/usr/bin/pkexec',
        args: ['--disable-internal-agent', process.execPath, '-e', encoderScript, encoderLog, 'quote"value', 'semi;value'],
        elevated: true
      }
      const command = privilegedFacePipelineCommand(detector, encoder)
      expect(command).toMatchObject({ executable: '/usr/bin/pkexec', elevated: true })
      expect(command.args.slice(0, 7)).toEqual([
        '--disable-internal-agent', '/bin/bash', '-o', 'pipefail', '-c',
        'count=$1; shift; detector=("${@:1:count}"); shift "$count"; "${detector[@]}" | "$@"', '--'
      ])
      expect(command.args).not.toContain('/usr/bin/pkexec')

      const input = Buffer.from([0, 1, 2, 3, 255, 254, 10])
      const result = await runUnprivilegedShell(command, input)
      expect(result.code).toBe(0)
      expect(result.stdout).toEqual(input)
      expect(JSON.parse(readFileSync(detectorLog, 'utf8'))).toEqual(['space value', '$(not a command);*'])
      expect(JSON.parse(readFileSync(encoderLog, 'utf8'))).toEqual(['quote"value', 'semi;value'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('propagates an inner detector failure through pipefail', async () => {
    const detector: FaceCommand = {
      executable: '/usr/bin/pkexec',
      args: ['--disable-internal-agent', process.execPath, '-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(23))"],
      elevated: true
    }
    const encoder: FaceCommand = {
      executable: '/usr/bin/pkexec',
      args: ['--disable-internal-agent', process.execPath, '-e', "process.stdin.pipe(process.stdout)"],
      elevated: true
    }
    const result = await runUnprivilegedShell(privilegedFacePipelineCommand(detector, encoder), Buffer.from('eof'))
    expect(result.code).toBe(23)
  })

  it.each([
    { failures: '', selected: 'av1_vaapi', probes: ['av1_vaapi'] },
    { failures: 'av1_vaapi', selected: 'hevc_vaapi', probes: ['av1_vaapi', 'hevc_vaapi'] },
    { failures: 'av1_vaapi,hevc_vaapi', selected: 'h264_vaapi', probes: ['av1_vaapi', 'hevc_vaapi', 'h264_vaapi'] }
  ])('probes failed codecs in order, preserves stdin, and streams $selected', async ({ failures, selected, probes }) => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-vaapi-probe-'))
    const previousFailures = process.env.otc_FAKE_VAAPI_FAILURES
    process.env.otc_FAKE_VAAPI_FAILURES = failures
    try {
      const { executable: fake, log } = fakeVaapiExecutable(directory)

      const detector: FaceCommand = {
        executable: '/usr/bin/pkexec',
        args: ['--disable-internal-agent', process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
        elevated: true
      }
      const encoder = privilegedVideoEncoderCommand(
        { width: 64, height: 64, fps: 10 }, 1, '/dev/dri/renderD128', fake
      )
      const command = privilegedFacePipelineCommand(detector, encoder)
      expect(command.executable).toBe('/usr/bin/pkexec')
      expect(command.args).not.toContain('/usr/bin/pkexec')
      const input = Buffer.from([0, 1, 2, 255, 254, 10])
      const result = await runUnprivilegedShell(command, input)
      expect(result.code).toBe(0)
      expect(result.stdout).toEqual(input)
      const calls = readFileSync(log, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as { probe: boolean; codec: string; args: string[] })
      expect(calls.map(({ probe, codec }) => ({ probe, codec }))).toEqual([
        ...probes.map((codec) => ({ probe: true, codec })),
        { probe: false, codec: selected }
      ])
      expect(calls[0]?.args).toEqual(expect.arrayContaining(['-rc_mode', 'CQP', '-global_quality', '110']))
      expect(calls.at(-1)?.args).toEqual(expect.arrayContaining(selected === 'av1_vaapi'
        ? ['-c:v', selected, '-rc_mode', 'CQP', '-global_quality', '110']
        : ['-c:v', selected, '-qp', '18']))
    } finally {
      if (previousFailures === undefined) delete process.env.otc_FAKE_VAAPI_FAILURES
      else process.env.otc_FAKE_VAAPI_FAILURES = previousFailures
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails without launching a stream when every codec probe fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-vaapi-probe-fail-'))
    const previousFailures = process.env.otc_FAKE_VAAPI_FAILURES
    process.env.otc_FAKE_VAAPI_FAILURES = 'av1_vaapi,hevc_vaapi,h264_vaapi'
    try {
      const { executable: fake, log } = fakeVaapiExecutable(directory)
      const detector: FaceCommand = {
        executable: '/usr/bin/pkexec',
        args: ['--disable-internal-agent', process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
        elevated: true
      }
      const command = privilegedFacePipelineCommand(
        detector, privilegedVideoEncoderCommand({ width: 64, height: 64, fps: 10 }, 1, '/dev/dri/renderD128', fake)
      )
      const result = await runUnprivilegedShell(command, Buffer.from('not consumed by a probe'))
      expect(result.code).not.toBe(0)
      expect(result.stdout).toEqual(Buffer.alloc(0))
      const calls = readFileSync(log, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as { probe: boolean; codec: string })
      expect(calls.map(({ probe, codec }) => ({ probe, codec }))).toEqual([
        { probe: true, codec: 'av1_vaapi' },
        { probe: true, codec: 'hevc_vaapi' },
        { probe: true, codec: 'h264_vaapi' }
      ])
    } finally {
      if (previousFailures === undefined) delete process.env.otc_FAKE_VAAPI_FAILURES
      else process.env.otc_FAKE_VAAPI_FAILURES = previousFailures
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function runUnprivilegedShell(command: FaceCommand, input: Buffer): Promise<{ code: number | null; stdout: Buffer }> {
  const child = spawn('/bin/bash', command.args.slice(2), { stdio: ['pipe', 'pipe', 'ignore'] })
  const chunks: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
  child.stdin.on('error', () => undefined)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode) => resolve(exitCode))
    child.stdin.end(input)
  })
  return { code, stdout: Buffer.concat(chunks) }
}
