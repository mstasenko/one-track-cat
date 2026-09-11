import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'

const mocks = vi.hoisted(() => ({ requireFacePack: vi.fn(), jobsRun: vi.fn(), userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }))
vi.mock('./face-pack', () => ({ requireFacePack: mocks.requireFacePack }))
vi.mock('./binaries', () => ({ ffmpegPath: () => '/mock/ffmpeg' }))
vi.mock('./jobs', () => ({ jobs: { run: mocks.jobsRun } }))

import {
  clearFacePreview,
  loadFacePreview,
  rememberFacePreview,
  rememberFacePreviewRange,
  snapshotFacePreview,
  snapshotFacePreviewRange,
  tryReuseFacePreview
} from './face-preview-cache'

let directory: string
let source: string
let overlay: string
let preview: string
let request: ExportRequest

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'otc-face-preview-cache-'))
  mocks.userData = directory
  source = join(directory, 'source.mp4')
  overlay = join(directory, 'overlay.png')
  preview = join(directory, 'preview.mp4')
  for (const path of [source, overlay, preview]) await writeFile(path, `${path}\n`)
  const pack = {
    executable: join(directory, 'otc-face-blur'),
    model: join(directory, 'model.xml')
  }
  await writeFile(join(directory, 'manifest.json'), '{"format":1}')
  await writeFile(pack.model, 'model')
  await writeFile(join(directory, 'model.bin'), 'weights')
  await writeFile(pack.executable, 'launcher')
  await writeFile(join(directory, 'otc-face-blur.bin'), 'worker')
  mocks.requireFacePack.mockResolvedValue(pack)
  mocks.jobsRun.mockResolvedValue(undefined)
  mocks.jobsRun.mockClear()
  request = {
    canvas: { width: 64, height: 64, fps: 30, fit: 'contain' },
    sources: [{ metadata: { path: source } }],
    segments: [],
    overlays: [{ type: 'image', path: overlay }],
    outputPath: join(directory, 'destination.mp4'),
    faceBlurs: [{ id: 'face', start: 0, duration: 1, sensitivity: 0.7, detail: 'small', holdSeconds: 0, strength: 1, style: 'blur' }]
  } as unknown as ExportRequest
  clearFacePreview()
})

afterEach(async () => {
  clearFacePreview()
  await rm(directory, { recursive: true, force: true })
})

describe('completed face preview cache', () => {
  it('persists a bounded stamped range and reloads it after a module reset', async () => {
    const output = join(directory, 'face-preview', 'preview.mp4')
    await mkdir(join(directory, 'face-preview'), { recursive: true })
    await writeFile(output, 'rendered-preview')
    const key = await snapshotFacePreview(request)
    if (!key) throw new Error('expected a preview key')
    await rememberFacePreview(key, output, [1, 2])
    const sidecar = JSON.parse(await readFile(join(directory, 'face-preview', 'preview.json'), 'utf8')) as Record<string, unknown>
    expect(sidecar.version).toBe(1)
    expect(sidecar.key).toBe(key)
    expect(sidecar.range).toEqual([1, 2])
    expect(sidecar.encodingPolicy).toBe(2)
    clearFacePreview()

    vi.resetModules()
    const freshCache = await import('./face-preview-cache')
    await expect(freshCache.loadFacePreview(key, output)).resolves.toEqual(expect.objectContaining({
      key, range: [1, 2], encodingPolicy: 2
    }))
  })

  it('persists a range sidecar stamped against its immutable file and ignores disjoint effects', async () => {
    const output = join(directory, 'face-preview', 'preview-0-30.mp4')
    await mkdir(join(directory, 'face-preview'), { recursive: true })
    await writeFile(output, 'range-preview')
    const fullRequest = {
      ...request,
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
      faceBlurs: [
        request.faceBlurs?.[0],
        { ...request.faceBlurs?.[0], id: 'disjoint', start: 6, duration: 1 }
      ]
    } as ExportRequest
    const firstOnly = { ...fullRequest, faceBlurs: [fullRequest.faceBlurs?.[0]] } as ExportRequest
    const key = await snapshotFacePreviewRange(firstOnly, [0, 1])
    const disjointKey = await snapshotFacePreviewRange(fullRequest, [0, 1])
    if (!key || !disjointKey) throw new Error('expected range preview keys')
    expect(disjointKey).toBe(key)
    await rememberFacePreviewRange(key, output, [0, 1])

    vi.resetModules()
    const freshCache = await import('./face-preview-cache')
    await expect(freshCache.loadFacePreviewRange(key, output)).resolves.toEqual(expect.objectContaining({
      key, range: [0, 1], encodingPolicy: 2
    }))
  })

  it('reuses a current-policy persisted preview after a module reset', async () => {
    const output = join(directory, 'face-preview', 'preview.mp4')
    await mkdir(join(directory, 'face-preview'), { recursive: true })
    await writeFile(output, 'rendered-preview')
    const fullRequest = {
      ...request,
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }]
    } as ExportRequest
    const key = await snapshotFacePreview(fullRequest)
    if (!key) throw new Error('expected a preview key')
    await rememberFacePreview(key, output, [0, 10])
    clearFacePreview()

    vi.resetModules()
    const freshCache = await import('./face-preview-cache')
    mocks.requireFacePack.mockClear()
    await expect(freshCache.tryReuseFacePreview(fullRequest, join(directory, 'output.mp4'), 'current-policy', 10)).resolves.toBe(true)
    expect(mocks.requireFacePack).toHaveBeenCalledTimes(2)
    expect(mocks.jobsRun).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 1] as const)('loads an old persisted preview for restore but does not reuse it for export (%s)', async (legacyPolicy) => {
    const output = join(directory, 'face-preview', 'preview.mp4')
    const metadata = join(directory, 'face-preview', 'preview.json')
    await mkdir(join(directory, 'face-preview'), { recursive: true })
    await writeFile(output, 'legacy-preview')
    const fullRequest = {
      ...request,
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }]
    } as ExportRequest
    const key = await snapshotFacePreview(fullRequest)
    if (!key) throw new Error('expected a preview key')
    await rememberFacePreview(key, output, [0, 10])
    const legacyRecord = JSON.parse(await readFile(metadata, 'utf8')) as Record<string, unknown>
    legacyRecord.encodingPolicy = legacyPolicy
    await writeFile(metadata, JSON.stringify(legacyRecord))
    clearFacePreview()

    const restored = await loadFacePreview(key, output)
    expect(restored).toEqual(expect.objectContaining({ key, range: [0, 10] }))
    expect(restored?.encodingPolicy).toBe(legacyPolicy)
    await expect(tryReuseFacePreview(fullRequest, join(directory, 'output.mp4'), 'legacy-policy', 10)).resolves.toBe(false)
    expect(mocks.jobsRun).not.toHaveBeenCalled()
  })

  it('hashes settings and all input/pack stamps while ignoring outputPath', async () => {
    const key = await snapshotFacePreview(request)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(await snapshotFacePreview({ ...request, outputPath: join(directory, 'other.mp4') })).toBe(key)
    const effect = request.faceBlurs?.[0]
    if (!effect) throw new Error('expected a face effect')
    expect(await snapshotFacePreview({ ...request, faceBlurs: [{ ...effect, style: 'mask' }] })).not.toBe(key)
    await writeFile(source, 'changed source')
    const sourceKey = await snapshotFacePreview(request)
    expect(sourceKey).not.toBe(key)
    await writeFile(overlay, 'changed overlay')
    const overlayKey = await snapshotFacePreview(request)
    expect(overlayKey).not.toBe(sourceKey)
    for (const name of ['manifest.json', 'model.xml', 'model.bin', 'otc-face-blur', 'otc-face-blur.bin']) {
      const before = await snapshotFacePreview(request)
      await writeFile(join(directory, name), `changed ${name}`)
      expect(await snapshotFacePreview(request)).not.toBe(before)
    }
  })

  it('reuses a matching preview through one copy remux', async () => {
    const key = await snapshotFacePreview(request)
    if (!key) throw new Error('expected a preview key')
    await rememberFacePreview(key, preview)
    await expect(tryReuseFacePreview(request, join(directory, 'output.mp4'), 'reuse', 1)).resolves.toBe(true)
    expect(mocks.jobsRun).toHaveBeenCalledWith(
      '/mock/ffmpeg', expect.arrayContaining([
        '-i', preview, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
        '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1'
      ]),
      'export', 1, 'reuse', 'Reusing completed face preview', { phase: 'finalizing' }
    )
  })

  it('invalidates missing or replaced preview output and does not reuse after a failed render', async () => {
    const key = await snapshotFacePreview(request)
    if (!key) throw new Error('expected a preview key')
    await rememberFacePreview(key, preview)
    await rm(preview)
    await expect(tryReuseFacePreview(request, join(directory, 'output.mp4'), 'missing', 1)).resolves.toBe(false)
    expect(mocks.jobsRun).not.toHaveBeenCalled()
    await writeFile(preview, 'restored preview')
    const restoredKey = await snapshotFacePreview(request)
    if (!restoredKey) throw new Error('expected a restored key')
    await rememberFacePreview(restoredKey, preview)
    await rm(source)
    await expect(tryReuseFacePreview(request, join(directory, 'output.mp4'), 'missing-source', 1)).resolves.toBe(false)
    expect(mocks.jobsRun).not.toHaveBeenCalled()
    clearFacePreview()
    await expect(tryReuseFacePreview(request, join(directory, 'output.mp4'), 'empty', 1)).resolves.toBe(false)
  })

  it('rejects a persisted partial preview for full export reuse', async () => {
    const output = join(directory, 'face-preview', 'preview.mp4')
    await mkdir(join(directory, 'face-preview'), { recursive: true })
    await writeFile(output, 'partial-preview')
    const fullRequest = {
      ...request,
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }]
    } as ExportRequest
    const key = await snapshotFacePreview(fullRequest)
    if (!key) throw new Error('expected a preview key')
    await rememberFacePreview(key, output, [2, 4])
    clearFacePreview()

    await expect(tryReuseFacePreview(fullRequest, join(directory, 'output.mp4'), 'partial', 10)).resolves.toBe(false)
    expect(mocks.jobsRun).not.toHaveBeenCalled()
  })

  it('rejects corrupt or oversized persisted metadata and output stamp changes', async () => {
    const output = join(directory, 'face-preview', 'preview.mp4')
    const metadata = join(directory, 'face-preview', 'preview.json')
    await mkdir(join(directory, 'face-preview'), { recursive: true })
    await writeFile(output, 'preview')
    const key = await snapshotFacePreview(request)
    if (!key) throw new Error('expected a preview key')
    await writeFile(metadata, '{not-json')
    await expect(loadFacePreview(key, output)).resolves.toBeUndefined()
    await writeFile(metadata, 'x'.repeat(16 * 1024 + 1))
    await expect(loadFacePreview(key, output)).resolves.toBeUndefined()
    await writeFile(metadata, JSON.stringify({
      version: 1, key, range: [2, 2],
      outputStamp: { size: 7, mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1 }
    }))
    await expect(loadFacePreview(key, output)).resolves.toBeUndefined()

    await rememberFacePreview(key, output, [1, 2])
    await writeFile(output, 'changed-preview')
    clearFacePreview()
    await expect(loadFacePreview(key, output)).resolves.toBeUndefined()
  })

  it('rejects a remux when the preview is invalidated while it is running', async () => {
    const key = await snapshotFacePreview(request)
    if (!key) throw new Error('expected a preview key')
    await rememberFacePreview(key, preview)
    mocks.jobsRun.mockImplementationOnce(() => { clearFacePreview() })

    await expect(tryReuseFacePreview(request, join(directory, 'output.mp4'), 'invalidated', 1)).resolves.toBe(false)
  })

  it('propagates cancellation or other remux errors', async () => {
    const key = await snapshotFacePreview(request)
    if (!key) throw new Error('expected a preview key')
    await rememberFacePreview(key, preview)
    mocks.jobsRun.mockRejectedValueOnce(new Error('Job cancelled'))
    await expect(tryReuseFacePreview(request, join(directory, 'output.mp4'), 'cancelled', 1)).rejects.toThrow('Job cancelled')
  })

  it('rejects a remux when inputs change during it or another preview replaces the record', async () => {
    const key = await snapshotFacePreview(request)
    if (!key) throw new Error('expected a preview key')
    await rememberFacePreview(key, preview)
    mocks.jobsRun.mockImplementationOnce(async () => { await writeFile(source, 'changed during remux') })
    await expect(tryReuseFacePreview(request, join(directory, 'output.mp4'), 'changed', 1)).resolves.toBe(false)

    const replacement = join(directory, 'replacement.mp4')
    await writeFile(replacement, await readFile(preview))
    const nextKey = await snapshotFacePreview(request)
    if (!nextKey) throw new Error('expected a replacement key')
    await rememberFacePreview(nextKey, preview)
    mocks.jobsRun.mockImplementationOnce(async () => { await rememberFacePreview(nextKey, replacement) })
    await expect(tryReuseFacePreview(request, join(directory, 'output-2.mp4'), 'replaced', 1)).resolves.toBe(false)
  })
})
