import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, SourceSegment, VideoSegment } from '../types'

type ExecCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: childProcess.execFile,
    default: { ...actual, execFile: childProcess.execFile }
  }
})
vi.mock('./binaries', () => ({ ffprobePath: () => '/ffprobe' }))

import { previewTimelineOffset } from './preview-timing'

function callback(args: unknown[]): ExecCallback {
  return args.at(-1) as ExecCallback
}

function headerJson(rate = '30/1', stream: Record<string, unknown> = {}): string {
  return JSON.stringify({ streams: [{ avg_frame_rate: rate, r_frame_rate: rate, start_time: '0', ...stream }] })
}

function mockHeader(stdout = headerJson()): void {
  childProcess.execFile.mockImplementation((...args: unknown[]) => {
    callback(args)(null, { stdout, stderr: '' })
  })
}

function mockFailure(): void {
  childProcess.execFile.mockImplementation((...args: unknown[]) => {
    callback(args)(new Error('probe failed'), { stdout: '', stderr: '' })
  })
}

function source(id: string, path: string, fps: number): ExportRequest['sources'][number] {
  return {
    id,
    metadata: {
      path, name: id, size: 1, modifiedAt: 1, duration: 20, width: 1920, height: 1080,
      fps, videoCodec: 'h264', hasAudio: false
    }
  }
}

function video(id: string, sourceId: string, sourceStart: number, sourceEnd: number, extras: Partial<VideoSegment> = {}): VideoSegment {
  return { id, sourceId, sourceStart, sourceEnd, ...extras }
}

function freeze(id: string, sourceId: string): SourceSegment {
  return { kind: 'freeze', id, sourceId, sourceTime: 0, duration: 1 }
}

function request(fps: number, segments: SourceSegment[], sources: ExportRequest['sources']): ExportRequest {
  return {
    canvas: { width: 1920, height: 1080, fps, fit: 'contain' },
    sources, segments, overlays: [], outputPath: '/tmp/output.mp4'
  }
}

function basicRequest(fps = 30): ExportRequest {
  return request(fps, [video('prefix', 'source', 0, 1), video('target', 'source', 1, 2)], [source('source', '/video.mp4', fps)])
}

describe('preview timeline timing', () => {
  beforeEach(() => {
    childProcess.execFile.mockReset()
    mockHeader()
  })

  it('matches the real 60000/1001 prefix timing', async () => {
    const fps = 60000 / 1001
    mockHeader(headerJson('60000/1001'))
    const timeline = request(
      fps,
      [video('prefix', 'first', 70, 320.32), video('target', 'second', 0, 1)],
      [source('first', '/first.mp4', fps), source('second', '/second.mp4', fps)]
    )

    await expect(previewTimelineOffset(timeline, 1)).resolves.toBe(250.316733)
    expect(childProcess.execFile).toHaveBeenCalledTimes(2)
    expect(childProcess.execFile.mock.calls[0]?.[0]).toBe('/ffprobe')
    expect(childProcess.execFile.mock.calls[0]?.[1]).toEqual([
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate,start_time',
      '-of', 'json', '/first.mp4'
    ])
    expect(childProcess.execFile.mock.calls[0]?.[2]).toEqual({ maxBuffer: 64 * 1024, timeout: 5000 })
  })

  it('keeps an aligned 30fps prefix at nine seconds', async () => {
    const timeline = request(
      30,
      [video('prefix', 'source', 0, 9), video('target', 'source', 9, 10)],
      [source('source', '/video.mp4', 30)]
    )
    await expect(previewTimelineOffset(timeline, 1)).resolves.toBe(9)
  })

  it('preserves fractional 30fps prefix timing', async () => {
    const timeline = request(
      30,
      [video('prefix', 'source', 1.25, 9), video('target', 'source', 9, 10)],
      [source('source', '/video.mp4', 30)]
    )
    await expect(previewTimelineOffset(timeline, 1)).resolves.toBe(7.733333)
  })

  it('uses rounded cumulative timing for multiple fractional-rate prefixes', async () => {
    const fps = 30000 / 1001
    mockHeader(headerJson('30000/1001'))
    const timeline = request(
      fps,
      [
        video('first', 'first', 0, 1),
        video('second', 'second', 1, 2),
        video('target', 'third', 2, 3)
      ],
      [source('first', '/first.mp4', fps), source('second', '/second.mp4', fps), source('third', '/third.mp4', fps)]
    )
    await expect(previewTimelineOffset(timeline, 2)).resolves.toBe(2.002)
  })

  it('probes a shared source path only once', async () => {
    const timeline = request(
      30,
      [video('first', 'first', 0, 1), video('second', 'second', 1, 2), video('target', 'second', 2, 3)],
      [source('first', '/shared.mp4', 30), source('second', '/shared.mp4', 30)]
    )
    await expect(previewTimelineOffset(timeline, 2)).resolves.toBe(2)
    expect(childProcess.execFile).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['malformed JSON', '{not-json'],
    ['missing start_time', JSON.stringify({ streams: [{ avg_frame_rate: '30/1', r_frame_rate: '30/1' }] })],
    ['rate mismatch', headerJson('29/1')],
    ['multiple streams', JSON.stringify({ streams: [{ start_time: '0' }, { start_time: '0' }] })]
  ])('falls back for %s metadata', async (_name, stdout) => {
    mockHeader(stdout)
    await expect(previewTimelineOffset(basicRequest(), 1)).resolves.toBeUndefined()
  })

  it('falls back when ffprobe fails', async () => {
    mockFailure()
    await expect(previewTimelineOffset(basicRequest(), 1)).resolves.toBeUndefined()
  })

  it.each([-1, 0, 2, 1.5])('rejects invalid index %s', async (index) => {
    await expect(previewTimelineOffset(basicRequest(), index)).resolves.toBeUndefined()
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })

  it('rejects a prefix with fewer than two frames', async () => {
    const timeline = request(30, [video('prefix', 'source', 0, 0.01), video('target', 'source', 0.01, 1)], [source('source', '/video.mp4', 30)])
    await expect(previewTimelineOffset(timeline, 1)).resolves.toBeUndefined()
  })

  it.each([
    ['a freeze segment', [freeze('freeze', 'source'), video('target', 'source', 0, 1)] as SourceSegment[], [source('source', '/video.mp4', 30)]],
    ['a non-normal playback rate', [video('prefix', 'source', 0, 1, { playbackRate: 2 }), video('target', 'source', 1, 2)] as SourceSegment[], [source('source', '/video.mp4', 30)]],
    ['a missing source', [video('prefix', 'missing', 0, 1), video('target', 'missing', 1, 2)] as SourceSegment[], []]
  ])('rejects %s before probing', async (_name, segments, sources) => {
    await expect(previewTimelineOffset(request(30, segments, sources), 1)).resolves.toBeUndefined()
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })

  it('rejects source metadata with a nonmatching fps', async () => {
    const timeline = request(30, [video('prefix', 'source', 0, 1), video('target', 'source', 1, 2)], [source('source', '/video.mp4', 29.97)])
    await expect(previewTimelineOffset(timeline, 1)).resolves.toBeUndefined()
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })

  it('does not mutate the request or source metadata', async () => {
    const timeline = basicRequest()
    const before = structuredClone(timeline)
    await previewTimelineOffset(timeline, 1)
    expect(timeline).toEqual(before)
  })
})
