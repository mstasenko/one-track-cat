import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
import { FaceAuthorizationError, type FaceCommand } from './face-process'
import type { ExportEncoder } from './export-encoder'

const mocks = vi.hoisted(() => ({
  ffmpegPath: vi.fn(() => '/bundled/ffmpeg'),
  requireFacePack: vi.fn(),
  exportEncoders: vi.fn(),
  softwareEncoder: vi.fn(),
  hardwareLabelForRenderNode: vi.fn(),
  restrictedIntelRenderNode: vi.fn(),
  buildFaceWorkerCommand: vi.fn(),
  runFacePipeline: vi.fn(),
  vaapiFfmpegPath: vi.fn(),
  jobsRun: vi.fn(),
  prepareCache: vi.fn()
}))

vi.mock('./binaries', () => ({ ffmpegPath: mocks.ffmpegPath }))
vi.mock('./face-pack', () => ({ requireFacePack: mocks.requireFacePack }))
vi.mock('./export-encoder', () => ({
  exportEncoders: mocks.exportEncoders,
  softwareEncoder: mocks.softwareEncoder,
  hardwareLabelForRenderNode: mocks.hardwareLabelForRenderNode
}))
vi.mock('./face-worker', () => ({
  buildFaceWorkerCommand: mocks.buildFaceWorkerCommand,
  nativeFaceWorkerCommand: (pack: { executable: string; model: string }, _canvas: unknown, effects: string, device: string) => ({
    executable: pack.executable, args: ['--model', pack.model, '--effects', effects, '--device', device]
  }),
  restrictedIntelRenderNode: mocks.restrictedIntelRenderNode
}))
vi.mock('./privileged-export', () => ({
  nutVideoRemuxCommand: (output: string) => ({ executable: '/bundled/ffmpeg', args: ['-f', 'nut', '-i', 'pipe:0', output] }),
  privilegedVideoEncoderCommand: (_canvas: unknown, _duration: number, renderNode: string, executable: string) => ({
    executable: '/usr/bin/pkexec', args: ['--disable-internal-agent', executable, '-vaapi_device', renderNode, '-f', 'nut', 'pipe:1'], elevated: true
  }),
  privilegedFacePipelineCommand: (detector: FaceCommand, encoder: FaceCommand) => {
    const unwrap = (command: FaceCommand): FaceCommand => command.executable === '/usr/bin/pkexec' && command.args[0] === '--disable-internal-agent'
      ? { executable: command.args[1] ?? '', args: command.args.slice(2) }
      : command
    const innerDetector = unwrap(detector)
    const innerEncoder = unwrap(encoder)
    const detectorArgs = [innerDetector.executable, ...innerDetector.args]
    return {
      executable: '/usr/bin/pkexec',
      args: [
        '--disable-internal-agent', '/bin/bash', '-o', 'pipefail', '-c',
        'count=$1; shift; detector=("${@:1:count}"); shift "$count"; "${detector[@]}" | "$@"', '--',
        String(detectorArgs.length), ...detectorArgs, innerEncoder.executable, ...innerEncoder.args
      ],
      elevated: true
    }
  },
  vaapiFfmpegPath: mocks.vaapiFfmpegPath
}))
vi.mock('./face-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./face-process')>()
  return { ...actual, runFacePipeline: mocks.runFacePipeline }
})
vi.mock('./jobs', () => ({ jobs: { run: mocks.jobsRun } }))
vi.mock('./face-detection-cache', () => ({ prepareFaceDetectionCache: mocks.prepareCache }))

import { encodeWithFaces } from './face-export'
import { exportEncoders } from './export-encoder'

const request: ExportRequest = {
  canvas: { width: 64, height: 64, fps: 10, fit: 'contain' },
  sources: [], segments: [], overlays: [], outputPath: '/tmp/output.mp4', faceBlurs: []
}
const filter = { graph: 'graph', videoLabel: 'video', audioLabel: 'audio' }
const hardwareEncoder: ExportEncoder = {
  executable: '/hardware-ffmpeg', input: ['-vaapi_device', '/dev/dri/renderD128'], filterSuffix: 'format=nv12,hwupload[hardwarev]',
  rawVideoFilter: 'format=nv12,hwupload', videoLabel: () => 'hardwarev', output: ['-c:v', 'h264_vaapi', '-qp', '18'], hardwareLabel: 'dGPU'
}
const cpuEncoder: ExportEncoder = {
  executable: '/bundled/ffmpeg', input: [], filterSuffix: '', videoLabel: (label) => label,
  output: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16'], hardwareLabel: 'CPU'
}

let directory: string | undefined

beforeEach(() => {
  directory = undefined
  vi.clearAllMocks()
  mocks.requireFacePack.mockResolvedValue({ executable: '/face-worker', model: '/model.xml' })
  mocks.softwareEncoder.mockReturnValue(cpuEncoder)
  mocks.exportEncoders.mockResolvedValue([hardwareEncoder, cpuEncoder])
  mocks.restrictedIntelRenderNode.mockResolvedValue(undefined)
  mocks.hardwareLabelForRenderNode.mockResolvedValue('dGPU')
  mocks.vaapiFfmpegPath.mockResolvedValue('/hardware-ffmpeg')
  mocks.buildFaceWorkerCommand.mockResolvedValue({ executable: '/face-worker', args: ['--device', 'AUTO'] })
  mocks.runFacePipeline.mockResolvedValue(undefined)
  mocks.jobsRun.mockResolvedValue(undefined)
  mocks.prepareCache.mockResolvedValue({ workerArgs: [], commit: vi.fn(), cleanup: vi.fn() })
})

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function runExport(): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), 'otc-face-hardware-'))
  await encodeWithFaces({ ...request, outputPath: join(directory, 'output.mp4') }, ['-hide_banner'], filter, directory, join(directory, 'output.mp4'), 1, 'face-hardware')
}

describe('face export encoder selection', () => {
  it('reuses ordinary hardware quality settings for unprivileged raw-video encoding', async () => {
    await runExport()
    expect(exportEncoders).toHaveBeenCalledOnce()
    const call = mocks.runFacePipeline.mock.calls[0] as [FaceCommand[], string, number, Record<string, unknown>]
    expect(call[0]).toHaveLength(3)
    expect(call[0][2]).toMatchObject({ executable: '/hardware-ffmpeg', gpuWorker: true })
    expect(call[0][2]?.args).toEqual(expect.arrayContaining([
      '-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '18'
    ]))
    expect(call[3]).toMatchObject({ phase: 'encoding', encodingHardwareLabel: 'dGPU' })
  })

  it('falls back to software encoding with an explicit note after a GPU codec failure', async () => {
    mocks.runFacePipeline.mockRejectedValueOnce(new Error('codec initialization failed')).mockResolvedValueOnce(undefined)
    await runExport()
    expect(mocks.runFacePipeline).toHaveBeenCalledTimes(2)
    const retry = mocks.runFacePipeline.mock.calls[1] as [FaceCommand[], string, number, Record<string, unknown>]
    expect(retry[0]).toHaveLength(3)
    expect(retry[0][2]).toMatchObject({ executable: '/bundled/ffmpeg' })
    expect(retry[0][2]).not.toHaveProperty('gpuWorker')
    expect(retry[3]).toMatchObject({
      message: 'GPU video encoding unavailable; using CPU…', encodingHardwareLabel: 'CPU'
    })
    expect(mocks.jobsRun.mock.calls.at(-1)?.[5]).toBe('GPU video encoding unavailable; using CPU…')
  })

  it('bypasses detector authorization when the cache covers every requested frame', async () => {
    mocks.prepareCache.mockResolvedValue({
      workerArgs: [], hasCompleteDetections: true, commit: vi.fn(), cleanup: vi.fn()
    })
    mocks.buildFaceWorkerCommand.mockImplementation(() => {
      throw new Error('cached detections must not request detector authorization')
    })

    await runExport()

    expect(mocks.buildFaceWorkerCommand).not.toHaveBeenCalled()
    const call = mocks.runFacePipeline.mock.calls[0] as [FaceCommand[], string, number, Record<string, unknown>]
    expect(call[0][1]?.args).toContain('CPU')
    expect(call[3]).toMatchObject({ phase: 'encoding', encodingHardwareLabel: 'dGPU' })
  })

  it('keeps the four-stage pipeline when restricted encoding uses cached CPU detection', async () => {
    mocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD128')
    mocks.prepareCache.mockResolvedValue({
      workerArgs: [], hasCompleteDetections: true, commit: vi.fn(), cleanup: vi.fn()
    })

    await runExport()

    const call = mocks.runFacePipeline.mock.calls[0] as [FaceCommand[], string, number, Record<string, unknown>]
    expect(call[0]).toHaveLength(4)
    expect(call[0][1]?.args).toContain('CPU')
    expect(call[0][1]).not.toHaveProperty('elevated')
    expect(call[0][2]).toMatchObject({ executable: '/usr/bin/pkexec', elevated: true })
  })

  it('keeps AUTO face detection when software encoding is selected', async () => {
    mocks.exportEncoders.mockResolvedValue([cpuEncoder])

    await runExport()

    expect(mocks.buildFaceWorkerCommand).toHaveBeenCalledOnce()
    const call = mocks.runFacePipeline.mock.calls[0] as [FaceCommand[], string, number, Record<string, unknown>]
    expect(call[0][1]?.args).toContain('AUTO')
    expect(call[3]).toMatchObject({ phase: 'encoding', encodingHardwareLabel: 'CPU' })
    expect(call[3]).not.toHaveProperty('hardwareLabel')
  })

  it('retries restricted authorization denial with CPU detector and reports an authorization note', async () => {
    mocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD128')
    mocks.runFacePipeline
      .mockRejectedValueOnce(new FaceAuthorizationError('authorization denied'))
      .mockResolvedValueOnce(undefined)
    await runExport()

    expect(mocks.runFacePipeline).toHaveBeenCalledTimes(2)
    const retry = mocks.runFacePipeline.mock.calls[1] as [FaceCommand[], string, number, Record<string, unknown>]
    expect(retry[0]).toHaveLength(3)
    expect(retry[0][1]?.args).toContain('CPU')
    expect(retry[3]).toMatchObject({
      message: 'GPU authorization unavailable or declined; using CPU…',
      hardwareLabel: 'CPU', encodingHardwareLabel: 'CPU'
    })
    expect(mocks.jobsRun.mock.calls.at(-1)?.[5]).toBe('GPU authorization unavailable or declined; using CPU…')
  })

  it('retries restricted codec failure with CPU encoding and detection', async () => {
    mocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD128')
    mocks.runFacePipeline
      .mockRejectedValueOnce(new Error('codec initialization failed'))
      .mockResolvedValueOnce(undefined)
    await runExport()

    expect(mocks.runFacePipeline).toHaveBeenCalledTimes(2)
    const retry = mocks.runFacePipeline.mock.calls[1] as [FaceCommand[], string, number, Record<string, unknown>]
    expect(retry[0]).toHaveLength(3)
    expect(retry[0][1]?.args).toContain('CPU')
    expect(retry[3]).toMatchObject({
      message: 'GPU video encoding unavailable; using CPU…', encodingHardwareLabel: 'CPU'
    })
    expect(retry[3]).toHaveProperty('hardwareLabel', 'CPU')
    expect(mocks.jobsRun.mock.calls.at(-1)?.[5]).toBe('GPU video encoding unavailable; using CPU…')
  })

  it('allows one detector authorization when VAAPI preflight fails before launch', async () => {
    mocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD128')
    mocks.vaapiFfmpegPath.mockRejectedValueOnce(new Error('VAAPI probe failed'))
    mocks.buildFaceWorkerCommand.mockResolvedValueOnce({
      executable: '/usr/bin/pkexec',
      args: ['--disable-internal-agent', '/face-worker', '--device', 'AUTO'],
      elevated: true
    })

    await runExport()

    expect(mocks.runFacePipeline).toHaveBeenCalledOnce()
    const call = mocks.runFacePipeline.mock.calls[0] as [FaceCommand[], string, number, Record<string, unknown>]
    expect(call[0]).toHaveLength(3)
    expect(call[0][1]).toMatchObject({ executable: '/usr/bin/pkexec', elevated: true })
    expect(call[0][1]?.args).toContain('AUTO')
    expect(call[0][2]).toMatchObject({ executable: '/bundled/ffmpeg' })
  })

  it('does not retry a cancelled restricted encoding attempt', async () => {
    mocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD128')
    mocks.runFacePipeline.mockRejectedValueOnce(new Error('Job cancelled'))

    await expect(runExport()).rejects.toThrow('Job cancelled')

    expect(mocks.runFacePipeline).toHaveBeenCalledOnce()
    expect(mocks.jobsRun).not.toHaveBeenCalled()
  })

  it('commits and cleans each cache session exactly once across an encoder retry', async () => {
    const first = { workerArgs: [], commit: vi.fn(() => Promise.resolve()), cleanup: vi.fn(() => Promise.resolve()) }
    const second = { workerArgs: [], commit: vi.fn(() => Promise.resolve()), cleanup: vi.fn(() => Promise.resolve()) }
    mocks.prepareCache.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    mocks.runFacePipeline.mockRejectedValueOnce(new Error('codec initialization failed')).mockResolvedValueOnce(undefined)

    await runExport()

    expect(mocks.prepareCache).toHaveBeenCalledTimes(2)
    expect(first.commit).toHaveBeenCalledOnce()
    expect(first.cleanup).toHaveBeenCalledOnce()
    expect(second.commit).toHaveBeenCalledOnce()
    expect(second.cleanup).toHaveBeenCalledOnce()
  })

  it.each([
    ['fails', new Error('CPU encoder failed')],
    ['is cancelled', new Error('Job cancelled')]
  ])('cleans the replacement cache session when the CPU retry %s', async (_caseName, retryError) => {
    const first = { workerArgs: [], commit: vi.fn(() => Promise.resolve()), cleanup: vi.fn(() => Promise.resolve()) }
    const second = { workerArgs: [], commit: vi.fn(() => Promise.resolve()), cleanup: vi.fn(() => Promise.resolve()) }
    mocks.prepareCache.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    mocks.runFacePipeline.mockRejectedValueOnce(new Error('codec initialization failed')).mockRejectedValueOnce(retryError)

    await expect(runExport()).rejects.toThrow(retryError.message)

    expect(mocks.prepareCache).toHaveBeenCalledTimes(2)
    expect(first.commit).toHaveBeenCalledOnce()
    expect(first.cleanup).toHaveBeenCalledOnce()
    expect(second.commit).not.toHaveBeenCalled()
    expect(second.cleanup).toHaveBeenCalledOnce()
  })

  it('streams restricted Intel encoding through root NUT stdout into an unprivileged remuxer', async () => {
    mocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD128')
    mocks.buildFaceWorkerCommand.mockResolvedValueOnce({
      executable: '/usr/bin/pkexec',
      args: ['--disable-internal-agent', '/face-worker', '--device', 'AUTO'],
      elevated: true
    })
    await runExport()
    expect(exportEncoders).not.toHaveBeenCalled()
    const call = mocks.runFacePipeline.mock.calls[0] as [FaceCommand[], string, number, Record<string, unknown>]
    expect(call[0].filter((command) => command.executable === '/usr/bin/pkexec')).toHaveLength(1)
    expect(call[0]).toHaveLength(3)
    expect(call[0][1]).toMatchObject({ executable: '/usr/bin/pkexec', elevated: true })
    expect(call[0][1]?.args).toEqual(expect.arrayContaining([
      '/bin/bash', '-o', 'pipefail', '-c', 'pipe:1', '/face-worker', '-vaapi_device', '/dev/dri/renderD128'
    ]))
    expect(call[0][1]?.args).not.toContain('/usr/bin/pkexec')
    expect(call[0][1]?.args).not.toContain(join(directory ?? '', 'masked.mp4'))
    expect(call[0][2]).not.toHaveProperty('elevated')
    expect(call[0][2]?.args).toContain(join(directory ?? '', 'masked.mp4'))
    expect(call[3]).toMatchObject({ phase: 'encoding', encodingHardwareLabel: 'dGPU' })
  })
})
