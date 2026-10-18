import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userData: '',
  previewRendering: false,
  activeFaceExports: false,
  activeJobs: false,
  clearFacePreview: vi.fn(),
  clearFaceDetectionCache: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }))
vi.mock('./face-preview-cache', () => ({ clearFacePreview: mocks.clearFacePreview }))
vi.mock('./face-detection-cache', () => ({ clearFaceDetectionCache: mocks.clearFaceDetectionCache }))
vi.mock('./face-preview', () => ({ isFacePreviewRendering: () => mocks.previewRendering }))
vi.mock('./face-process', () => ({ hasActiveFaceExports: () => mocks.activeFaceExports }))
vi.mock('./jobs', () => ({ hasActiveJobs: () => mocks.activeJobs }))

import { clearFaceCache } from './face-cache-cleanup'

let directory: string
let cacheDirectory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'otc-face-cache-cleanup-'))
  cacheDirectory = join(directory, 'face-preview')
  await mkdir(cacheDirectory)
  mocks.userData = directory
  mocks.previewRendering = false
  mocks.activeFaceExports = false
  mocks.activeJobs = false
  mocks.clearFacePreview.mockClear()
  mocks.clearFaceDetectionCache.mockClear()
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('face cache cleanup', () => {
  it('clears all known preview/detection files and keeps unrelated files', async () => {
    const known = [
      'preview.mp4', 'preview.json', 'preview-0-300.mp4', 'preview-0-300.json',
      'preview-any-range.mp4', 'preview-any-range.json', 'detections.cache', 'detections.cache.json'
    ]
    const preserved = ['source.mp4', 'project.json', 'preview.mp4.tmp', 'detections.cache.tmp']
    for (const name of [...known, ...preserved]) await writeFile(join(cacheDirectory, name), name)

    await clearFaceCache()

    for (const name of known) await expect(readFile(join(cacheDirectory, name))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const name of preserved) await expect(readFile(join(cacheDirectory, name), 'utf8')).resolves.toBe(name)
    expect(mocks.clearFacePreview).toHaveBeenCalledOnce()
    expect(mocks.clearFaceDetectionCache).toHaveBeenCalledOnce()
  })

  it('does not traverse a symlinked cache directory', async () => {
    const target = join(directory, 'outside-face-preview')
    await mkdir(target)
    await writeFile(join(target, 'preview.mp4'), 'keep')
    await rm(cacheDirectory, { recursive: true, force: true })
    await symlink(target, cacheDirectory)

    await clearFaceCache()

    await expect(readFile(join(target, 'preview.mp4'), 'utf8')).resolves.toBe('keep')
    expect((await lstat(cacheDirectory)).isSymbolicLink()).toBe(true)
  })

  it.each([
    ['a face preview', 'previewRendering'],
    ['a face export', 'activeFaceExports']
  ] as const)('preserves files and active work during %s', async (_label, activeFlag) => {
    await writeFile(join(cacheDirectory, 'preview.mp4'), 'keep')
    mocks[activeFlag] = true

    await clearFaceCache()

    await expect(readFile(join(cacheDirectory, 'preview.mp4'), 'utf8')).resolves.toBe('keep')
    expect(mocks.clearFacePreview).not.toHaveBeenCalled()
    expect(mocks.clearFaceDetectionCache).not.toHaveBeenCalled()
  })

  it('preserves files during a final export remux job', async () => {
    await writeFile(join(cacheDirectory, 'preview.mp4'), 'keep')
    mocks.activeJobs = true

    await clearFaceCache()

    await expect(readFile(join(cacheDirectory, 'preview.mp4'), 'utf8')).resolves.toBe('keep')
    expect(mocks.clearFacePreview).not.toHaveBeenCalled()
    expect(mocks.clearFaceDetectionCache).not.toHaveBeenCalled()
  })

  it('is harmless when the cache directory does not exist', async () => {
    await rm(cacheDirectory, { recursive: true, force: true })

    await expect(clearFaceCache()).resolves.toBeUndefined()
    expect(mocks.clearFacePreview).toHaveBeenCalledOnce()
    expect(mocks.clearFaceDetectionCache).toHaveBeenCalledOnce()
  })
})
