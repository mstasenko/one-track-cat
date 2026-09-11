import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'

interface FakeHandle {
  write: (value: Buffer, offset: number) => Promise<{ bytesWritten: number }>
  close: () => Promise<void>
}

const mocks = vi.hoisted(() => ({
  userData: '',
  snapshot: vi.fn<(request: ExportRequest) => Promise<string | undefined>>(),
  ffmpegPath: vi.fn<() => string>(),
  open: vi.fn<(path: string, flags: string, mode?: number) => Promise<FakeHandle>>()
}))

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }))
vi.mock('./face-preview-cache', () => ({ snapshotFacePreview: mocks.snapshot }))
vi.mock('./binaries', () => ({ ffmpegPath: mocks.ffmpegPath }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: mocks.open }
})

import { clearFaceDetectionCache, faceDetectionCachePath, prepareFaceDetectionCache } from './face-detection-cache'

let directory: string
let ffmpeg: string
const request = (): ExportRequest => ({
  canvas: { width: 64, height: 64, fps: 30, fit: 'contain' },
  sources: [], segments: [], overlays: [], outputPath: '/tmp/output.mp4',
  faceBlurs: [{ id: 'face', start: 0, duration: 1, sensitivity: 0.7, detail: 'small', holdSeconds: 0, strength: 1, style: 'blur' }]
})

function fastStream(): Readable {
  return new Readable({
    autoDestroy: false,
    read() {
      this.push('RCFACE1 0 0\n')
      this.push(null)
    }
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'otc-detection-stream-'))
  ffmpeg = join(directory, 'ffmpeg')
  await writeFile(ffmpeg, 'trusted ffmpeg')
  mocks.userData = directory
  mocks.snapshot.mockReset()
  mocks.snapshot.mockResolvedValue('stream-key')
  mocks.ffmpegPath.mockReset()
  mocks.ffmpegPath.mockReturnValue(ffmpeg)
  mocks.open.mockReset()
  clearFaceDetectionCache()
})

afterEach(async () => {
  clearFaceDetectionCache()
  await rm(directory, { recursive: true, force: true })
})

describe('face detection cache stream safety', () => {
  it('pauses a fast flowing stderr stream while opening and captures its first row', async () => {
    mocks.open.mockImplementation(async (path) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const chunks: Buffer[] = []
      return {
        write: (value, offset) => {
          chunks.push(value.subarray(offset))
          return Promise.resolve({ bytesWritten: value.length - offset })
        },
        close: async () => { await writeFile(path, Buffer.concat(chunks)) }
      }
    })
    const session = await prepareFaceDetectionCache(request(), 0)
    const stream = fastStream()
    stream.on('data', () => undefined)
    await session.onWorkerStderr?.(stream)
    await session.commit()
    const path = faceDetectionCachePath()
    if (!path) throw new Error('expected a cache path')
    expect(await readFile(path, 'utf8')).toBe('RCFACE1 0 0\n')
    expect(stream.destroyed).toBe(false)
    await session.cleanup()
  })

  it('keeps the worker stream alive when the optional cache writer fails', async () => {
    mocks.open.mockImplementation(() => Promise.resolve({
      write: () => Promise.reject(new Error('ENOSPC')),
      close: () => Promise.resolve()
    }))
    const session = await prepareFaceDetectionCache(request(), 0)
    const stream = fastStream()
    await session.onWorkerStderr?.(stream)
    expect(stream.destroyed).toBe(false)
    await session.commit()
    await session.cleanup()
  })

  it('treats a zero-byte write as a cache failure without spinning', async () => {
    mocks.open.mockImplementation(() => Promise.resolve({
      write: () => Promise.resolve({ bytesWritten: 0 }),
      close: () => Promise.resolve()
    }))
    const session = await prepareFaceDetectionCache(request(), 0)
    const stream = fastStream()
    await session.onWorkerStderr?.(stream)
    expect(stream.destroyed).toBe(false)
    await session.cleanup()
  })
})
