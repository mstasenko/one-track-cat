import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelArtifactDownloader } from './model-download'
import type { NarrationProgress } from '../narration-api'
import publishedSources from '../../assets/voice/sources.json'

const platform = vi.hoisted(() => ({ packaged: true }))
vi.mock('electron', () => ({ app: { get isPackaged() { return platform.packaged }, getPath: () => '/unused' } }))
import { ensureNarrationModels, parseVoiceSources } from './narration-models'

const hash = (data: string) => createHash('sha256').update(data).digest('hex')
const artifact = (path: string, data: string) => ({ path, url: `https://example.test/${path}`,
  bytes: Buffer.byteLength(data), sha256: hash(data) })
const catalog = () => ({ format: 1, modelId: 'otc-voice-models', artifacts: [
  artifact('voice/model.bin.part0', 'first'), artifact('voice/model.bin.part1', 'second'), artifact('separator/model.xml', 'xml')
], assemblies: [{ path: 'voice/model.bin', bytes: 11, sha256: hash('firstsecond'),
  parts: ['voice/model.bin.part0', 'voice/model.bin.part1'] }] })
const directories: string[] = []
afterEach(async () => {
  platform.packaged = true
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const pack = await mkdtemp(join(tmpdir(), 'otc-voice-download-'))
  directories.push(pack)
  const root = join(pack, 'models')
  await writeFile(join(pack, 'sources.json'), JSON.stringify(catalog()))
  const downloader = vi.fn<ModelArtifactDownloader>(async (artifacts, signal, progress) => {
    for (const item of artifacts) {
      signal.throwIfAborted()
      const data = item.name.endsWith('part0') ? 'first' : item.name.endsWith('part1') ? 'second' : 'xml'
      await writeFile(item.destination, data)
      progress?.({ name: item.name, phase: 'downloading', downloadedBytes: item.bytes,
        totalBytes: item.bytes, percent: 100, bytesPerSecond: 1, etaSeconds: 0 })
    }
  })
  const controller = new AbortController()
  const progress = vi.fn<(value: NarrationProgress) => void>()
  const run = () => ensureNarrationModels(pack, controller.signal, progress, { root, downloader })
  return { pack, root, downloader, controller, progress, run }
}

describe('Voice model downloads', () => {
  it('accepts the complete published catalog without loading models', () => {
    const result = parseVoiceSources(publishedSources, '/models')
    expect(result.manifest.artifacts).toHaveLength(publishedSources.artifacts.length)
    expect(result.assemblies).toHaveLength(1)
    expect(result.assemblies[0]?.target.bytes).toBe(2663621898)
  })
  it('adds speech detection to a qualified development pack without copying its linked weights', async () => {
    const f = await fixture()
    platform.packaged = false
    for (const path of ['separator/model.bin', 'whisper/openvino_encoder_model.bin',
      'cleanup/openvino_language_model.bin', 'voice/openvino_base_lm.bin']) {
      const [directory, name] = path.split('/')
      if (!directory || !name) throw new Error('Invalid fixture path')
      const target = join(f.pack, 'qualified', directory)
      await mkdir(target, { recursive: true })
      await writeFile(join(target, name), 'existing weights')
      await symlink(target, join(f.pack, directory))
    }
    await writeFile(join(f.pack, 'sources.json'), JSON.stringify({ format: 1, modelId: 'otc-voice-models',
      artifacts: [artifact('vad/model.onnx', 'xml')], assemblies: [] }))
    expect(await ensureNarrationModels(f.pack, f.controller.signal, f.progress, { downloader: f.downloader })).toBe(f.pack)
    expect(f.downloader.mock.calls.flatMap(([items]) => items.map((item) => item.name))).toEqual(['vad/model.onnx'])
    expect(await readFile(join(f.pack, 'vad/model.onnx'), 'utf8')).toBe('xml')
    expect(await readFile(join(f.pack, 'whisper/openvino_encoder_model.bin'), 'utf8')).toBe('existing weights')
  })
  it('downloads, verifies, assembles atomically and reuses weights without their chunks', async () => {
    const f = await fixture()
    expect(await f.run()).toBe(f.root)
    expect(await readFile(join(f.root, 'voice/model.bin'), 'utf8')).toBe('firstsecond')
    await expect(readFile(join(f.root, 'voice/model.bin.part0'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.progress.mock.calls.some(([value]) => value.stage === 'Preparing voice model')).toBe(true)
    const calls = f.downloader.mock.calls.length
    expect(await f.run()).toBe(f.root)
    expect(f.downloader).toHaveBeenCalledTimes(calls)
  })
  it('retains completed downloads after cancellation and resumes without downloading them again', async () => {
    const f = await fixture()
    const original = f.downloader.getMockImplementation()
    if (!original) throw new Error('Missing fixture downloader')
    f.downloader.mockImplementation(async (...args) => { await original(...args); f.controller.abort() })
    await expect(f.run()).rejects.toMatchObject({ name: 'AbortError' })
    f.downloader.mockClear().mockImplementation(original)
    await ensureNarrationModels(f.pack, new AbortController().signal, f.progress, { root: f.root, downloader: f.downloader })
    expect(f.downloader.mock.calls.flatMap(([items]) => items.map((item) => item.name))).not.toContain('voice/model.bin.part0')
  })
  it('never replaces an occupied final model or follows a model-directory symlink', async () => {
    const f = await fixture()
    await f.run()
    await writeFile(join(f.root, 'voice/model.bin'), 'user data')
    await expect(f.run()).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(f.root, 'voice/model.bin'), 'utf8')).toBe('user data')
    await rm(join(f.root, 'voice'), { recursive: true })
    await symlink(f.pack, join(f.root, 'voice'))
    await expect(f.run()).rejects.toThrow('Unsafe voice model directory')
  })
  it('rejects public model directories and pre-cancelled work', async () => {
    const f = await fixture()
    await f.run()
    await chmod(f.root, 0o755)
    await expect(f.run()).rejects.toThrow('private, owned directory')
    f.controller.abort()
    await expect(f.run()).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('does not publish corrupt assembled content', async () => {
    const f = await fixture()
    const value = catalog()
    const assembly = value.assemblies[0]
    if (!assembly) throw new Error('Missing fixture assembly')
    assembly.sha256 = hash('wrong target')
    await writeFile(join(f.pack, 'sources.json'), JSON.stringify(value))
    await expect(f.run()).rejects.toThrow('assembly checksum')
    await expect(readFile(join(f.root, 'voice/model.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(f.run()).rejects.toThrow('assembly checksum') // Safe stale-part retry.
  })
  it('removes a cancelled assembly temporary while preserving resumable chunks', async () => {
    const f = await fixture()
    f.progress.mockImplementation((value: NarrationProgress) => {
      if (value.stage === 'Preparing voice model' && value.fraction > 0) f.controller.abort()
    })

    await expect(f.run()).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readFile(join(f.root, 'voice/model.bin.assembling'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(f.root, 'voice/model.bin.part0'), 'utf8')).resolves.toBe('first')
    await expect(readFile(join(f.root, 'voice/model.bin.part1'), 'utf8')).resolves.toBe('second')
  })
  it.each([
    { extra: true }, { modelId: 'other' }, { assemblies: null },
    { artifacts: [artifact('../escape', 'a')] }, { artifacts: [artifact('other/model.bin', 'a')] },
    { assemblies: [{ ...catalog().assemblies[0], path: '../escape' }] },
    { assemblies: [{ ...catalog().assemblies[0], path: 'separator/model.xml' }] },
    { assemblies: [{ ...catalog().assemblies[0], parts: ['voice/model.bin.part1', 'voice/model.bin.part0'] }] },
    { assemblies: [{ ...catalog().assemblies[0], bytes: 12 }] },
    { assemblies: [{ ...catalog().assemblies[0], sha256: 'bad' }] }
  ])('rejects malformed catalog %#', (patch) => {
    expect(() => parseVoiceSources({ ...catalog(), ...patch }, '/models')).toThrow()
  })
})
