import { Readable } from 'node:stream'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'

const mocks = vi.hoisted(() => ({
  userData: '',
  throwPath: false,
  snapshot: vi.fn<(request: ExportRequest) => Promise<string | undefined>>(),
  ffmpegPath: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => {
    if (mocks.throwPath) throw new Error('app is not ready')
    return mocks.userData
  } }
}))
vi.mock('./face-preview-cache', () => ({ snapshotFacePreview: mocks.snapshot }))
vi.mock('./binaries', () => ({ ffmpegPath: mocks.ffmpegPath }))

import {
  clearFaceDetectionCache,
  detectionCacheMaximumBytes,
  faceDetectionCachePath,
  prepareFaceDetectionCache
} from './face-detection-cache'

let directory: string
let ffmpeg: string
const request = (): ExportRequest => ({
  canvas: { width: 64, height: 64, fps: 30, fit: 'contain' },
  sources: [], segments: [], overlays: [], outputPath: '/tmp/output.mp4',
  faceBlurs: [{ id: 'face', start: 0, duration: 1, sensitivity: 0.7, detail: 'small', holdSeconds: 0.4, strength: 0.8, style: 'mask' }]
})

const metadataPath = (): string => join(directory, 'face-preview', 'detections.cache.json')

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'otc-detection-cache-'))
  ffmpeg = join(directory, 'ffmpeg')
  await writeFile(ffmpeg, 'trusted ffmpeg')
  mocks.userData = directory
  mocks.throwPath = false
  mocks.snapshot.mockReset()
  mocks.snapshot.mockResolvedValue('stable-request-key')
  mocks.ffmpegPath.mockReset()
  mocks.ffmpegPath.mockReturnValue(ffmpeg)
  clearFaceDetectionCache()
})

afterEach(async () => {
  clearFaceDetectionCache()
  await rm(directory, { recursive: true, force: true })
})

describe('face detection cache sessions', () => {
  it('skips inference authorization only when cached frames cover every active effect', async () => {
    const source = request()
    source.faceBlurs = source.faceBlurs?.map((effect) => ({ ...effect, start: 10, duration: 0.1 }))
    const first = await prepareFaceDetectionCache(source, 300)
    expect(first.hasCompleteDetections).not.toBe(true)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 300 0\nRCFACE1 301 0\nRCFACE1 302 0\n']))
    await first.commit()
    await first.cleanup()
    const fullExport = await prepareFaceDetectionCache(source, 0)
    expect(fullExport.hasCompleteDetections).toBe(true)
    await fullExport.cleanup()
  })

  it('does not treat a gap in cached frames as complete coverage', async () => {
    const source = request()
    source.faceBlurs = source.faceBlurs?.map((effect) => ({ ...effect, duration: 0.1 }))
    const first = await prepareFaceDetectionCache(source, 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\nRCFACE1 2 0\n']))
    await first.commit()
    await first.cleanup()
    const next = await prepareFaceDetectionCache(source, 0)
    expect(next.hasCompleteDetections).not.toBe(true)
    await next.cleanup()
  })

  it.each([
    'RCFACE1 0 0\nRCFACE1 0 0\nRCFACE1 1 0\nRCFACE1 2 0\n',
    'RCFACE1 0 1\nRCFACE1 1 0\nRCFACE1 2 0\n',
    'RCFACE1 -1 0\nRCFACE1 0 0\nRCFACE1 1 0\nRCFACE1 2 0\n'
  ])('keeps authorization available when emitted coverage is malformed (%#)', async (rows) => {
    const source = request()
    source.faceBlurs = source.faceBlurs?.map((effect) => ({ ...effect, duration: 0.1 }))
    const first = await prepareFaceDetectionCache(source, 0)
    await first.onWorkerStderr?.(Readable.from([rows]))
    await first.commit()
    await first.cleanup()
    const next = await prepareFaceDetectionCache(source, 0)
    expect(next.hasCompleteDetections).toBe(false)
    await next.cleanup()
  })

  it('covers fractional frame boundaries but not a new uncached effect', async () => {
    const source = request()
    source.canvas.fps = 60000 / 1001
    source.faceBlurs = source.faceBlurs?.map((effect) => ({ ...effect, start: 298.36025830632093, duration: 20 }))
    const first = await prepareFaceDetectionCache(source, 17884)
    const rows = Array.from({ length: 1199 }, (_, index) => `RCFACE1 ${17884 + index} 0\n`).join('')
    await first.onWorkerStderr?.(Readable.from([rows]))
    await first.commit()
    await first.cleanup()
    const next = await prepareFaceDetectionCache(source, 0)
    expect(next.hasCompleteDetections).toBe(true)
    await next.cleanup()
    const effect = source.faceBlurs?.[0]
    if (!effect) throw new Error('Expected a face effect')
    source.faceBlurs?.push({ ...effect, id: 'new', start: 0, duration: 1 })
    const extended = await prepareFaceDetectionCache(source, 0)
    expect(extended.hasCompleteDetections).toBe(false)
    await extended.cleanup()
  })

  it('captures only native rows, publishes atomically, and reuses a frozen input copy', async () => {
    const session = await prepareFaceDetectionCache(request(), 12)
    expect(session.workerArgs).toEqual(['--emit-detections', '--frame-offset', '12'])
    expect(session.onWorkerStderr).toBeDefined()
    await session.onWorkerStderr?.(Readable.from(['worker diagnostic\nRCFACE1 12 0\n', 'RCFACE1 13 1 1 2 3 4 0.5\n']))
    await session.commit()
    const path = faceDetectionCachePath()
    if (!path) throw new Error('expected a cache path')
    expect(await readFile(path, 'utf8')).toBe('RCFACE1 12 0\nRCFACE1 13 1 1 2 3 4 0.5\n')

    const next = await prepareFaceDetectionCache(request(), 0)
    expect(next.workerArgs[0]).toBe('--detections-cache')
    const inputPath = next.workerArgs[1]
    if (!inputPath) throw new Error('expected a copied cache path')
    expect(inputPath).not.toBe(path)
    expect(await readFile(inputPath, 'utf8')).toContain('RCFACE1 13')
    await next.cleanup()
  })

  it('reloads a persisted cache record after process memory is cleared', async () => {
    const first = await prepareFaceDetectionCache(request(), 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await first.commit()
    await first.cleanup()
    const metadata = JSON.parse(await readFile(metadataPath(), 'utf8')) as Record<string, unknown>
    expect(metadata.version).toBe(1)
    expect(metadata.baseKey).toMatch(/^[0-9a-f]{64}$/)
    expect(metadata.frameRanges).toEqual([[0, 1]])
    clearFaceDetectionCache()

    const second = await prepareFaceDetectionCache(request(), 0)
    expect(second.workerArgs[0]).toBe('--detections-cache')
    await second.cleanup()
  })

  it('rejects malformed, oversized, and version-mismatched sidecars', async () => {
    const first = await prepareFaceDetectionCache(request(), 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await first.commit()
    await first.cleanup()
    clearFaceDetectionCache()

    await writeFile(metadataPath(), '{not-json')
    const malformed = await prepareFaceDetectionCache(request(), 0)
    expect(malformed.workerArgs[0]).toBe('--emit-detections')
    await malformed.cleanup()

    const second = await prepareFaceDetectionCache(request(), 0)
    await second.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await second.commit()
    await second.cleanup()
    clearFaceDetectionCache()
    const version = JSON.parse(await readFile(metadataPath(), 'utf8')) as Record<string, unknown>
    version.version = 2
    await writeFile(metadataPath(), JSON.stringify(version))
    const mismatched = await prepareFaceDetectionCache(request(), 0)
    expect(mismatched.workerArgs[0]).toBe('--emit-detections')
    await mismatched.cleanup()

    const third = await prepareFaceDetectionCache(request(), 0)
    await third.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await third.commit()
    await third.cleanup()
    clearFaceDetectionCache()
    await writeFile(metadataPath(), 'x'.repeat(64 * 1024 + 1))
    const oversized = await prepareFaceDetectionCache(request(), 0)
    expect(oversized.workerArgs[0]).toBe('--emit-detections')
    await oversized.cleanup()
  })

  it.each([
    { label: 'cache stamp', mutate: (record: { stamp: { size: number } }) => { record.stamp.size += 1 } },
    {
      label: 'policy',
      mutate: (record: { policies: { sensitivity: number }[] }) => {
        const policy = record.policies[0]
        if (!policy) throw new Error('expected persisted policy')
        policy.sensitivity = 0.6
      }
    }
  ])('rejects a persisted record with a changed $label', async ({ mutate }) => {
    const first = await prepareFaceDetectionCache(request(), 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await first.commit()
    await first.cleanup()
    clearFaceDetectionCache()
    const record = JSON.parse(await readFile(metadataPath(), 'utf8')) as { stamp: { size: number }; policies: { sensitivity: number }[] }
    mutate(record)
    await writeFile(metadataPath(), JSON.stringify(record))

    const second = await prepareFaceDetectionCache(request(), 0)
    expect(second.workerArgs[0]).toBe('--emit-detections')
    await second.cleanup()
  })

  it('does not advertise a cache when metadata publication fails', async () => {
    await mkdir(join(directory, 'face-preview'), { recursive: true })
    await mkdir(metadataPath())
    const first = await prepareFaceDetectionCache(request(), 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await first.commit()
    await first.cleanup()
    clearFaceDetectionCache()

    const second = await prepareFaceDetectionCache(request(), 0)
    expect(second.workerArgs[0]).toBe('--emit-detections')
    await second.cleanup()
  })

  it('uses a fixed valid face effect for the base identity', async () => {
    await (await prepareFaceDetectionCache(request(), 0)).cleanup()
    const normalized = mocks.snapshot.mock.calls[0]?.[0]
    const effect = normalized?.faceBlurs?.[0]
    expect(effect).toEqual({
      id: 'cache-identity', start: 0, duration: 0.0001, sensitivity: 0.5, detail: 'standard',
      holdSeconds: 0, strength: 0, style: 'blur'
    })
    expect(normalized?.outputPath).toBe('/tmp/output.mp4')
  })

  it('reuses detector rows when a UI replacement changes only effect identity and rendering fields', async () => {
    mocks.snapshot.mockImplementation((value) => Promise.resolve(JSON.stringify(value)))
    const first = await prepareFaceDetectionCache(request(), 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await first.commit()
    await first.cleanup()
    const changed = request()
    const effect = changed.faceBlurs?.[0]
    if (!effect) throw new Error('expected a face effect')
    changed.faceBlurs = [{ ...effect, id: 'replacement', holdSeconds: 0.8, strength: 0.2, style: 'mask' }]
    const second = await prepareFaceDetectionCache(changed, 0)
    expect(second.workerArgs[0]).toBe('--detections-cache')
    await second.cleanup()
  })

  it('reuses a whole cache when a disjoint detection range is added', async () => {
    mocks.snapshot.mockImplementation((value) => Promise.resolve(JSON.stringify(value)))
    const first = await prepareFaceDetectionCache(request(), 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await first.commit()
    await first.cleanup()

    const extended = request()
    const effect = extended.faceBlurs?.[0]
    if (!effect) throw new Error('expected a face effect')
    extended.faceBlurs = [effect, { ...effect, id: 'new', start: 2, duration: 1 }]
    const second = await prepareFaceDetectionCache(extended, 0)
    expect(second.workerArgs[0]).toBe('--detections-cache')
    await second.cleanup()
  })

  it.each([
    { label: 'sensitivity', change: { sensitivity: 0.6 } },
    { label: 'detail', change: { detail: 'standard' as const } }
  ])('rejects cached rows when face detection $label changes', async ({ change }) => {
    mocks.snapshot.mockImplementation((value) => Promise.resolve(JSON.stringify(value)))
    const first = await prepareFaceDetectionCache(request(), 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await first.commit()
    await first.cleanup()

    const changed = request()
    const effect = changed.faceBlurs?.[0]
    if (!effect) throw new Error('expected a face effect')
    changed.faceBlurs = [{ ...effect, ...change }]
    const second = await prepareFaceDetectionCache(changed, 0)
    expect(second.workerArgs[0]).toBe('--emit-detections')
    await second.cleanup()
  })

  it('does not open a detection cache when the face range is removed', async () => {
    mocks.snapshot.mockImplementation((value) => Promise.resolve(JSON.stringify(value)))
    const first = await prepareFaceDetectionCache(request(), 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await first.commit()
    await first.cleanup()

    const changed = request()
    changed.faceBlurs = []
    const second = await prepareFaceDetectionCache(changed, 0)
    expect(second.workerArgs).toEqual([])
    await second.cleanup()
  })

  it('rejects cached rows when the face range is moved', async () => {
    mocks.snapshot.mockImplementation((value) => Promise.resolve(JSON.stringify(value)))
    const first = await prepareFaceDetectionCache(request(), 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await first.commit()
    await first.cleanup()

    const changed = request()
    const effect = changed.faceBlurs?.[0]
    if (!effect) throw new Error('expected a face effect')
    changed.faceBlurs = [{ ...effect, start: 2 }]
    const second = await prepareFaceDetectionCache(changed, 0)
    expect(second.workerArgs[0]).toBe('--emit-detections')
    await second.cleanup()
  })

  it('rejects cached rows when the source input changes', async () => {
    mocks.snapshot.mockImplementation((value) => Promise.resolve(JSON.stringify(value)))
    const first = await prepareFaceDetectionCache(request(), 0)
    await first.onWorkerStderr?.(Readable.from(['RCFACE1 0 0\n']))
    await first.commit()
    await first.cleanup()

    const changed = request()
    changed.sources = [{
      id: 'source',
      metadata: {
        path: '/media/changed.mp4', name: 'changed.mp4', size: 1, modifiedAt: 1, duration: 1,
        width: 64, height: 64, fps: 30, videoCodec: 'h264', hasAudio: false
      }
    }]
    const second = await prepareFaceDetectionCache(changed, 0)
    expect(second.workerArgs[0]).toBe('--emit-detections')
    await second.cleanup()
  })

  it('accepts an unterminated final native row and rejects a changed source fingerprint', async () => {
    const session = await prepareFaceDetectionCache(request(), 0)
    await session.onWorkerStderr?.(Readable.from(['RCFACE1 0 0']))
    mocks.snapshot.mockResolvedValue('changed-request-key')
    await session.commit()
    const path = faceDetectionCachePath()
    if (!path) throw new Error('expected a cache path')
    await expect(stat(path)).rejects.toThrow()
    await session.cleanup()
  })

  it('discards an oversized diagnostic row but continues as an optional cache miss', async () => {
    const session = await prepareFaceDetectionCache(request(), 0)
    const line = `RCFACE1 ${'x'.repeat(64 * 1024)}\n`
    await session.onWorkerStderr?.(Readable.from([line]))
    await session.commit()
    const path = faceDetectionCachePath()
    if (!path) throw new Error('expected a cache path')
    await expect(stat(path)).rejects.toThrow()
    expect(detectionCacheMaximumBytes).toBe(64 * 1024 * 1024)
  })

  it('becomes a no-op when Electron userData is unavailable', async () => {
    mocks.throwPath = true
    const session = await prepareFaceDetectionCache(request(), 0)
    expect(faceDetectionCachePath()).toBeUndefined()
    expect(session.workerArgs).toEqual([])
    await session.commit()
    await session.cleanup()
  })

  it('does not pass an unsafe frame offset to the native worker', async () => {
    const session = await prepareFaceDetectionCache(request(), Number.MAX_SAFE_INTEGER + 1)
    expect(session.workerArgs).toEqual([])
    await session.cleanup()
  })
})
