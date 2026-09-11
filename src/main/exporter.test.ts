import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'

const fsPromiseMock = vi.hoisted(() => ({ statfs: vi.fn(), stat: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const replacement = { ...actual, statfs: fsPromiseMock.statfs, stat: fsPromiseMock.stat }
  return { ...replacement, default: replacement }
})

import { ensureFaceExportDiskSpace, estimatedExportBytes } from './exporter'

const request = {
  outputPath: '/output/export.mp4',
  segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }]
} as ExportRequest

describe('face export disk-space guard', () => {
  beforeEach(() => vi.clearAllMocks())

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
