import { afterEach, beforeEach, vi } from 'vitest'
import { upscalePlan } from '../upscale'
import type { ExportRequest, ProjectCanvas } from '../types'
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
  nativeFaceWorkerCommand: mocks.nativeFaceWorkerCommand
}))
vi.mock('./intel-device', () => ({ restrictedIntelRenderNode: mocks.restrictedIntelRenderNode }))
vi.mock('./jobs', () => ({ jobs: { run: mocks.jobsRun } }))
vi.mock('./privileged-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./privileged-export')>()
  return { ...actual, vaapiFfmpegPath: mocks.vaapiFfmpegPath }
})

import { encodeWithUpscale, type UpscaleExportContext } from './upscale-export'
const upscalePack = { executable: '/upscale-worker', models: '/models/flashvsr-plus', rife: '/models/rife.xml' }
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

async function runExport(overrides: Partial<ExportRequest> = {}, context?: UpscaleExportContext): Promise<void> {
  const resolvedRequest = { ...request, ...overrides }
  await encodeWithUpscale(
    resolvedRequest, ['-i', '/input.mp4'], filter, '/tmp/upscale-work', '/tmp/output.mp4', 3, 'upscale-test-job',
    context ?? { plan: upscalePlan(resolvedRequest.canvas, resolvedRequest.upscale?.mode, resolvedRequest.focusZooms, resolvedRequest), pack: upscalePack }
  )
}

export { mocks, upscalePack, hardwareEncoder, cpuEncoder, filter, request, runExport }
