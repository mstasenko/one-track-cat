import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelArtifactDownloader } from './model-download'
import type { FacePack } from './face-pack'
const mocks = vi.hoisted(() => ({ progress: vi.fn(), signal: new AbortController().signal }))
vi.mock('./face-process', () => ({ runFacePreparation: (_id: string,
  action: (signal: AbortSignal, progress: typeof mocks.progress) => Promise<void>) => action(mocks.signal, mocks.progress) }))
import { ensureFaceModels } from './face-models'

let directory: string
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  mocks.progress.mockClear()
  mocks.signal = new AbortController().signal
})
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'otc-face-models-'))
  const pack: FacePack = { executable: join(directory, 'worker'), model: join(directory, 'cache/model/model.xml'),
    catalog: join(directory, 'sources.json') }
  const artifacts = ['model.xml', 'model.bin'].map((path) => ({ path, url: `https://example.test/${path}`,
    bytes: path.length, sha256: createHash('sha256').update(path).digest('hex') }))
  await writeFile(pack.catalog ?? '', JSON.stringify({ format: 1, modelId: 'test', artifacts }))
  const downloader = vi.fn<ModelArtifactDownloader>(async (files, _signal, progress) => {
    for (const file of files) {
      await writeFile(file.destination, file.name)
      progress?.({ name: file.name, phase: 'downloading', downloadedBytes: file.bytes,
        totalBytes: file.bytes, percent: 100, etaSeconds: 0, bytesPerSecond: 1 })
    }
  })
  return { pack, downloader }
}
describe('Face model downloads', () => {
  it('downloads once outside the runtime pack and keeps installed weights offline', async () => {
    const { pack, downloader } = await fixture()
    await ensureFaceModels(pack, 'job', downloader)
    expect(await readFile(pack.model, 'utf8')).toBe('model.xml')
    expect(downloader).toHaveBeenCalledTimes(2)
    expect(mocks.progress).toHaveBeenCalledWith('Downloading face model: 100%', 1, 0)
    await ensureFaceModels(pack, 'job', downloader)
    expect(downloader).toHaveBeenCalledTimes(2)
  })
  it('leaves legacy bundled packs untouched', async () => {
    await expect(ensureFaceModels({ executable: '/old/worker', model: '/old/model.xml' }, 'job')).resolves.toBeUndefined()
  })
  it('does not follow a substituted cache directory or use a public directory', async () => {
    const { pack, downloader } = await fixture()
    await ensureFaceModels(pack, 'job', downloader)
    await chmod(join(directory, 'cache/model'), 0o755)
    await expect(ensureFaceModels(pack, 'job', downloader)).rejects.toThrow('private, owned')
    await rm(join(directory, 'cache/model'), { recursive: true })
    await symlink(directory, join(directory, 'cache/model'))
    await expect(ensureFaceModels(pack, 'job', downloader)).rejects.toThrow('private, owned')
  })
  it('propagates cancellation without requesting another artifact', async () => {
    const { pack, downloader } = await fixture()
    const controller = new AbortController()
    controller.abort()
    mocks.signal = controller.signal
    await expect(ensureFaceModels(pack, 'job', downloader)).rejects.toMatchObject({ name: 'AbortError' })
    expect(downloader).not.toHaveBeenCalled()
  })
})
