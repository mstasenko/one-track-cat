import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { ExportRequest } from '../types'

const aiPipeline = vi.hoisted(() => ({
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  ensureDiskSpace: vi.fn(),
  ensureFaceExportDiskSpace: vi.fn(),
  requireAiPack: vi.fn(),
  exportEncoders: vi.fn(),
  softwareEncoder: vi.fn(),
  integratedDecodeDevice: vi.fn(),
  decoderCommand: vi.fn(),
  faceEffectRows: vi.fn(),
  rawVideoEncoderCommand: vi.fn(),
  runFacePipeline: vi.fn(),
  jobsRun: vi.fn()
}))

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const replacement = {
    ...actual,
    mkdir: aiPipeline.mkdir,
    mkdtemp: aiPipeline.mkdtemp,
    rename: aiPipeline.rename,
    rm: aiPipeline.rm,
    writeFile: aiPipeline.writeFile
  }
  return { ...replacement, default: replacement }
})
vi.mock('./binaries', () => ({ ffmpegPath: () => '/usr/bin/ffmpeg', ffprobePath: () => '/usr/bin/ffprobe' }))
vi.mock('./jobs', () => ({ jobs: { run: aiPipeline.jobsRun } }))
vi.mock('./export-space', () => ({
  ensureDiskSpace: aiPipeline.ensureDiskSpace,
  ensureFaceExportDiskSpace: aiPipeline.ensureFaceExportDiskSpace
}))
vi.mock('./ai-pack', () => ({ requireAiPack: aiPipeline.requireAiPack }))
vi.mock('./export-encoder', () => ({
  exportEncoders: aiPipeline.exportEncoders,
  softwareEncoder: aiPipeline.softwareEncoder,
  integratedDecodeDevice: aiPipeline.integratedDecodeDevice
}))
vi.mock('./face-export', () => ({
  encodeWithFaces: vi.fn(),
  decoderCommand: aiPipeline.decoderCommand,
  faceEffectRows: aiPipeline.faceEffectRows,
  rawVideoEncoderCommand: aiPipeline.rawVideoEncoderCommand
}))
vi.mock('./face-process', () => ({ runFacePipeline: aiPipeline.runFacePipeline, FaceAuthorizationError: class extends Error {} }))
vi.mock('./face-detection-cache', () => ({ prepareFaceDetectionCache: vi.fn() }))
vi.mock('./face-worker', () => ({ restrictedIntelRenderNode: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./privileged-export', () => ({ encodeWithPrivilegedGpu: vi.fn() }))
vi.mock('./face-preview-cache', () => ({ tryReuseFacePreview: vi.fn().mockResolvedValue(false) }))

import { buildFilterGraph, exportVideo } from './exporter'

const encoder = {
  executable: '/ffmpeg', input: [], filterSuffix: '',
  videoLabel: (label: string): string => label, output: ['-c:v', 'libx264']
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('otc_CPU_ONLY', undefined)
  aiPipeline.mkdir.mockResolvedValue(undefined)
  aiPipeline.mkdtemp.mockResolvedValue('/output/.otc-export-test')
  aiPipeline.rename.mockResolvedValue(undefined)
  aiPipeline.rm.mockResolvedValue(undefined)
  aiPipeline.writeFile.mockResolvedValue(undefined)
  aiPipeline.ensureDiskSpace.mockResolvedValue(undefined)
  aiPipeline.ensureFaceExportDiskSpace.mockResolvedValue(undefined)
  aiPipeline.requireAiPack.mockResolvedValue({ executable: '/ai-worker', models: '/models/flash', rife: '/rife.xml' })
  aiPipeline.exportEncoders.mockResolvedValue([encoder])
  aiPipeline.softwareEncoder.mockReturnValue(encoder)
  aiPipeline.integratedDecodeDevice.mockResolvedValue(undefined)
  aiPipeline.decoderCommand.mockImplementation((inputArgs: string[], filter: { graph: string; videoLabel: string; audioLabel: string }) => ({
    executable: '/decoder',
    args: [...inputArgs, '-filter_complex', filter.graph, '-map', `[${filter.videoLabel}]`, '-map', `[${filter.audioLabel}]`]
  }))
  aiPipeline.rawVideoEncoderCommand.mockImplementation((_encoder: typeof encoder, _width: number, _height: number, _fps: number, _duration: number, video: string) => ({
    executable: '/ffmpeg', args: ['-i', video]
  }))
  aiPipeline.runFacePipeline.mockResolvedValue(undefined)
  aiPipeline.jobsRun.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function request(canvas: ExportRequest['canvas'], shortFramePoints?: ExportRequest['shortFramePoints']): ExportRequest {
  return {
    canvas,
    sources: [{
      id: 'source',
      metadata: {
        path: '/input/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 3,
        width: 1920, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: false
      }
    }],
    segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }],
    overlays: [],
    outputPath: '/output/result.mp4',
    ...(shortFramePoints ? { shortFramePoints } : {})
  }
}

describe('AI input crop graph', () => {
  it('feeds only the moving Short crop to AI, independent of pixels outside it', () => {
    const filter = buildFilterGraph(request(
      { width: 1080, height: 1920, fps: 2, fit: 'cover' },
      [{ id: 'start', time: 0, position: 0.25 }, { id: 'end', time: 1, position: 0.75 }]
    ), [])
    const gradient = 'nullsrc=size=1920x1080:rate=2:duration=1.5,geq=lum=16+200*X/W:cb=128:cr=128'
    const decode = (source: string): Buffer => execFileSync(
      join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'), [
        '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', source,
        '-filter_complex', `${filter.graph};[${filter.audioLabel}]anullsink`,
        '-map', `[${filter.videoLabel}]`, '-frames:v', '3', '-an', '-pix_fmt', 'rgb24',
        '-threads', '1', '-f', 'rawvideo', 'pipe:1'
      ], { maxBuffer: 20 * 1024 ** 2 }
    )
    const original = decode(gradient)
    // These margins stay outside every selected crop, including interpolation.
    const changedSides = decode(`${gradient},drawbox=x=0:y=0:w=240:h=ih:color=white:t=fill,drawbox=x=1680:y=0:w=240:h=ih:color=white:t=fill`)
    const frameBytes = 1080 * 1920 * 3
    expect(original.length).toBe(3 * frameBytes)
    expect(original.equals(changedSides)).toBe(true)
    // The luminance ramp also proves left-to-right movement at the three times.
    const middlePixel = (960 * 1080 + 540) * 3
    for (const [frame, expected] of [77, 116, 156].entries()) {
      expect(Math.abs(original.readUInt8(frame * frameBytes + middlePixel) - expected)).toBeLessThan(3)
    }
  })

  it('crops a moving portrait Short before the base video reaches the AI pipeline', () => {
    const filter = buildFilterGraph(request(
      { width: 1080, height: 1920, fps: 30, fit: 'cover' },
      [
        { id: 'start', time: 0, position: 0.6 },
        { id: 'end', time: 1, position: 0.9 }
      ]
    ), [])

    const segment = filter.graph.split(';').find((part) => part.includes('[vseg0]'))
    if (!segment) throw new Error('The timeline segment filter was not emitted')
    expect(segment).toContain('scale=1080:1920:force_original_aspect_ratio=increase')
    expect(segment).toContain("crop=1080:1920:x='(iw-ow)*(if(lt(t,1),0.6+(0.3)*")
    expect(segment.indexOf('scale=')).toBeLessThan(segment.indexOf('crop='))
    expect(filter.graph.indexOf('crop=1080:1920')).toBeLessThan(filter.graph.indexOf('[vseg0]null[basev]'))
    expect(filter.videoLabel).toBe('basev')
  })

  it('uses one cover scale/crop stage for ordinary landscape AI input', () => {
    const filter = buildFilterGraph(request({ width: 3840, height: 2160, fps: 60, fit: 'cover' }), [])

    const segment = filter.graph.split(';').find((part) => part.includes('[vseg0]'))
    if (!segment) throw new Error('The timeline segment filter was not emitted')
    expect(segment).toContain('scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160')
    expect(segment).not.toContain("x='")
    expect(filter.graph.indexOf('crop=3840:2160')).toBeLessThan(filter.graph.indexOf('[vseg0]null[basev]'))
  })

  it('keeps moving crop time global across a transitioned portrait timeline', () => {
    const filter = buildFilterGraph({
      ...request(
        { width: 1080, height: 1920, fps: 30, fit: 'cover' },
        [
          { id: 'start', time: 0, position: 0.6 },
          { id: 'end', time: 2, position: 0.9 }
        ]
      ),
      segments: [
        { id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 1 },
        { id: 'second', sourceId: 'source', sourceStart: 1, sourceEnd: 2, transition: { effect: 'fade', duration: 0.25 } }
      ]
    }, [])

    const segments = filter.graph.split(';').filter((part) => part.includes('[vseg') && part.includes('crop=1080:1920'))
    expect(segments).toHaveLength(2)
    expect(segments[0]).toContain("if(lt(t,2),0.6+(0.3)*")
    expect(segments[0]).not.toContain('(t+1.000000)')
    expect(segments[1]).toContain("if(lt((t+1.000000),2),0.6+(0.3)*")
    expect(filter.graph).toContain("xfade=transition=custom:expr='A*(P*P*(3-2*P))")
  })

  it.each(['turbo', 'base'] as const)('passes the moving portrait crop into the real %s AI pipeline command', async (mode) => {
    const aiRequest = {
      ...request(
        { width: 1080, height: 1920, fps: 30.000845094228005, fit: 'cover' },
        [
          { id: 'start', time: 0, position: 0.6 },
          { id: 'end', time: 1, position: 0.9 }
        ]
      ),
      aiEnhance: { mode }
    }

    await exportVideo(aiRequest)

    const commands = aiPipeline.runFacePipeline.mock.calls[0]?.[0] as { executable: string; args: string[] }[] | undefined
    expect(commands).toHaveLength(3)
    const decoder = commands?.[0]
    const aiWorker = commands?.[1]
    expect(decoder?.executable).toBe('/decoder')
    expect(decoder?.args).toEqual(expect.arrayContaining(['-filter_complex']))
    const graph = decoder?.args[decoder.args.indexOf('-filter_complex') + 1] ?? ''
    expect(graph).toContain("crop=1080:1920:x='(iw-ow)*(if(lt(t,1),0.6+(0.3)*")
    expect(graph.indexOf('crop=1080:1920')).toBeLessThan(graph.indexOf('[vseg0]null[basev]'))
    expect(aiWorker).toMatchObject({ executable: '/ai-worker' })
    expect(aiWorker?.args).toEqual(expect.arrayContaining([
      '--mode', mode, '--width', '1080', '--height', '1920',
      '--output-width', '2160', '--output-height', '3840', '--output-fps', '60'
    ]))
    expect(aiWorker?.args).not.toContain('/input/source.mp4')
  })
})
