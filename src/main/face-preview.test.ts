import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
import type { SessionPathRegistry } from './path-registry'

const mocks = vi.hoisted(() => ({
  exportVideo: vi.fn(), requireFacePack: vi.fn(), symlink: vi.fn(), mkdir: vi.fn(), readdir: vi.fn(),
  rename: vi.fn(), rm: vi.fn(), stat: vi.fn(),
  snapshotFacePreview: vi.fn(), snapshotFacePreviewRange: vi.fn(), invalidateFacePreview: vi.fn(),
  rememberFacePreview: vi.fn(), rememberFacePreviewRange: vi.fn(), loadFacePreviewRange: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => '/app-data' } }))
vi.mock('node:fs/promises', () => ({
  default: mocks,
  symlink: mocks.symlink, mkdir: mocks.mkdir, readdir: mocks.readdir,
  rename: mocks.rename, rm: mocks.rm, stat: mocks.stat
}))
vi.mock('./exporter', () => ({ exportVideo: mocks.exportVideo }))
vi.mock('./face-pack', () => ({ requireFacePack: mocks.requireFacePack }))
vi.mock('./face-preview-cache', () => ({
  snapshotFacePreview: mocks.snapshotFacePreview,
  snapshotFacePreviewRange: mocks.snapshotFacePreviewRange,
  invalidateFacePreview: mocks.invalidateFacePreview,
  rememberFacePreview: mocks.rememberFacePreview,
  rememberFacePreviewRange: mocks.rememberFacePreviewRange,
  loadFacePreviewRange: mocks.loadFacePreviewRange
}))
import { previewFaces } from './face-preview'
import { decodeMediaUrl } from './media-protocol'

const registeredWritePaths = new Set<string>()
const allowWrite = vi.fn((path: string): string => {
  registeredWritePaths.add(path)
  return path
})
const allowRead = vi.fn((path: string): string => path)
const trusted = vi.fn((value: unknown): Promise<ExportRequest> => {
  const sanitized = { ...(value as Record<string, unknown>) }
  if (typeof sanitized.outputPath !== 'string' || !registeredWritePaths.has(sanitized.outputPath)) {
    return Promise.reject(new Error('unregistered output path'))
  }
  delete sanitized.previewRange
  return Promise.resolve(sanitized as unknown as ExportRequest)
})
const paths = {
  allowWrite,
  allowRead
} as unknown as SessionPathRegistry
const request = {
  canvas: { width: 320, height: 180, fps: 30, fit: 'contain' },
  sources: [{ metadata: { path: '/source.mp4' } }],
  segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
  overlays: [], faceBlurs: [{ id: 'face' }], outputPath: '/untrusted/output.mp4'
} as unknown as ExportRequest
const defaultFaceEffect = {
  id: 'face', start: 0, duration: 10, sensitivity: 0.5, detail: 'standard' as const,
  holdSeconds: 0, strength: 0.5, style: 'blur' as const
} satisfies NonNullable<ExportRequest['faceBlurs']>[number]
const timelineRequest = (faceBlurs: ExportRequest['faceBlurs'] = [defaultFaceEffect]): ExportRequest => ({
  canvas: { width: 320, height: 180, fps: 30, fit: 'contain' },
  sources: [{
    id: 'source',
    metadata: {
      path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
      width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true
    }
  }],
  segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
  overlays: [], outputPath: '/untrusted/output.mp4', faceBlurs
})

beforeEach(() => {
  vi.clearAllMocks()
  registeredWritePaths.clear()
  mocks.exportVideo.mockResolvedValue(undefined)
  mocks.requireFacePack.mockResolvedValue(undefined)
  mocks.symlink.mockResolvedValue(undefined)
  mocks.readdir.mockResolvedValue([])
  mocks.rename.mockResolvedValue(undefined)
  mocks.rm.mockResolvedValue(undefined)
  mocks.stat.mockResolvedValue({ isFile: () => true, ino: 1, dev: 1, size: 10, mtimeMs: 1 })
  mocks.snapshotFacePreview.mockResolvedValue('preview-key')
  mocks.snapshotFacePreviewRange.mockResolvedValue('range-preview-key')
  mocks.invalidateFacePreview.mockResolvedValue(undefined)
})

describe('rendered face preview', () => {
  it('validates the request, overrides its destination, and authorizes the completed video', async () => {
    const url = await previewFaces(request, paths, trusted)
    const latest = '/app-data/face-preview/preview.mp4'
    const destination = '/app-data/face-preview/preview-0-300.mp4'
    expect(trusted).toHaveBeenCalledWith({ ...request, outputPath: latest }, paths)
    expect(allowWrite).toHaveBeenNthCalledWith(1, latest)
    expect(allowWrite).toHaveBeenNthCalledWith(2, destination)
    expect(allowWrite).not.toHaveBeenCalledWith(request.outputPath)
    expect(trusted.mock.calls.map(([value]) => (value as { outputPath?: unknown }).outputPath))
      .not.toContain(request.outputPath)
    expect(mocks.exportVideo).toHaveBeenCalledWith({ ...request, outputPath: destination })
    expect(mocks.invalidateFacePreview).toHaveBeenCalledWith(latest)
    expect(mocks.rememberFacePreview).toHaveBeenCalledWith('preview-key', latest, [0, 10])
    expect(allowRead).toHaveBeenCalledWith(destination)
    expect(decodeMediaUrl(url)).toBe(destination)
    expect(url).toContain('?preview=')
  })

  it('fails closed for missing packs and effects, and can retry', async () => {
    mocks.requireFacePack.mockRejectedValueOnce(new Error('Missing pack'))
    await expect(previewFaces(request, paths, trusted)).rejects.toThrow('Missing pack')
    await expect(previewFaces(null, paths, trusted)).rejects.toThrow('Invalid preview')
    await expect(previewFaces({ ...request, faceBlurs: [] }, paths, trusted)).rejects.toThrow('Apply a Blur faces')
    expect(mocks.exportVideo).not.toHaveBeenCalled()
    await expect(previewFaces(request, paths, trusted)).resolves.toContain('media:')
  })

  it.each([
    null,
    [],
    [1],
    [1, 2, 3],
    [-0.001, 2],
    [2, 10.001],
    [Number.NaN, 2]
  ])('rejects an injected preview range %j', async (previewRange) => {
    await expect(previewFaces({ ...timelineRequest(), previewRange }, paths, trusted)).rejects.toThrow(/Preview range/)
    expect(mocks.exportVideo).not.toHaveBeenCalled()
  })

  it('passes a normalized nonzero range from raw input despite trusted export sanitization', async () => {
    const value = { ...timelineRequest(), previewRange: [1.001, 2.001] }
    await previewFaces(value, paths, trusted)
    const destination = '/app-data/face-preview/preview-31-61.mp4'
    expect(mocks.exportVideo).toHaveBeenCalledWith(expect.objectContaining({ outputPath: destination }), [31 / 30, 61 / 30])
    expect(mocks.invalidateFacePreview).toHaveBeenCalledWith('/app-data/face-preview/preview.mp4')
    expect(mocks.symlink).toHaveBeenCalledWith('preview-31-61.mp4', expect.stringMatching(/^\/app-data\/face-preview\/preview\.mp4\..+\.tmp$/))
    expect(mocks.rememberFacePreview).toHaveBeenCalledWith('preview-key', '/app-data/face-preview/preview.mp4', [31 / 30, 61 / 30])
    expect(allowRead).toHaveBeenCalledWith(destination)
  })

  it('uses a distinct deterministic output for each selected frame range', async () => {
    await previewFaces({ ...timelineRequest(), previewRange: [1, 2] }, paths, trusted)
    await previewFaces({ ...timelineRequest(), previewRange: [4, 5] }, paths, trusted)

    expect(mocks.exportVideo.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ outputPath: '/app-data/face-preview/preview-30-60.mp4' }))
    expect(mocks.exportVideo.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ outputPath: '/app-data/face-preview/preview-120-150.mp4' }))
  })

  it('does not remember a selected preview even when no effects overlap the range', async () => {
    const outsideEffect = [{
      id: 'face', start: 7, duration: 1, sensitivity: 0.5, detail: 'standard' as const,
      holdSeconds: 0, strength: 0.5, style: 'blur' as const
    }]
    await previewFaces({ ...timelineRequest(outsideEffect), previewRange: [2, 5] }, paths, trusted)
    expect(mocks.exportVideo).toHaveBeenCalledWith(expect.anything(), [2, 5])
    expect(mocks.rememberFacePreview).not.toHaveBeenCalled()
  })

  it('normalizes an explicitly complete range while keeping its playback file immutable', async () => {
    await previewFaces({ ...timelineRequest(), previewRange: [0, 10] }, paths, trusted)
    expect(mocks.exportVideo).toHaveBeenCalledWith(expect.objectContaining({ outputPath: '/app-data/face-preview/preview-0-300.mp4' }))
    expect(mocks.exportVideo.mock.calls[0]).toHaveLength(1)
    expect(mocks.rememberFacePreview).toHaveBeenCalledWith('preview-key', '/app-data/face-preview/preview.mp4', [0, 10])
  })

  it('does not remember a preview when settings or source identity changes during rendering', async () => {
    const renderRequest = {
      ...request,
      sources: [{ metadata: { path: '/source-before.mp4' } }]
    } as unknown as ExportRequest
    mocks.snapshotFacePreview.mockImplementation((value: ExportRequest) => Promise.resolve(JSON.stringify({
      sources: value.sources, faceBlurs: value.faceBlurs
    })))
    mocks.exportVideo.mockImplementationOnce((value: ExportRequest) => {
      const source = value.sources[0]
      if (source) source.metadata.path = '/source-after.mp4'
      const effect = value.faceBlurs?.[0]
      if (effect) effect.strength = 0.2
    })
    await previewFaces(renderRequest, paths, trusted)
    expect(mocks.invalidateFacePreview).toHaveBeenCalledOnce()
    expect(mocks.rememberFacePreview).not.toHaveBeenCalled()
  })

  it('clears the old cache before a cancelled preview and never remembers partial output', async () => {
    mocks.exportVideo.mockRejectedValueOnce(new Error('Job cancelled'))
    await expect(previewFaces(request, paths, trusted)).rejects.toThrow('Job cancelled')
    expect(mocks.invalidateFacePreview).toHaveBeenCalledOnce()
    expect(mocks.rememberFacePreview).not.toHaveBeenCalled()
  })

  it('rejects concurrent rendering and propagates cancellation without publishing a partial file', async () => {
    let cancel!: (error: Error) => void
    mocks.exportVideo.mockImplementationOnce(() => new Promise((_resolve, reject) => { cancel = reject }))
    const pending = previewFaces(request, paths, trusted)
    await vi.waitFor(() => expect(mocks.exportVideo).toHaveBeenCalled())
    await expect(previewFaces(request, paths, trusted)).rejects.toThrow('already being rendered')
    cancel(new Error('Job cancelled'))
    await expect(pending).rejects.toThrow('Job cancelled')
    expect(allowRead).not.toHaveBeenCalled()
    await expect(previewFaces(request, paths, trusted)).resolves.toContain('media:')
  })

  it('restores all valid persisted ranges after a saved-project-shaped module reload without rendering', async () => {
    const savedRequest = JSON.parse(JSON.stringify(timelineRequest())) as ExportRequest
    mocks.snapshotFacePreviewRange.mockImplementation((_value: ExportRequest, range: readonly [number, number]) =>
      Promise.resolve(`${range[0]}-${range[1]}`))
    mocks.readdir.mockResolvedValue([
      { name: 'preview-31-61.mp4', isFile: () => true },
      { name: 'preview-120-150.mp4', isFile: () => true },
      { name: 'preview-180-210.mp4', isFile: () => true }
    ])
    mocks.stat
      .mockResolvedValueOnce({ isFile: () => true, ino: 3, dev: 1, size: 10, mtimeMs: 3 })
      .mockResolvedValueOnce({ isFile: () => true, ino: 2, dev: 1, size: 10, mtimeMs: 2 })
      .mockResolvedValueOnce({ isFile: () => true, ino: 1, dev: 1, size: 10, mtimeMs: 1 })
    mocks.loadFacePreviewRange
      .mockResolvedValueOnce({
        key: `${31 / 30}-${61 / 30}`, range: [31 / 30, 61 / 30],
        outputStamp: { size: 10, mtimeMs: 3, ctimeMs: 1, ino: 3, dev: 1 }
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        key: `${180 / 30}-${210 / 30}`, range: [180 / 30, 210 / 30],
      outputStamp: { size: 10, mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1 }
      })

    vi.resetModules()
    const fresh = await import('./face-preview')
    const restored = await fresh.restoreFaces(savedRequest, paths, trusted)

    expect(restored).toHaveLength(2)
    expect(restored.map(({ start, end }) => [start, end])).toEqual([
      [31 / 30, 61 / 30], [180 / 30, 210 / 30]
    ])
    expect(mocks.exportVideo).not.toHaveBeenCalled()
    expect(mocks.loadFacePreviewRange).toHaveBeenCalledTimes(3)
    expect(allowRead).toHaveBeenNthCalledWith(1, '/app-data/face-preview/preview-31-61.mp4')
    expect(allowRead).toHaveBeenNthCalledWith(2, '/app-data/face-preview/preview-180-210.mp4')
  })

})
