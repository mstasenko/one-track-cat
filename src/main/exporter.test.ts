import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'

const fsPromiseMock = vi.hoisted(() => ({ statfs: vi.fn(), stat: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const replacement = { ...actual, statfs: fsPromiseMock.statfs, stat: fsPromiseMock.stat }
  return { ...replacement, default: replacement }
})

import { ensureFaceExportDiskSpace, estimatedExportBytes, estimatedFlashScratchBytes } from './export-space'

const request = {
  outputPath: '/output/export.mp4',
  segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }]
} as ExportRequest

describe('face export disk-space guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reserves additional space for Upscaling intermediates', () => {
    const ordinary = estimatedExportBytes(request)
    const enhanced = estimatedExportBytes({ ...request, upscale: {} })

    expect(enhanced).toBeGreaterThan(ordinary)
  })

  it('requires one conservative estimate on each different filesystem', async () => {
    const estimated = estimatedExportBytes(request)
    fsPromiseMock.statfs
      .mockResolvedValueOnce({ bavail: estimated, bsize: 1 })
      .mockResolvedValueOnce({ bavail: estimated, bsize: 1 })
    fsPromiseMock.stat
      .mockResolvedValueOnce({ dev: 1 })
      .mockResolvedValueOnce({ dev: 2 })

    await expect(ensureFaceExportDiskSpace(request, '/temporary/face')).resolves.toBeUndefined()
  })

  it('requires both encoded intermediates and final output when files share a filesystem', async () => {
    const estimated = estimatedExportBytes(request)
    fsPromiseMock.statfs
      .mockResolvedValueOnce({ bavail: estimated * 1.5, bsize: 1 })
      .mockResolvedValueOnce({ bavail: estimated * 1.5, bsize: 1 })
    fsPromiseMock.stat
      .mockResolvedValueOnce({ dev: 7 })
      .mockResolvedValueOnce({ dev: 7 })

    await expect(ensureFaceExportDiskSpace(request, '/temporary/face'))
      .rejects.toThrow('Not enough free disk space for GPU/face processing')
  })

  it('rejects a temporary filesystem that cannot hold the encoded intermediates', async () => {
    const estimated = estimatedExportBytes(request)
    fsPromiseMock.statfs
      .mockResolvedValueOnce({ bavail: estimated * 2, bsize: 1 })
      .mockResolvedValueOnce({ bavail: estimated / 2, bsize: 1 })
    fsPromiseMock.stat
      .mockResolvedValueOnce({ dev: 1 })
      .mockResolvedValueOnce({ dev: 2 })

    await expect(ensureFaceExportDiskSpace(request, '/temporary/face'))
      .rejects.toThrow('Not enough free disk space for GPU/face processing')
  })

  it('accepts the doubled estimate on one shared filesystem', async () => {
    const estimated = estimatedExportBytes(request)
    fsPromiseMock.statfs
      .mockResolvedValueOnce({ bavail: estimated * 2, bsize: 1 })
      .mockResolvedValueOnce({ bavail: estimated * 2, bsize: 1 })
    fsPromiseMock.stat
      .mockResolvedValueOnce({ dev: 7 })
      .mockResolvedValueOnce({ dev: 7 })

    await expect(ensureFaceExportDiskSpace(request, '/temporary/face')).resolves.toBeUndefined()
  })
})

describe('Upscale scratch-space guard', () => {
  const spatial: ExportRequest = {
    ...request,
    canvas: { width: 1280, height: 720, fps: 30, fit: 'contain' },
    sources: [],
    upscale: { mode: 'turbo' }
  }

  beforeEach(() => vi.clearAllMocks())

  it('reserves every Turbo/Base history layer plus the native free-space floor', () => {
    expect(estimatedFlashScratchBytes(spatial)).toBe(33_223_081_984)
    expect(estimatedFlashScratchBytes({ ...spatial, upscale: { mode: 'base' } })).toBe(53_277_097_984)
  })

  it('does not reserve Flash history for RIFE-only or single-call ranges', () => {
    expect(estimatedFlashScratchBytes({ ...spatial, canvas: { ...spatial.canvas, width: 3840, height: 2160 } })).toBe(0)
    const single = { ...spatial, segments: [{ id: 'short', sourceId: 'source', sourceStart: 0, sourceEnd: 13 / 30 }] }
    expect(estimatedFlashScratchBytes(single)).toBe(0)
    expect(estimatedFlashScratchBytes({ ...single, segments: [{ id: 'short', sourceId: 'source', sourceStart: 0, sourceEnd: 14 / 30 }] })).toBeGreaterThan(0)
  })

  it('reports low scratch space before starting workers', async () => {
    fsPromiseMock.statfs.mockResolvedValue({ bavail: 11 * 1024 ** 3, bsize: 1 })
    fsPromiseMock.stat.mockResolvedValue({ dev: 7 })
    await expect(ensureFaceExportDiskSpace(spatial, '/output/.otc-export-test'))
      .rejects.toThrow(/Not enough free disk space for Upscale.*11.0 GB available.*another drive/)
  })

  it('accepts space for history, intermediate and final output', async () => {
    const required = estimatedExportBytes(spatial) * 2 + estimatedFlashScratchBytes(spatial)
    fsPromiseMock.statfs.mockResolvedValue({ bavail: required, bsize: 1 })
    fsPromiseMock.stat.mockResolvedValue({ dev: 7 })
    await expect(ensureFaceExportDiskSpace(spatial, '/output/.otc-export-test')).resolves.toBeUndefined()
  })
})
