import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { aiEnhancementPlan } from '../ai-enhancement'
import type { ExportRequest, ProjectCanvas } from '../types'
import { FaceAuthorizationError, type FaceCommand } from './face-process'
import type { ExportEncoder } from './export-encoder'

const mocks = vi.hoisted(() => {
  return {
    rm: vi.fn(),
    writeFile: vi.fn(),
    ffmpegPath: vi.fn(),
    requireFacePack: vi.fn(),
    exportEncoders: vi.fn(),
    softwareEncoder: vi.fn(),
    prepareFaceDetectionCache: vi.fn(),
    decoderCommand: vi.fn(),
    faceEffectRows: vi.fn(),
    rawVideoEncoderCommand: vi.fn(),
    runFacePipeline: vi.fn(),
    nativeFaceWorkerCommand: vi.fn(),
    restrictedIntelRenderNode: vi.fn(),
    jobsRun: vi.fn(),
    vaapiFfmpegPath: vi.fn()
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const replacement = { ...actual, rm: mocks.rm, writeFile: mocks.writeFile }
  return { ...replacement, default: replacement }
})
vi.mock('./binaries', () => ({ ffmpegPath: mocks.ffmpegPath }))
vi.mock('./face-pack', () => ({ requireFacePack: mocks.requireFacePack }))
vi.mock('./export-encoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./export-encoder')>()
  return { ...actual, exportEncoders: mocks.exportEncoders, softwareEncoder: mocks.softwareEncoder }
})
vi.mock('./face-detection-cache', () => ({ prepareFaceDetectionCache: mocks.prepareFaceDetectionCache }))
vi.mock('./face-export', () => ({
  decoderCommand: mocks.decoderCommand,
  faceEffectRows: mocks.faceEffectRows,
  rawVideoEncoderCommand: mocks.rawVideoEncoderCommand
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./face-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./face-process')>()
  return { ...actual, runFacePipeline: mocks.runFacePipeline }
})
vi.mock('./face-worker', () => ({
  nativeFaceWorkerCommand: mocks.nativeFaceWorkerCommand,
  restrictedIntelRenderNode: mocks.restrictedIntelRenderNode
}))
vi.mock('./jobs', () => ({ jobs: { run: mocks.jobsRun } }))
vi.mock('./privileged-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./privileged-export')>()
  return { ...actual, vaapiFfmpegPath: mocks.vaapiFfmpegPath }
})

import { aiExportCanvas, encodeWithAi, type AiExportContext } from './ai-export'
const aiPack = { executable: '/ai-worker', models: '/models/flashvsr-plus', rife: '/models/rife.xml' }
const facePack = { executable: '/face-worker', model: '/models/face.xml' }
const hardwareEncoder: ExportEncoder = {
  executable: '/hardware-ffmpeg', input: [], filterSuffix: 'format=nv12,hwupload',
  rawVideoFilter: 'format=nv12,hwupload', videoLabel: (label) => label,
  output: ['-c:v', 'h264_vaapi'], hardwareLabel: 'dGPU'
}
const cpuEncoder: ExportEncoder = {
  executable: '/bundled-ffmpeg', input: [], filterSuffix: '',
  videoLabel: (label) => label, output: ['-c:v', 'libx264'], hardwareLabel: 'CPU'
}
const filter = { graph: 'graph', videoLabel: 'video', audioLabel: 'audio' }
const request: ExportRequest = {
  canvas: { width: 1920, height: 1080, fps: 24, fit: 'contain' },
  sources: [],
  segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }],
  overlays: [],
  outputPath: '/tmp/output.mp4'
}

function cacheSession(): { workerArgs: string[]; commit: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn> } {
  return { workerArgs: [], commit: vi.fn(() => Promise.resolve()), cleanup: vi.fn(() => Promise.resolve()) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('otc_CPU_ONLY', undefined)
  mocks.rm.mockResolvedValue(undefined)
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.ffmpegPath.mockReturnValue('/bundled-ffmpeg')
  mocks.requireFacePack.mockResolvedValue(facePack)
  mocks.exportEncoders.mockResolvedValue([hardwareEncoder, cpuEncoder])
  mocks.softwareEncoder.mockReturnValue(cpuEncoder)
  mocks.prepareFaceDetectionCache.mockResolvedValue(cacheSession())
  mocks.decoderCommand.mockImplementation((inputArgs: string[]) => ({ executable: '/decoder', args: inputArgs }))
  mocks.faceEffectRows.mockReturnValue('face rows')
  mocks.rawVideoEncoderCommand.mockImplementation((encoder: ExportEncoder, width: number, height: number, fps: number, _duration: number, video: string) => ({
    executable: encoder.executable,
    args: ['--video-size', `${width}x${height}`, '--framerate', String(fps), video],
    ...(encoder.rawVideoFilter ? { gpuWorker: true } : {})
  }))
  mocks.runFacePipeline.mockResolvedValue(undefined)
  mocks.nativeFaceWorkerCommand.mockImplementation((pack: typeof facePack, _canvas: ProjectCanvas, _effects: string, device: string) => ({
    executable: pack.executable, args: ['--device', device]
  }))
  mocks.restrictedIntelRenderNode.mockResolvedValue(undefined)
  mocks.jobsRun.mockResolvedValue(undefined)
  mocks.vaapiFfmpegPath.mockResolvedValue('/hardware-ffmpeg')
})

afterEach(() => vi.unstubAllEnvs())

async function runExport(overrides: Partial<ExportRequest> = {}, context?: AiExportContext): Promise<void> {
  const resolvedRequest = { ...request, ...overrides }
  await encodeWithAi(
    resolvedRequest, ['-i', '/input.mp4'], filter, '/tmp/ai-work', '/tmp/output.mp4', 3, 'ai-test-job',
    context ?? { plan: aiEnhancementPlan(resolvedRequest.canvas, resolvedRequest.aiEnhance?.mode, resolvedRequest.focusZooms, resolvedRequest), pack: aiPack }
  )
}

describe('AI export geometry and worker setup', () => {
  it('passes only zoom ranges and the cropped portrait feed for a 4K-source Short', async () => {
    await runExport({
      canvas: { width: 1080, height: 1920, fps: 60, fit: 'cover' },
      sources: [{ id: 'source', metadata: { path: '/input.mp4', name: 'input', size: 1, modifiedAt: 1,
        duration: 3, width: 3840, height: 2160, fps: 60, videoCodec: 'hevc', hasAudio: true } }],
      focusZooms: [{ id: 'zoom', start: 0.1, duration: 0.2, zoom: 3, focusX: 0.5, focusY: 0.5 }]
    })
    const worker = (mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]).find((command) => command.executable === aiPack.executable)
    expect(worker?.args).toEqual(expect.arrayContaining(['--spatial-range', '6:18',
      '--width', '1080', '--height', '1920', '--output-width', '2160', '--output-height', '3840']))
  })

  it('passes half-open close-up frame ranges without changing 4K output geometry', async () => {
    const zoom = { id: 'zoom', start: 0.1, duration: 0.2, zoom: 2 as const, focusX: 0.5, focusY: 0.5 }
    await runExport({ canvas: { width: 3840, height: 2160, fps: 60, fit: 'contain' }, focusZooms: [zoom] })
    const worker = (mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]).find((command) => command.executable === aiPack.executable)
    expect(worker?.args).toEqual(expect.arrayContaining(['--spatial-range', '6:18', '--output-width', '3840', '--output-height', '2160']))
  })
  it.each([
    ['landscape', { width: 1920, height: 1080 }, { width: 3840, height: 2160 }],
    ['portrait', { width: 1080, height: 1920 }, { width: 2160, height: 3840 }],
    ['landscape at target', { width: 3840, height: 2160 }, { width: 3840, height: 2160 }],
    ['portrait at target', { width: 2160, height: 3840 }, { width: 2160, height: 3840 }],
    ['landscape above target', { width: 4096, height: 2160 }, { width: 4096, height: 2160 }],
    ['portrait above target', { width: 2160, height: 4096 }, { width: 2160, height: 4096 }]
  ] as const)('keeps the %s canvas aspect ratio at 4K', (_name, input, expected) => {
    const canvas = aiExportCanvas({ ...input, fps: 24, fit: 'contain' })
    expect(canvas).toMatchObject({ ...expected, fps: 60 })
    expect(canvas.width / canvas.height).toBeCloseTo(input.width / input.height, 10)
  })

  it.each([
    ['below 60', 30, 60, true],
    ['at 60', 60, 60, false],
    ['above 60', 120, 120, false]
  ] as const)('handles fps independently (%s)', (_name, inputFps, outputFps, interpolate) => {
    const plan = aiEnhancementPlan({ width: 3840, height: 2160, fps: inputFps, fit: 'contain' })
    expect(plan).toMatchObject({ interpolate, canvas: { width: 3840, height: 2160, fps: outputFps } })
  })

  it('never downscales an oversized canvas', () => {
    const input = { width: 5120, height: 2880, fps: 120, fit: 'contain' as const }
    expect(aiExportCanvas(input)).toEqual(input)
  })

  it('uses a resolved context without repeating the AI-pack preflight', async () => {
    const plan = aiEnhancementPlan(request.canvas)

    await runExport({}, { plan, pack: aiPack })

    const commands = mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]
    expect(commands[1]?.args).toEqual(expect.arrayContaining([
      '--output-width', '3840', '--output-height', '2160', '--output-fps', '60'
    ]))
  })

  it('keeps source settings separate from the AI output target', async () => {
    await runExport()

    expect(mocks.decoderCommand).toHaveBeenCalledWith(
      ['-i', '/input.mp4'], expect.objectContaining({
        audioLabel: filter.audioLabel, videoLabel: 'aiinput',
        graph: 'graph;[video]tpad=stop_mode=clone:stop=72[aiinput]'
      }), 3, expect.stringContaining('/tmp/ai-work/audio.m4a'), 72
    )
    expect(mocks.rawVideoEncoderCommand).toHaveBeenCalledWith(
      hardwareEncoder, 3840, 2160, 60, 3, '/tmp/ai-work/ai-video.mp4', 180
    )
    const commands = mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]
    expect(commands[0]).toMatchObject({ executable: '/decoder' })
    expect(commands[1]?.args).toEqual(expect.arrayContaining([
      '--width', '1920', '--height', '1080', '--fps', '24',
      '--output-width', '3840', '--output-height', '2160', '--output-fps', '60'
    ]))
    expect(commands[2]).toMatchObject({ executable: '/hardware-ffmpeg', gpuWorker: true })
  })

  it('keeps separate jobs from sharing or deleting an intermediate video', async () => {
    const context = { plan: aiEnhancementPlan(request.canvas), pack: aiPack }
    await Promise.all(['one', 'two'].map((job) => encodeWithAi(
      request, ['-i', '/input.mp4'], filter, `/tmp/ai-${job}`, request.outputPath,
      3, `ai-${job}`, context
    )))

    const videos = mocks.rawVideoEncoderCommand.mock.calls.map((call) => String(call[5]))
    expect(videos).toEqual(expect.arrayContaining([
      '/tmp/ai-one/ai-video.mp4', '/tmp/ai-two/ai-video.mp4'
    ]))
    expect(new Set(videos).size).toBe(2)
    for (const video of videos) expect(mocks.rm).toHaveBeenCalledWith(video, { force: true })
  })

  it.each(['turbo', 'base'] as const)('exports a portrait Short at 4K60 in %s mode', async (mode) => {
    const canvas = { width: 1080, height: 1920, fps: 30.000845094228005, fit: 'cover' as const }
    await runExport({ canvas, aiEnhance: { mode } })

    const commands = mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]
    expect(commands[1]?.args).toEqual(expect.arrayContaining([
      '--mode', mode, '--width', '1080', '--height', '1920',
      '--output-width', '2160', '--output-height', '3840', '--output-fps', '60'
    ]))
    expect(mocks.rawVideoEncoderCommand).toHaveBeenCalledWith(
      hardwareEncoder, 2160, 3840, 60, 3, '/tmp/ai-work/ai-video.mp4', 180
    )
  })

  it.each([
    ['spatial only', { width: 1920, height: 1080, fps: 60 }, { width: 3840, height: 2160, fps: 60 }, true, false],
    ['interpolation only', { width: 3840, height: 2160, fps: 30 }, { width: 3840, height: 2160, fps: 60 }, false, true],
    ['neither', { width: 3840, height: 2160, fps: 60 }, { width: 3840, height: 2160, fps: 60 }, false, false],
    ['no fps reduction', { width: 3840, height: 2160, fps: 120 }, { width: 3840, height: 2160, fps: 120 }, false, false]
  ] as const)('runs only the needed operation (%s)', async (_name, input, expected, spatial, _interpolate) => {
    expect(expected.fps).toBe(_interpolate ? 60 : input.fps)
    await runExport({
      canvas: { ...input, fit: 'contain' },
      aiEnhance: spatial ? { mode: 'turbo' } : {}
    })

    expect(mocks.rawVideoEncoderCommand).toHaveBeenCalledWith(
      hardwareEncoder, expected.width, expected.height, expected.fps, 3, '/tmp/ai-work/ai-video.mp4', 3 * expected.fps
    )
    const commands = mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]
    expect(commands[1]?.args).toEqual(expect.arrayContaining([
      '--output-width', String(expected.width), '--output-height', String(expected.height), '--output-fps', String(expected.fps)
    ]))
    if (spatial) expect(commands[1]?.args).toEqual(expect.arrayContaining(['--mode', 'turbo', '--scratch', '/tmp/ai-work']))
    else expect(commands[1]?.args).not.toContain('--mode')
  })

  it('does not require the face pack when no face blur is requested', async () => {
    mocks.requireFacePack.mockRejectedValue(new Error('face pack unavailable'))

    await runExport()

    expect(mocks.requireFacePack).not.toHaveBeenCalled()
    expect(mocks.prepareFaceDetectionCache).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('uses one privileged pipeline for face detection, AI enhancement, and encoding', async () => {
    mocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD128')
    await runExport({ faceBlurs: [{
      id: 'face', start: 0, duration: 1, sensitivity: 0.5, detail: 'standard',
      holdSeconds: 0, strength: 0.5, style: 'blur'
    }] })

    const commands = mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]
    expect(commands).toHaveLength(3)
    expect(commands[0]).toMatchObject({ executable: '/decoder' })
    expect(commands[1]).toMatchObject({ executable: '/usr/bin/pkexec', elevated: true })
    expect(commands[2]).toMatchObject({ executable: '/bundled-ffmpeg' })
    expect(commands.filter((command) => command.executable === '/usr/bin/pkexec')).toHaveLength(1)
    expect(commands[1]?.args).toEqual(expect.arrayContaining(['/face-worker', '/ai-worker', '/hardware-ffmpeg']))
    expect(commands[1]?.args).not.toContain('/usr/bin/pkexec')
    expect(mocks.exportEncoders).not.toHaveBeenCalled()
  })
})

describe('AI export fallback and cleanup behavior', () => {
  const rifeOnly = { canvas: { ...request.canvas, width: 3840, height: 2160 } }

  it('pads the decoder tail to the requested source frame count', async () => {
    await runExport()

    const decoded = mocks.decoderCommand.mock.calls[0]?.[1] as typeof filter
    expect(decoded.videoLabel).toBe('aiinput')
    expect(decoded.graph).toBe('graph;[video]tpad=stop_mode=clone:stop=72[aiinput]')
    expect(mocks.decoderCommand.mock.calls[0]?.[2]).toBe(3)
    expect(mocks.decoderCommand.mock.calls[0]?.[4]).toBe(72)
  })

  it('delivers the exact AI frame count after a fractional trim using real CPU FFmpeg', async () => {
    const fps = 30.000845094228005
    const duration = 17.30411991549296
    const clockFilter = {
      graph: `[0:v]trim=start=2.128666:end=19.432786,setpts=PTS-STARTPTS,fps=${fps}[video]`,
      videoLabel: 'video', audioLabel: 'audio'
    }
    const clockRequest = { ...request, canvas: { ...request.canvas, fps } }
    await encodeWithAi(clockRequest, [], clockFilter, '/tmp/ai-work', '/tmp/result.mp4', duration,
      'clock-test', { plan: aiEnhancementPlan(clockRequest.canvas), pack: aiPack })
    const padded = mocks.decoderCommand.mock.calls[0]?.[1] as typeof filter
    // Tiny CPU-generated frames isolate the timing contract, without a model.
    const frames = (graph: string, label: string, frameCount?: number): number => execFileSync(
      join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'), [
        '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', 'color=size=16x16:rate=30:duration=24',
        '-filter_complex', graph, '-map', `[${label}]`,
        ...(frameCount === undefined ? ['-t', String(duration)] : ['-frames:v', String(frameCount)]),
        '-an', '-pix_fmt', 'rgb24', '-threads', '1', '-f', 'rawvideo', 'pipe:1'
      ], { maxBuffer: 1024 * 1024 }
    ).length / (16 * 16 * 3)

    expect(frames(clockFilter.graph, clockFilter.videoLabel)).toBe(519)
    expect(padded.graph).toBe(`[0:v]trim=start=2.128666:end=19.432786,setpts=PTS-STARTPTS,fps=${fps}[video];[video]tpad=stop_mode=clone:stop=520[aiinput]`)
    expect(frames(padded.graph, padded.videoLabel, mocks.decoderCommand.mock.calls[0]?.[4] as number)).toBe(Math.ceil(duration * fps))
  })

  it('fills a multi-frame decoder shortfall with real CPU FFmpeg', async () => {
    const frames = (graph: string, label: string, source: string, frameCount: number): number => execFileSync(
      join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'), [
        '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', source, '-filter_complex', graph, '-map', `[${label}]`,
        '-frames:v', String(frameCount), '-an', '-pix_fmt', 'rgb24', '-threads', '1', '-f', 'rawvideo', 'pipe:1'
      ], { maxBuffer: 1024 * 1024 }
    ).length / (16 * 16 * 3)

    const shortRequest = { ...request, canvas: { ...request.canvas, fps: 10 } }
    const shortFilter = { graph: '[0:v]setpts=PTS-STARTPTS[video]', videoLabel: 'video', audioLabel: 'audio' }
    await encodeWithAi(shortRequest, [], shortFilter, '/tmp/ai-work', '/tmp/result.mp4', 1,
      'shortfall-test', { plan: aiEnhancementPlan(shortRequest.canvas), pack: aiPack })
    const shortDecoded = mocks.decoderCommand.mock.calls[0]?.[1] as typeof filter
    expect(shortDecoded.graph).toBe('[0:v]setpts=PTS-STARTPTS[video];[video]tpad=stop_mode=clone:stop=10[aiinput]')
    expect(mocks.decoderCommand.mock.calls[0]?.[4]).toBe(10)
    // 0.7 seconds at 10 fps supplies seven frames; stop=1 would produce eight,
    // while the requested ten-frame cap proves the multi-frame tail is filled.
    expect(frames(shortDecoded.graph, shortDecoded.videoLabel, 'color=size=16x16:rate=10:duration=0.7', 10)).toBe(10)

    const problemFps = 29.998039343833735
    const problemDuration = 15.402667
    const problemRequest = { ...request, canvas: { ...request.canvas, fps: problemFps } }
    const problemFilter = { graph: `[0:v]setpts=PTS-STARTPTS,fps=${problemFps}[video]`, videoLabel: 'video', audioLabel: 'audio' }
    await encodeWithAi(problemRequest, [], problemFilter, '/tmp/ai-work', '/tmp/result.mp4', problemDuration,
      'problem-clock-test', { plan: aiEnhancementPlan(problemRequest.canvas), pack: aiPack })
    const problemDecoded = mocks.decoderCommand.mock.calls[1]?.[1] as typeof filter
    expect(problemDecoded.graph).toBe(`[0:v]setpts=PTS-STARTPTS,fps=${problemFps}[video];[video]tpad=stop_mode=clone:stop=463[aiinput]`)
    expect(mocks.decoderCommand.mock.calls[1]?.[4]).toBe(463)
    // The observed 15.301-second/459-frame source must reach the 463-frame
    // container/audio request at the actual fractional source clock.
    expect(frames(problemDecoded.graph, problemDecoded.videoLabel,
      `color=size=16x16:rate=${problemFps}:duration=15.301`, 463)).toBe(463)
  })

  it('preserves the privileged spatial error instead of replacing it with a GPU-discovery failure', async () => {
    mocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD130')
    mocks.runFacePipeline
      .mockRejectedValueOnce(new Error('source ended before the requested duration'))
      .mockRejectedValue(new Error('AUTO found no discrete Intel GPU'))

    await expect(runExport()).rejects.toThrow('source ended before the requested duration')

    expect(mocks.runFacePipeline).toHaveBeenCalledOnce()
    expect(mocks.exportEncoders).not.toHaveBeenCalled()
    expect(mocks.jobsRun).not.toHaveBeenCalled()
  })

  it('retains ordinary AUTO after authorization denial without prompting again', async () => {
    mocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD128')
    mocks.exportEncoders.mockResolvedValue([cpuEncoder])
    mocks.runFacePipeline
      .mockRejectedValueOnce(new FaceAuthorizationError('authorization denied'))
      .mockResolvedValueOnce(undefined)

    await runExport(rifeOnly)

    expect(mocks.runFacePipeline).toHaveBeenCalledTimes(2)
    const first = mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]
    const second = mocks.runFacePipeline.mock.calls[1]?.[0] as FaceCommand[]
    expect(first[1]).toMatchObject({ executable: '/usr/bin/pkexec', elevated: true })
    expect(first[1]?.args).toContain('AUTO')
    expect(second[1]).toMatchObject({ executable: '/ai-worker', gpuWorker: true })
    expect(second[1]?.args).toContain('AUTO')
    expect(second[2]?.executable).toBe('/bundled-ffmpeg')
    expect(second.every((command) => command.executable !== '/usr/bin/pkexec' && !command.elevated)).toBe(true)
    expect(mocks.restrictedIntelRenderNode).toHaveBeenCalledOnce()
    expect(mocks.vaapiFfmpegPath).toHaveBeenCalledOnce()
    expect(mocks.jobsRun).toHaveBeenCalledOnce()
    expect(mocks.runFacePipeline.mock.calls[1]?.[3]).toMatchObject({
      message: 'GPU authorization unavailable; trying available hardware…'
    })
  })

  it('keeps enhancement AUTO when a failed hardware encoder is replaced by software', async () => {
    mocks.runFacePipeline.mockRejectedValueOnce(new Error('hardware encoder failed')).mockResolvedValueOnce(undefined)

    await runExport()

    expect(mocks.runFacePipeline).toHaveBeenCalledTimes(2)
    const first = mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]
    const second = mocks.runFacePipeline.mock.calls[1]?.[0] as FaceCommand[]
    expect(first[2]?.executable).toBe('/hardware-ffmpeg')
    expect(second[2]?.executable).toBe('/bundled-ffmpeg')
    expect(second[1]).toMatchObject({ executable: '/ai-worker', gpuWorker: true })
    expect(second[1]?.args).toContain('AUTO')
    expect(second[1]?.args).not.toContain('CPU')
    expect(second.every((command) => !command.elevated)).toBe(true)
    expect(mocks.jobsRun).toHaveBeenCalledOnce()
    expect(mocks.rm).toHaveBeenCalledTimes(3) // Before each attempt and final cleanup.
  })

  it('retries the final AUTO pipeline exactly once on CPU', async () => {
    mocks.exportEncoders.mockResolvedValue([cpuEncoder])
    mocks.runFacePipeline.mockRejectedValueOnce(new Error('AUTO inference failed')).mockResolvedValueOnce(undefined)

    await runExport(rifeOnly)

    expect(mocks.runFacePipeline).toHaveBeenCalledTimes(2)
    const first = mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]
    const second = mocks.runFacePipeline.mock.calls[1]?.[0] as FaceCommand[]
    expect(first[1]).toMatchObject({ executable: '/ai-worker', gpuWorker: true })
    expect(first[1]?.args).toContain('AUTO')
    expect(second[1]).toMatchObject({ executable: '/ai-worker', gpuWorker: false })
    expect(second[1]?.args).toContain('CPU')
    expect(second[2]?.executable).toBe(first[2]?.executable)
    expect(mocks.jobsRun).toHaveBeenCalledOnce()
    expect(mocks.rm).toHaveBeenCalledTimes(3)
  })

  it('preserves a failed final CPU retry and cleans up without another attempt', async () => {
    mocks.exportEncoders.mockResolvedValue([cpuEncoder])
    mocks.runFacePipeline.mockRejectedValueOnce(new Error('AUTO failed')).mockRejectedValueOnce(new Error('CPU failed'))

    await expect(runExport(rifeOnly)).rejects.toThrow('CPU failed')

    expect(mocks.runFacePipeline).toHaveBeenCalledTimes(2)
    expect(mocks.jobsRun).not.toHaveBeenCalled()
    expect(mocks.rm).toHaveBeenCalledTimes(3)
  })

  it('does not redundantly retry an explicitly CPU-only failure', async () => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    mocks.runFacePipeline.mockRejectedValueOnce(new Error('CPU failed'))

    await expect(runExport(rifeOnly)).rejects.toThrow('CPU failed')

    expect(mocks.runFacePipeline).toHaveBeenCalledOnce()
    const commands = mocks.runFacePipeline.mock.calls[0]?.[0] as FaceCommand[]
    expect(commands[1]).toMatchObject({ executable: '/ai-worker', gpuWorker: false })
    expect(commands[1]?.args).toContain('CPU')
    expect(mocks.exportEncoders).not.toHaveBeenCalled()
    expect(mocks.restrictedIntelRenderNode).not.toHaveBeenCalled()
    expect(mocks.jobsRun).not.toHaveBeenCalled()
    expect(mocks.rm).toHaveBeenCalledTimes(2)
  })

  it('does not retry a cancelled GPU attempt', async () => {
    mocks.runFacePipeline.mockRejectedValue(new Error('Job cancelled'))

    await expect(runExport()).rejects.toThrow('Job cancelled')

    expect(mocks.runFacePipeline).toHaveBeenCalledOnce()
    expect(mocks.jobsRun).not.toHaveBeenCalled()
    expect(mocks.rm).toHaveBeenCalledTimes(2)
  })

  it('never retries spatial Flash inference on an unqualified CPU backend', async () => {
    mocks.exportEncoders.mockResolvedValue([cpuEncoder])
    mocks.runFacePipeline.mockRejectedValueOnce(new Error('Flash GPU inference failed'))
    await expect(runExport()).rejects.toThrow('Flash GPU inference failed')
    expect(mocks.runFacePipeline).toHaveBeenCalledOnce()
    expect(mocks.jobsRun).not.toHaveBeenCalled()
  })

  it('rejects CPU-only spatial work before starting a pipeline', async () => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    await expect(runExport()).rejects.toThrow('requires an Intel discrete GPU')
    expect(mocks.runFacePipeline).not.toHaveBeenCalled()
  })

  it('reports denied spatial GPU authorization without reprompting or trying CPU', async () => {
    mocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD128')
    mocks.runFacePipeline.mockRejectedValueOnce(new FaceAuthorizationError('authorization denied'))
    await expect(runExport()).rejects.toThrow('requires GPU access')
    expect(mocks.runFacePipeline).toHaveBeenCalledOnce()
    expect(mocks.exportEncoders).not.toHaveBeenCalled()
  })

  it('removes the intermediate AI video after a successful export', async () => {
    await runExport()

    expect(mocks.rm).toHaveBeenCalledWith('/tmp/ai-work/ai-video.mp4', { force: true })
    expect(mocks.jobsRun).toHaveBeenCalledOnce()
  })
})
