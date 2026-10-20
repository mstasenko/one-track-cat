import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AiPackWorker } from './ai-pack'

const disk = vi.hoisted(() => ({ statfs: vi.fn(), rootOwnedRuntime: false, afterRename: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    const info = await actual.lstat(...args)
    if (disk.rootOwnedRuntime && /otc-ai-enhance(?:\.bin)?$/u.test(String(args[0]))) {
      Object.defineProperty(info, 'uid', { value: typeof info.uid === 'bigint' ? 0n : 0 })
    }
    return info
  }) as typeof actual.lstat
  const rename: typeof actual.rename = async (...args) => {
    await actual.rename(...args)
    const callback = disk.afterRename
    disk.afterRename = undefined
    callback?.()
  }
  const mocked = { ...actual, statfs: disk.statfs, lstat, rename }
  return { ...mocked, default: mocked }
})
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/unused' } }))

import {
  aiPackStatus,
  cancelAiModelDownload,
  downloadAiModel,
  flashPreparedFileNames,
  flashPreparationReserveBytes,
  flashStructuralFileNames,
  requireAiPack,
  shutdownAiModelDownload,
  startAiModelDownload
} from './ai-pack'

let root: string
let pack: string
const sourceData = 'weights'
const modelManifest = {
  format: 1,
  modelId: 'test-flash-model',
  artifacts: [{
    path: 'weights', url: 'https://example.test/weights', bytes: sourceData.length,
    sha256: createHash('sha256').update(sourceData).digest('hex')
  }]
}
const prepared = (mode: 'turbo' | 'base' = 'turbo') => join(root, 'user', 'test-flash-model', 'models', mode)
const source = () => join(root, 'user', 'test-flash-model', 'sources', 'weights')
const options = (worker: AiPackWorker, mode: 'turbo' | 'base' = 'turbo') => ({
  directory: pack, userDataDirectory: join(root, 'user'), modelManifest, mode, worker
})
const fill = async (directory: string, mode: 'turbo' | 'base' = 'turbo'): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  for (const name of flashPreparedFileNames(mode)) await writeFile(join(directory, name), 'fixed')
  for (const name of flashStructuralFileNames()) await writeFile(join(directory, name), 'fixed')
}

async function writePack(): Promise<void> {
  await mkdir(join(pack, 'flash'), { recursive: true })
  await mkdir(join(pack, 'flash-complements'))
  await writeFile(join(pack, 'manifest.json'), JSON.stringify({
    format: 2, model: 'flashvsr-plus-rife-v4.25-v5',
    openvino: '2026.5.0-23457-7d81aad55a5', modes: ['turbo', 'base']
  }))
  for (const name of ['otc-ai-enhance', 'otc-ai-enhance.bin']) {
    await writeFile(join(pack, name), 'binary')
    await chmod(join(pack, name), 0o755)
  }
  await writeFile(join(pack, 'rife.xml'), '<net/>')
  await writeFile(join(pack, 'rife.bin'), 'rife')
  for (const name of flashStructuralFileNames()) await writeFile(join(pack, 'flash', name), 'fixed')
}

const downloader = vi.fn(async (artifacts: readonly { destination: string }[]) => {
  for (const artifact of artifacts) await writeFile(artifact.destination, sourceData)
})

beforeEach(async () => {
  disk.statfs.mockReset().mockResolvedValue({ bsize: 1n, bavail: 32n * 1024n ** 3n })
  disk.rootOwnedRuntime = false
  disk.afterRename = undefined
  downloader.mockClear()
  root = await mkdtemp(join(tmpdir(), 'otc-pack-ready-'))
  pack = join(root, 'pack')
  await writePack()
})

afterEach(async () => {
  await shutdownAiModelDownload()
  await rm(root, { recursive: true, force: true })
})

describe('FlashVSR+ prepared readiness', () => {
  const preparedSpace = BigInt(3_493_228_156 + 94_871_238) + BigInt(flashPreparationReserveBytes)

  it('accepts a root-owned installed runtime with a private user-owned model cache', async () => {
    await fill(prepared())
    disk.rootOwnedRuntime = true
    const worker = vi.fn<AiPackWorker>().mockResolvedValue()
    await expect(requireAiPack(options(worker))).resolves.toMatchObject({ models: prepared() })
    expect(worker).toHaveBeenCalledOnce()
  })

  it('retries a cancelled partial structural replacement without touching learned banks', async () => {
    await fill(prepared())
    const learned = flashPreparedFileNames('turbo')[0]
    if (!learned) throw new Error('Missing learned inventory')
    await writeFile(join(prepared(), learned), 'preserved-learned-bank')
    for (const name of flashStructuralFileNames()) await writeFile(join(prepared(), name), 'old')
    const controller = new AbortController()
    const worker = vi.fn<AiPackWorker>(async (_executable, args) => {
      if (args.includes('--structural-only')) return
      for (const name of flashStructuralFileNames()) {
        if (await readFile(join(prepared(), name), 'utf8') !== 'fixed') throw new Error('stale structural cache')
      }
    })
    disk.afterRename = () => controller.abort()
    await expect(downloadAiModel({ ...options(worker), signal: controller.signal, downloader }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(await readFile(join(prepared(), learned), 'utf8')).toBe('preserved-learned-bank')
    expect(await readdir(join(prepared(), '..'))).toEqual(['turbo'])
    await downloadAiModel({ ...options(worker), downloader })
    expect(downloader).not.toHaveBeenCalled()
    expect(await readFile(join(prepared(), learned), 'utf8')).toBe('preserved-learned-bank')
  })

  it('charges selected mode, shared prepared inventory, and reserve before download', async () => {
    disk.statfs.mockResolvedValue({ bsize: 1n, bavail: preparedSpace + BigInt(sourceData.length) - 1n })
    const worker = vi.fn<AiPackWorker>().mockResolvedValue()
    await expect(downloadAiModel({ ...options(worker), downloader })).rejects.toThrow('Not enough free disk space')
    expect(downloader).not.toHaveBeenCalled()
    expect(worker).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['--mode', 'turbo']), expect.any(AbortSignal), undefined)
  })

  it('uses only preparation space when all selected sources are present', async () => {
    await mkdir(join(root, 'user', 'test-flash-model', 'sources'), { recursive: true, mode: 0o700 })
    await writeFile(source(), sourceData)
    disk.statfs.mockResolvedValue({ bsize: 1n, bavail: preparedSpace })
    const worker = vi.fn<AiPackWorker>(async (_executable, args) => {
      if (args[0] === '--prepare-models') await fill(prepared())
    })
    await downloadAiModel({ ...options(worker), downloader })
    expect(downloader).not.toHaveBeenCalled()
    expect((await aiPackStatus(options(worker))).available).toBe(true)
  })

  it('rechecks after source download and never creates a mode leaf when space falls', async () => {
    disk.statfs.mockResolvedValueOnce({ bsize: 1n, bavail: preparedSpace + BigInt(sourceData.length) })
      .mockResolvedValueOnce({ bsize: 1n, bavail: preparedSpace - 1n })
    const worker = vi.fn<AiPackWorker>().mockResolvedValue()
    await expect(downloadAiModel({ ...options(worker), downloader })).rejects.toThrow('Not enough free disk space')
    expect(await readFile(source(), 'utf8')).toBe(sourceData)
    expect(worker.mock.calls.some((call) => call[1][0] === '--prepare-models')).toBe(false)
  })

  it.each([1, 2])('honors cancellation during disk check %s', async (check) => {
    const controller = new AbortController()
    let calls = 0
    disk.statfs.mockImplementation(() => {
      if (++calls === check) controller.abort()
      return Promise.resolve({ bsize: 1n, bavail: 32n * 1024n ** 3n })
    })
    const worker = vi.fn<AiPackWorker>().mockResolvedValue()
    await expect(downloadAiModel({ ...options(worker), downloader, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(downloader).toHaveBeenCalledTimes(check === 1 ? 0 : 1)
    expect(worker.mock.calls.some((call) => call[1][0] === '--prepare-models')).toBe(false)
  })

  it.each(['symlink', 'public'])('rejects unsafe source directories before download: %s', async (kind) => {
    const modelRoot = join(root, 'user', 'test-flash-model')
    const sources = join(modelRoot, 'sources')
    await mkdir(modelRoot, { recursive: true, mode: 0o700 })
    if (kind === 'symlink') {
      const unrelated = join(root, 'unrelated')
      await mkdir(unrelated, { mode: 0o700 })
      await symlink(unrelated, sources)
    } else {
      await mkdir(sources, { mode: 0o755 })
      await chmod(sources, 0o755)
    }
    const worker = vi.fn<AiPackWorker>().mockResolvedValue()
    await expect(downloadAiModel({ ...options(worker), downloader })).rejects.toThrow('private, owned')
    expect(downloader).not.toHaveBeenCalled()
  })

  it('keeps RIFE-only mode checks independent of source and preparation', async () => {
    const worker = vi.fn<AiPackWorker>()
    expect(await aiPackStatus({ directory: pack, spatial: false, mode: 'base', worker })).toEqual({ available: true, message: '' })
    expect((await requireAiPack({ directory: pack, spatial: false, mode: 'base', worker })).mode).toBe('base')
    await downloadAiModel({ directory: pack, spatial: false, mode: 'base', worker })
    expect(disk.statfs).not.toHaveBeenCalled()
  })

  it('requires preparation even when the source is complete', async () => {
    await mkdir(join(root, 'user', 'test-flash-model', 'sources'), { recursive: true })
    await writeFile(source(), sourceData)
    const worker = vi.fn<AiPackWorker>()
    expect(await aiPackStatus(options(worker))).toMatchObject({ available: false, downloadable: true, downloadBytes: 0 })
    await expect(requireAiPack(options(worker))).rejects.toThrow('optional')
  })

  it('memoizes verified mode identity and invalidates it on a prepared-file mutation', async () => {
    await fill(prepared())
    const worker = vi.fn<AiPackWorker>().mockResolvedValue()
    expect(await aiPackStatus(options(worker))).toEqual({ available: true, message: '' })
    expect((await requireAiPack(options(worker))).models).toBe(prepared())
    expect(worker).toHaveBeenCalledTimes(1)
    const [firstPreparedName] = flashPreparedFileNames('turbo')
    if (firstPreparedName === undefined) throw new Error('Prepared inventory is unexpectedly empty')
    await writeFile(join(prepared(), firstPreparedName), 'changed')
    expect((await aiPackStatus(options(worker))).available).toBe(true)
    expect(worker).toHaveBeenCalledTimes(2)
  })

  it('prepares and verifies with mode-aware worker arguments', async () => {
    const phases: string[] = []
    const worker = vi.fn<AiPackWorker>(async (_executable, args, _signal, progress) => {
      if (args[0] === '--prepare-models') {
        await fill(prepared('base'), 'base')
        progress?.({ phase: 'preparing', name: 'result.bin', downloadedBytes: 1, totalBytes: 1,
          percent: 100, bytesPerSecond: null, etaSeconds: 0 })
      } else progress?.({ phase: 'verifying', name: 'fixed.bin', downloadedBytes: 1, totalBytes: 1,
        percent: 100, bytesPerSecond: null, etaSeconds: 0 })
    })
    await downloadAiModel({ ...options(worker, 'base'), downloader, onProgress: (progress) => phases.push(progress.phase) })
    expect(worker.mock.calls.map((call) => call[1][0])).toEqual(['--verify-models', '--prepare-models', '--verify-models'])
    expect(worker.mock.calls.every((call) => call[1].includes('base'))).toBe(true)
    expect(phases).toEqual(['verifying', 'verifying', 'preparing', 'verifying'])
    expect((await aiPackStatus(options(worker, 'base'))).available).toBe(true)
  })

  it('accepts bounded progress from the native worker on first verification', async () => {
    await fill(prepared())
    await writeFile(join(pack, 'otc-ai-enhance'),
      "#!/bin/sh\nprintf '%s\\n' '{\"phase\":\"verifying\",\"name\":\"check.bin\",\"done\":1,\"total\":1}' >&2\n")
    await chmod(join(pack, 'otc-ai-enhance'), 0o755)
    const progress: string[] = []
    await downloadAiModel({ directory: pack, userDataDirectory: join(root, 'user'), modelManifest,
      onProgress: (event) => progress.push(`${event.phase}:${event.name}:${event.percent}`) })
    expect(progress).toEqual(['verifying:check.bin:100'])
  })

  it('rejects malformed native progress instead of accepting a successful exit', async () => {
    await fill(prepared())
    await writeFile(join(pack, 'otc-ai-enhance'), "#!/bin/sh\nprintf '%s\\n' '{}' >&2\n")
    await chmod(join(pack, 'otc-ai-enhance'), 0o755)
    await expect(aiPackStatus({ directory: pack, userDataDirectory: join(root, 'user'), modelManifest }))
      .resolves.toMatchObject({ available: false, downloadable: true })
  })

  it('refreshes fixed structural files in an existing learned cache without downloading', async () => {
    await fill(prepared())
    const learnedName = flashPreparedFileNames('turbo')[0]
    const structuralName = flashStructuralFileNames()[0]
    if (!learnedName || !structuralName) throw new Error('Prepared inventory is unexpectedly empty')
    await writeFile(join(prepared(), learnedName), 'learned-bank')
    await writeFile(join(prepared(), structuralName), 'old-structural')
    const calls: string[][] = []
    const worker = vi.fn<AiPackWorker>(async (_executable, args) => {
      calls.push(args)
      if (args.includes('--structural-only')) return
      const models = args[args.indexOf('--models') + 1]
      if (models === prepared() && await readFile(join(prepared(), structuralName), 'utf8') !== 'fixed') {
        throw new Error('stale structural cache')
      }
    })
    await downloadAiModel({ ...options(worker), downloader })
    expect(downloader).not.toHaveBeenCalled()
    expect(await readFile(join(prepared(), learnedName), 'utf8')).toBe('learned-bank')
    expect(await readFile(join(prepared(), structuralName), 'utf8')).toBe('fixed')
    expect(calls.map((args) => args[0])).toEqual(['--verify-models', '--verify-models', '--verify-models'])
    expect(calls.some((args) => args.includes('--structural-only'))).toBe(true)
    expect(calls.some((args) => args[0] === '--prepare-models')).toBe(false)
  })

  it('stages a failed structural refresh privately and retries without touching learned banks', async () => {
    await fill(prepared())
    const learnedName = flashPreparedFileNames('turbo')[0]
    const firstStructuralName = flashStructuralFileNames()[0]
    const failingStructuralName = flashStructuralFileNames()[1]
    if (!learnedName || !firstStructuralName || !failingStructuralName) throw new Error('Prepared inventory is unexpectedly empty')
    await writeFile(join(prepared(), learnedName), 'learned-bank')
    await writeFile(join(prepared(), firstStructuralName), 'old-first')
    const external = join(root, 'untrusted-structural')
    await writeFile(external, 'fixed')
    await rm(join(pack, 'flash', failingStructuralName))
    await symlink(external, join(pack, 'flash', failingStructuralName))
    const worker = vi.fn<AiPackWorker>(async (_executable, args) => {
      if (args.includes('--structural-only')) return
      const models = args[args.indexOf('--models') + 1]
      if (models === prepared() && await readFile(join(prepared(), firstStructuralName), 'utf8') !== 'fixed') {
        throw new Error('stale structural cache')
      }
    })
    await expect(downloadAiModel({ ...options(worker), downloader })).rejects.toThrow('safe regular file')
    expect(await readFile(join(prepared(), learnedName), 'utf8')).toBe('learned-bank')
    expect(await readFile(join(prepared(), firstStructuralName), 'utf8')).toBe('old-first')
    await rm(join(pack, 'flash', failingStructuralName))
    await writeFile(join(pack, 'flash', failingStructuralName), 'fixed')
    await downloadAiModel({ ...options(worker), downloader })
    expect(downloader).not.toHaveBeenCalled()
    expect(await readFile(join(prepared(), learnedName), 'utf8')).toBe('learned-bank')
    expect(await readFile(join(prepared(), firstStructuralName), 'utf8')).toBe('fixed')
  })

  it('rejects a corrupt learned bank without deleting or redownloading it', async () => {
    await fill(prepared())
    const learnedName = flashPreparedFileNames('turbo')[0]
    if (!learnedName) throw new Error('Prepared inventory is unexpectedly empty')
    await writeFile(join(prepared(), learnedName), 'corrupt-learned-bank')
    const worker = vi.fn<AiPackWorker>((_executable, args) => {
      if (!args.includes('--structural-only') && args[args.indexOf('--models') + 1] === prepared()) {
        return Promise.reject(new Error('corrupt learned bank'))
      }
      return Promise.resolve()
    })
    await expect(downloadAiModel({ ...options(worker), downloader })).rejects.toThrow('did not pass verification')
    expect(downloader).not.toHaveBeenCalled()
    expect(await readFile(join(prepared(), learnedName), 'utf8')).toBe('corrupt-learned-bank')
  })

  it('rejects a symlinked learned bank and leaves the cache intact', async () => {
    await fill(prepared())
    const learnedName = flashPreparedFileNames('turbo')[0]
    if (!learnedName) throw new Error('Prepared inventory is unexpectedly empty')
    const target = join(root, 'outside-learned')
    await writeFile(target, 'outside')
    await rm(join(prepared(), learnedName))
    await symlink(target, join(prepared(), learnedName))
    const worker = vi.fn<AiPackWorker>().mockResolvedValue()
    await expect(downloadAiModel({ ...options(worker), downloader })).rejects.toThrow('interrupted')
    expect(downloader).not.toHaveBeenCalled()
    expect(await readFile(join(prepared(), learnedName), 'utf8')).toBe('outside')
  })

  it('preserves an unknown existing mode directory instead of deleting it', async () => {
    await mkdir(prepared(), { recursive: true, mode: 0o700 })
    await writeFile(join(prepared(), 'unknown'), 'preserve')
    const worker = vi.fn<AiPackWorker>()
    await expect(downloadAiModel(options(worker))).rejects.toThrow('interrupted')
    expect(await readFile(join(prepared(), 'unknown'), 'utf8')).toBe('preserve')
  })

  it('cancels a shared active promise before cleanup', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const worker = vi.fn<AiPackWorker>(async (_exe, args, signal) => {
      if (args[0] !== '--prepare-models') return
      await fill(prepared())
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
        setTimeout(() => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), 0)
      }, { once: true }))
    })
    const first = startAiModelDownload({ ...options(worker), downloader: async () => gate })
    expect(startAiModelDownload(options(worker))).toBe(first)
    release()
    await vi.waitFor(() => expect(cancelAiModelDownload()).toBe(true))
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
  })
})
