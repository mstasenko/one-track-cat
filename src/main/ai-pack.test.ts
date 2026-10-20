import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const electronMock = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn(() => '/tmp/one-track-cat-user-data'),
    getAppPath: vi.fn(() => '/tmp/one-track-cat-app')
  }
}))

vi.mock('electron', () => electronMock)

import {
  aiModelDirectory,
  aiPackStatus,
  downloadAiModel,
  flashPreparedFileNames,
  flashStructuralFileNames,
  requireAiPack,
  startAiModelDownload,
  type AiPackWorker
} from './ai-pack'
import type { ModelDownloadProgress } from './model-download'

let directory: string

function manifestArtifact(path: string, data: string) {
  const bytes = Buffer.from(data)
  return {
    path,
    url: `https://models.example.test/${path}`,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

function testManifest(mode: 'turbo' | 'base' = 'turbo') {
  return {
    format: 1,
    modelId: 'test-flash-model',
    artifacts: [
      manifestArtifact(`${mode}/dit.safetensors`, 'dit'),
      manifestArtifact(`${mode}/lq_proj_in.safetensors`, 'lq'),
      manifestArtifact('shared/TCDecoder.ckpt', 'decoder'),
      manifestArtifact('shared/posi_prompt.pth', 'prompt')
    ]
  }
}

async function createPack(root: string, runtime: Record<string, unknown> = {
  format: 2,
  model: 'flashvsr-plus-rife-v4.25-v5',
  openvino: '2026.5.0-23457-7d81aad55a5',
  modes: ['turbo', 'base']
}): Promise<string> {
  const packDirectory = join(root, 'ai-pack')
  await mkdir(join(packDirectory, 'flash'), { recursive: true })
  await mkdir(join(packDirectory, 'flash-complements'))
  await writeFile(join(packDirectory, 'manifest.json'), JSON.stringify(runtime))
  const executable = join(packDirectory, 'otc-ai-enhance')
  await writeFile(executable, '#!/bin/sh\n')
  await chmod(executable, 0o755)
  await writeFile(join(packDirectory, 'otc-ai-enhance.bin'), 'binary')
  await chmod(join(packDirectory, 'otc-ai-enhance.bin'), 0o755)
  await writeFile(join(packDirectory, 'rife.xml'), '<model/>')
  await writeFile(join(packDirectory, 'rife.bin'), 'rife')
  for (const name of flashStructuralFileNames()) await writeFile(join(packDirectory, 'flash', name), 'fixed')
  return packDirectory
}

function workerFor(mode: 'turbo' | 'base' = 'turbo'): AiPackWorker {
  return async (_executable, args, _signal, onProgress) => {
    const models = args[args.indexOf('--models') + 1]
    if (!models) throw new Error('Missing model destination')
    if (args[0] === '--verify-models') return
    if (args[0] !== '--prepare-models') throw new Error('Unexpected worker action')
    for (const name of flashPreparedFileNames(mode)) await writeFile(join(models, name), 'prepared')
    onProgress?.({ phase: 'preparing', name: 'flash.bin', downloadedBytes: 1, totalBytes: 1,
      percent: 100, bytesPerSecond: null, etaSeconds: 0 })
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'otc-ai-pack-'))
  process.env.APPIMAGE = join(directory, 'OneTrackCat.AppImage')
  electronMock.app.isPackaged = true
})

afterEach(async () => {
  delete process.env.APPIMAGE
  await rm(directory, { recursive: true, force: true })
})

describe('FlashVSR+ AI pack discovery', () => {
  it('uses the embedded six-entry catalog instead of a writable pack manifest', async () => {
    const pack = await createPack(directory)
    await writeFile(join(pack, 'sources.json'), JSON.stringify({ format: 1, modelId: 'seedvr2-test' }))
    const status = await aiPackStatus({ directory: pack, userDataDirectory: join(directory, 'data') })
    expect(status).toMatchObject({ available: false, downloadable: true })
    expect(status.downloadBytes).toBe(5676070392 + 1151384272 + 189018333 + 4195504)
  })

  it('uses the native mode-bank and structural asset names', () => {
    const names = flashPreparedFileNames('base')
    expect(names.filter((name) => name.startsWith('flash_pre_4096_bf16_base_'))).toHaveLength(30)
    expect(names.filter((name) => name.startsWith('flash_post_4096_bf16_state_base_'))).toHaveLength(30)
    expect(names.filter((name) => name.startsWith('flash_cross_kv_bf16_base_'))).toHaveLength(30)
    expect(names.some((name) => name.startsWith('flash_cross_4096_bf16_'))).toBe(false)
    expect(flashStructuralFileNames()).toEqual(expect.arrayContaining([
      'flash_post_4096_bf16.xml', 'flash_post_4096_bf16.bin',
      'flash_cross_kv_bf16.xml', 'flash_cross_kv_bf16.bin'
    ]))
    expect(flashStructuralFileNames()).not.toEqual(expect.arrayContaining([
      'flash_post_4096_bf16_state.xml', 'flash_post_4096_bf16_state.bin'
    ]))
  })

  it('rejects an installed legacy SeedVR runtime clearly', async () => {
    const pack = await createPack(directory, { format: 1, modelId: 'seedvr2-3b-fp16' })
    await expect(requireAiPack({ directory: pack })).rejects.toThrow('legacy SeedVR')
    expect(await aiPackStatus({ directory: pack })).toEqual({
      available: false,
      message: 'The installed AI pack is a legacy SeedVR pack; install the FlashVSR+ AI pack.'
    })
  })

  it('selects one mode and shared sources, then prepares that mode directory', async () => {
    const pack = await createPack(directory)
    const modelManifest = testManifest('base')
    const userDataDirectory = join(directory, 'data')
    const downloader = vi.fn(async (artifacts: readonly { name: string; destination: string }[]) => {
      for (const artifact of artifacts) {
        const data = artifact.name.includes('dit') ? 'dit' : artifact.name.includes('lq') ? 'lq'
          : artifact.name.includes('TCDecoder') ? 'decoder' : 'prompt'
        await mkdir(dirname(artifact.destination), { recursive: true })
        await writeFile(artifact.destination, data)
      }
    })
    const worker = workerFor('base')
    await downloadAiModel({ directory: pack, userDataDirectory, modelManifest, mode: 'base', downloader, worker })
    expect(downloader).toHaveBeenCalledTimes(4)
    expect(downloader.mock.calls.flatMap((call) => call[0].map((item) => item.name))).toEqual([
      'base/dit.safetensors', 'base/lq_proj_in.safetensors', 'shared/TCDecoder.ckpt', 'shared/posi_prompt.pth'
    ])
    const result = await requireAiPack({ directory: pack, userDataDirectory, modelManifest, mode: 'base', worker })
    expect(result).toMatchObject({
      executable: join(pack, 'otc-ai-enhance'),
      models: join(aiModelDirectory('test-flash-model', userDataDirectory), 'models', 'base'),
      mode: 'base'
    })
  })

  it('keeps RIFE-only checks independent of model sources', async () => {
    const pack = await createPack(directory)
    const worker = vi.fn<AiPackWorker>()
    expect(await aiPackStatus({ directory: pack, spatial: false, mode: 'base', worker })).toEqual({ available: true, message: '' })
    expect((await requireAiPack({ directory: pack, spatial: false, mode: 'base', worker })).mode).toBe('base')
    await downloadAiModel({ directory: pack, spatial: false, mode: 'base', worker })
    expect(worker).not.toHaveBeenCalled()
  })

  it('rejects malformed modes before touching runtime or downloader', async () => {
    const pack = await createPack(directory)
    const worker = vi.fn<AiPackWorker>()
    await expect(aiPackStatus({ directory: pack, mode: 'v1' as never, worker })).resolves.toEqual({
      available: false, message: 'FlashVSR+ mode must be turbo or base'
    })
    await expect(downloadAiModel({ directory: pack, mode: 'v1' as never, worker })).rejects.toThrow('mode must be turbo or base')
    expect(worker).not.toHaveBeenCalled()
  })

  it('does not reuse an active download for another resolved job identity', async () => {
    const pack = await createPack(directory)
    const modelManifest = testManifest()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const downloader = vi.fn(async (items: readonly { name: string; destination: string }[]) => {
      for (const item of items) {
        await mkdir(dirname(item.destination), { recursive: true })
        const data = item.name.includes('dit') ? 'dit' : item.name.includes('lq') ? 'lq'
          : item.name.includes('TCDecoder') ? 'decoder' : 'prompt'
        await writeFile(item.destination, data)
      }
      await gate
    })
    const first = startAiModelDownload({ directory: pack, userDataDirectory: join(directory, 'data'), mode: 'turbo',
      modelManifest, downloader, worker: workerFor('turbo') })
    await vi.waitFor(() => expect(downloader).toHaveBeenCalled())
    expect(startAiModelDownload({ directory: pack, userDataDirectory: join(directory, 'data'), mode: 'turbo', modelManifest })).toBe(first)
    expect(() => startAiModelDownload({ directory: pack, userDataDirectory: join(directory, 'data'), mode: 'base', modelManifest })).toThrow('different directory, user-data directory, or mode')
    release()
    await first
  })

  it('reports malformed runtime manifests without leaking filesystem details', async () => {
    const pack = await createPack(directory, { format: 2, model: 'wrong', openvino: 'wrong', modes: ['turbo'] })
    await expect(requireAiPack({ directory: pack })).rejects.toThrow('optional OneTrackCat FlashVSR+ pack')
    expect((await aiPackStatus({ directory: pack })).message).toContain('Unsupported AI pack format')
  })

  it.each(['v2', 'v3', 'v4'])('rejects the older %s worker without current geometry/attention support', async (version) => {
    const pack = await createPack(directory, {
      format: 2, model: `flashvsr-plus-rife-v4.25-${version}`,
      openvino: '2026.5.0-23457-7d81aad55a5', modes: ['turbo', 'base']
    })
    const status = await aiPackStatus({ directory: pack })
    expect(status.available).toBe(false)
    expect(status.message).toContain('install the current OneTrackCat AI pack')
  })

  it('exposes the bounded native progress contract through the existing worker seam', async () => {
    const pack = await createPack(directory)
    const events: ModelDownloadProgress[] = []
    const worker = vi.fn<AiPackWorker>(async (_exe, args, _signal, onProgress) => {
      if (args[0] === '--prepare-models') {
        const models = args[args.indexOf('--models') + 1]
        if (!models) throw new Error('Missing output')
        for (const name of flashPreparedFileNames('turbo')) await writeFile(join(models, name), 'prepared')
        onProgress?.({ phase: 'preparing', name: 'flash.bin', downloadedBytes: 1, totalBytes: 1,
          percent: 100, bytesPerSecond: null, etaSeconds: 0 })
      }
    })
    await expect(downloadAiModel({ directory: pack, userDataDirectory: join(directory, 'progress-data'), modelManifest: testManifest(), mode: 'turbo',
      downloader: async (items) => { for (const item of items) {
        await mkdir(dirname(item.destination), { recursive: true })
        await writeFile(item.destination, item.name.includes('dit') ? 'dit' : item.name.includes('lq') ? 'lq' : item.name.includes('TC') ? 'decoder' : 'prompt')
      } },
      worker, onProgress: (event) => events.push(event)
    })).resolves.toBeUndefined()
    expect(worker).toHaveBeenCalledTimes(3)
    expect(events.some((event) => event.phase === 'preparing')).toBe(true)
  })
})
