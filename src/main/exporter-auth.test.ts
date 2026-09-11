import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  statfs: vi.fn(),
  writeFile: vi.fn()
}))
const encoderMocks = vi.hoisted(() => ({
  exportEncoders: vi.fn(),
  softwareEncoder: vi.fn(),
  integratedDecodeDevice: vi.fn()
}))
const faceMocks = vi.hoisted(() => ({ encodeWithFaces: vi.fn() }))
const workerMocks = vi.hoisted(() => ({ restrictedIntelRenderNode: vi.fn() }))
const privilegedMocks = vi.hoisted(() => ({ encodeWithPrivilegedGpu: vi.fn() }))
const jobMocks = vi.hoisted(() => ({ run: vi.fn() }))
const cacheMocks = vi.hoisted(() => ({ tryReuseFacePreview: vi.fn() }))
const timingMocks = vi.hoisted(() => ({ previewTimelineOffset: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const replacement = { ...actual, ...fsMocks }
  return { ...replacement, default: replacement }
})
vi.mock('./export-encoder', () => encoderMocks)
vi.mock('./face-export', () => faceMocks)
vi.mock('./face-worker', () => workerMocks)
vi.mock('./jobs', () => ({ jobs: jobMocks }))
vi.mock('./privileged-export', () => privilegedMocks)
vi.mock('./face-preview-cache', () => cacheMocks)
vi.mock('./preview-timing', () => timingMocks)

import { exportVideo } from './exporter'

const encoder = {
  executable: '/usr/bin/ffmpeg',
  input: [],
  filterSuffix: '',
  videoLabel: (label: string): string => label,
  output: ['-c:v', 'libx264']
}
const request: ExportRequest = {
  canvas: { width: 1280, height: 720, fps: 30, fit: 'contain' },
  sources: [{
    id: 'source',
    metadata: {
      path: '/input.mp4', name: 'Input', size: 1, modifiedAt: 1, duration: 10,
      width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
    }
  }],
  segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
  overlays: [],
  outputPath: '/output.mp4'
}

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.mkdtemp.mockResolvedValue('/tmp/otc-export-test')
  fsMocks.statfs.mockResolvedValue({ bavail: 1_000_000_000, bsize: 1 })
  fsMocks.stat.mockResolvedValue({ dev: 1 })
  fsMocks.rm.mockResolvedValue(undefined)
  fsMocks.mkdir.mockResolvedValue(undefined)
  fsMocks.rename.mockResolvedValue(undefined)
  fsMocks.writeFile.mockResolvedValue(undefined)
  encoderMocks.exportEncoders.mockResolvedValue([encoder])
  encoderMocks.softwareEncoder.mockReturnValue(encoder)
  encoderMocks.integratedDecodeDevice.mockResolvedValue(undefined)
  timingMocks.previewTimelineOffset.mockResolvedValue(undefined)
  workerMocks.restrictedIntelRenderNode.mockResolvedValue(undefined)
  privilegedMocks.encodeWithPrivilegedGpu.mockResolvedValue(undefined)
  jobMocks.run.mockResolvedValue(undefined)
  cacheMocks.tryReuseFacePreview.mockResolvedValue(false)
})

describe('restricted GPU export authorization', () => {
  it('uses the privileged export entrypoint before probing encoders', async () => {
    workerMocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD130')

    await exportVideo(request)

    expect(privilegedMocks.encodeWithPrivilegedGpu).toHaveBeenCalledTimes(1)
    const call = privilegedMocks.encodeWithPrivilegedGpu.mock.calls[0] as unknown[] | undefined
    expect(call?.[0]).toBe(request)
    expect(call?.[1]).toEqual(expect.arrayContaining(['-i', '/input.mp4']))
    const filter = call?.[2] as { graph?: unknown; videoLabel?: unknown; audioLabel?: unknown } | undefined
    expect(typeof filter?.graph).toBe('string')
    expect(filter?.videoLabel).toBe('basev')
    expect(filter?.audioLabel).toBe('aout')
    expect(call?.[3]).toBe('/tmp/otc-export-test')
    expect(typeof call?.[4]).toBe('string')
    expect(String(call?.[4])).toMatch(/\.otc\.mp4$/)
    expect(call?.[5]).toBe(10)
    expect(typeof call?.[6]).toBe('string')
    expect(call?.[7]).toBe('/dev/dri/renderD130')
    expect(encoderMocks.exportEncoders).not.toHaveBeenCalled()
    expect(jobMocks.run).not.toHaveBeenCalled()
    expect(fsMocks.statfs).toHaveBeenCalledTimes(3)
  })

  it('falls back directly to software encoding after a non-cancellation failure', async () => {
    workerMocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD130')
    privilegedMocks.encodeWithPrivilegedGpu.mockRejectedValue(new Error('GPU codec unavailable'))

    await exportVideo(request)

    expect(encoderMocks.exportEncoders).not.toHaveBeenCalled()
    expect(encoderMocks.softwareEncoder).toHaveBeenCalledTimes(1)
    expect(jobMocks.run).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      expect.arrayContaining([
        '-c:v', 'libx264', '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1'
      ]),
      'export', 10, expect.any(String),
      'GPU authorization or encoding unavailable; using CPU', { phase: 'encoding', hardwareLabel: 'CPU' }
    )
  })

  it('rethrows cancellation without software fallback', async () => {
    workerMocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD130')
    privilegedMocks.encodeWithPrivilegedGpu.mockRejectedValue(new Error('Job cancelled'))

    await expect(exportVideo(request)).rejects.toThrow('Job cancelled')
    expect(encoderMocks.softwareEncoder).not.toHaveBeenCalled()
    expect(jobMocks.run).not.toHaveBeenCalled()
  })

  it('keeps the ordinary encoder probe when no restricted node exists', async () => {
    await exportVideo(request)

    expect(encoderMocks.exportEncoders).toHaveBeenCalledTimes(1)
    expect(jobMocks.run).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg', expect.arrayContaining([
        '-c:v', 'libx264', '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1'
      ]), 'export', 10, expect.any(String), '', { phase: 'encoding', hardwareLabel: undefined }
    )
    expect(privilegedMocks.encodeWithPrivilegedGpu).not.toHaveBeenCalled()
  })

  it('reuses a cached face preview before authorization or encoder work', async () => {
    cacheMocks.tryReuseFacePreview.mockResolvedValue(true)
    workerMocks.restrictedIntelRenderNode.mockResolvedValue('/dev/dri/renderD130')
    const faceRequest: ExportRequest = { ...request, faceBlurs: [{
      id: 'face', start: 0, duration: 1, sensitivity: 0.5, detail: 'standard', holdSeconds: 0,
      strength: 0.5, style: 'blur'
    }] }

    await exportVideo(faceRequest)

    expect(cacheMocks.tryReuseFacePreview).toHaveBeenCalledTimes(1)
    const call = cacheMocks.tryReuseFacePreview.mock.calls[0] as unknown[] | undefined
    expect(call?.[0]).toBe(faceRequest)
    expect(typeof call?.[1]).toBe('string')
    expect(typeof call?.[2]).toBe('string')
    expect(call?.[3]).toBe(10)
    expect(privilegedMocks.encodeWithPrivilegedGpu).not.toHaveBeenCalled()
    expect(workerMocks.restrictedIntelRenderNode).not.toHaveBeenCalled()
    expect(encoderMocks.exportEncoders).not.toHaveBeenCalled()
    expect(jobMocks.run).not.toHaveBeenCalled()
    expect(fsMocks.rename).toHaveBeenCalledWith(expect.any(String), '/output.mp4')
  })

  it('rejects an empty timeline before creating output directories', async () => {
    await expect(exportVideo({ ...request, segments: [] })).rejects.toThrow('The timeline is empty')
    expect(fsMocks.mkdir).not.toHaveBeenCalled()
    expect(fsMocks.statfs).not.toHaveBeenCalled()
  })

  it('rejects when the destination filesystem is below the conservative estimate', async () => {
    fsMocks.statfs.mockResolvedValue({ bavail: 0, bsize: 1 })

    await expect(exportVideo(request)).rejects.toThrow('Not enough free disk space')
    expect(fsMocks.mkdtemp).not.toHaveBeenCalled()
  })

  it('uses the face encoder branch when no cached preview is available', async () => {
    const faceRequest: ExportRequest = {
      ...request,
      faceBlurs: [{
        id: 'face', start: 0, duration: 1, sensitivity: 0.5, detail: 'standard', holdSeconds: 0,
        strength: 0.5, style: 'blur'
      }]
    }

    await exportVideo(faceRequest)

    expect(faceMocks.encodeWithFaces).toHaveBeenCalledTimes(1)
    expect(privilegedMocks.encodeWithPrivilegedGpu).not.toHaveBeenCalled()
    expect(encoderMocks.exportEncoders).not.toHaveBeenCalled()
  })

  it('passes global later-clip timing and selected inputs to face export', async () => {
    fsMocks.statfs.mockResolvedValue({ bavail: 100_000_000_000, bsize: 1 })
    const fps = 60000 / 1001
    const range = [515.298117, 540.306433] as const
    const timingOffset = 250.316733
    const localStart = range[0] - timingOffset
    const localOffset = Math.floor((localStart - 2) * fps) / fps
    const globalOffset = timingOffset + localOffset
    const faceEffect = {
      id: 'face', start: range[0], duration: 2, sensitivity: 0.5,
      detail: 'standard' as const, holdSeconds: 0, strength: 0.5, style: 'blur' as const
    }
    const source = request.sources[0]
    if (!source) throw new Error('missing test source')
    const faceRequest: ExportRequest = {
      ...request,
      canvas: { ...request.canvas, fps },
      sources: [
        { id: 'prefix-source', metadata: { ...source.metadata, path: '/prefix.mp4', duration: 320.32, fps } },
        { id: 'selected-source', metadata: { ...source.metadata, path: '/selected.mp4', duration: 320.32, fps } }
      ],
      segments: [
        { id: 'prefix', sourceId: 'prefix-source', sourceStart: 70, sourceEnd: 320.32 },
        { id: 'selected', sourceId: 'selected-source', sourceStart: 0, sourceEnd: 320.32 }
      ],
      faceBlurs: [faceEffect]
    }
    const original = structuredClone(faceRequest)
    timingMocks.previewTimelineOffset.mockResolvedValue(timingOffset)

    await exportVideo(faceRequest, range)

    expect(faceMocks.encodeWithFaces).toHaveBeenCalledTimes(1)
    const call = faceMocks.encodeWithFaces.mock.calls[0] as unknown[] | undefined
    const workerRequest = call?.[0] as ExportRequest | undefined
    const inputArgs = call?.[1] as string[] | undefined
    const filter = call?.[2] as { graph: string } | undefined
    const context = call?.[7] as { sourceRequest?: ExportRequest; frameOffset?: number; preparationStart?: number } | undefined
    expect(workerRequest?.faceBlurs).toEqual([{ ...faceEffect, start: 0 }])
    expect(inputArgs?.filter((value) => value === '/selected.mp4')).toHaveLength(2)
    expect(inputArgs).not.toContain('/prefix.mp4')
    expect(context?.sourceRequest).toBe(faceRequest)
    expect(context?.frameOffset).toBe(Math.round(range[0] * fps))
    expect(context?.preparationStart).toBeCloseTo(globalOffset, 12)
    expect(context?.preparationStart).not.toBe(0)
    expect(context?.sourceRequest?.segments).toHaveLength(2)
    expect(filter?.graph).toContain('asetpts=PTS+250.320000/TB[seeka]')
    expect(faceRequest).toEqual(original)
  })

  it('retries a failed ordinary encoder with the next candidate', async () => {
    const secondEncoder = { ...encoder, executable: '/usr/bin/second-ffmpeg' }
    encoderMocks.exportEncoders.mockResolvedValue([encoder, secondEncoder])
    jobMocks.run.mockRejectedValueOnce(new Error('first encoder failed')).mockResolvedValueOnce(undefined)

    await exportVideo(request)

    expect(jobMocks.run).toHaveBeenCalledTimes(2)
    expect(jobMocks.run.mock.calls[1]?.[0]).toBe('/usr/bin/second-ffmpeg')
    expect(fsMocks.rm).toHaveBeenCalledWith(expect.stringMatching(/\.otc\.mp4$/), { force: true })
  })

  it('does not retry an ordinary encoder after cancellation', async () => {
    encoderMocks.exportEncoders.mockResolvedValue([encoder, { ...encoder, executable: '/usr/bin/second-ffmpeg' }])
    jobMocks.run.mockRejectedValue(new Error('Job cancelled'))

    await expect(exportVideo(request)).rejects.toThrow('Job cancelled')

    expect(jobMocks.run).toHaveBeenCalledOnce()
  })

  it('propagates the last ordinary encoder failure', async () => {
    jobMocks.run.mockRejectedValue(new Error('ordinary encoder failed'))

    await expect(exportVideo(request)).rejects.toThrow('ordinary encoder failed')

    expect(jobMocks.run).toHaveBeenCalledOnce()
  })

  it('rejects an SVG overlay that has not been rendered', async () => {
    const overlay = {
      id: 'svg', type: 'image', name: 'SVG overlay', path: '/overlay.svg', start: 0, duration: 1,
      zIndex: 1, x: 0, y: 0, width: 0.5, height: 0.5, opacity: 1
    } satisfies ExportRequest['overlays'][number]

    await expect(exportVideo({ ...request, overlays: [overlay] })).rejects.toThrow('was not rendered before export')
    expect(encoderMocks.exportEncoders).not.toHaveBeenCalled()
  })

  it('rejects a video overlay that requests unavailable audio', async () => {
    const overlay = {
      id: 'video', type: 'video', name: 'Silent clip', path: '/silent.mp4', start: 0, duration: 1,
      zIndex: 1, x: 0, y: 0, width: 0.5, height: 0.5, opacity: 1,
      loop: false, audioEnabled: true, hasAudio: false, sourceIn: 0, sourceDuration: 1, volume: 1
    } satisfies ExportRequest['overlays'][number]

    await expect(exportVideo({ ...request, overlays: [overlay] })).rejects.toThrow('has no audio stream')
    expect(encoderMocks.exportEncoders).not.toHaveBeenCalled()
  })

  it('rejects a timeline segment whose source is missing', async () => {
    const missingSource = {
      ...request,
      segments: [{ id: 'missing', sourceId: 'not-in-sources', sourceStart: 0, sourceEnd: 1 }]
    } as ExportRequest

    await expect(exportVideo(missingSource)).rejects.toThrow('A timeline video source is missing')
    expect(encoderMocks.exportEncoders).not.toHaveBeenCalled()
  })
})
