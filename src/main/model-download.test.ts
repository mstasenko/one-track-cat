import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const fsMocks = vi.hoisted(() => ({ createReadStream: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsMocks.createReadStream.mockImplementation(actual.createReadStream)
  const replacement = { ...actual, createReadStream: fsMocks.createReadStream }
  return { ...replacement, default: replacement }
})

import {
  downloadModelArtifacts,
  downloadModelManifest,
  isModelArtifactComplete,
  missingModelArtifactBytes,
  parseModelManifest,
  type ModelArtifact,
  type ModelDownloadProgress,
  type ModelManifest
} from './model-download'

const fetchMock = vi.fn<typeof fetch>()
let directory: string

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function artifact(name: string, data: Uint8Array, destination = join(directory, name)): ModelArtifact {
  return {
    name,
    url: `https://models.example.test/${name}`,
    bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
    destination
  }
}

function response(data: Uint8Array, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from(data), {
    status,
    headers: { 'content-length': String(data.byteLength), ...headers }
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'otc-model-download-'))
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fsMocks.createReadStream.mockClear()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

describe('pinned model downloads', () => {
  it.each([false, true])('refuses a partial symlink inserted during fetch (resume=%s)', async (resume) => {
    const data = bytes('pinned download')
    const destination = join(directory, 'late-symlink.bin')
    const victim = join(directory, 'unrelated')
    await writeFile(victim, 'preserve original')
    if (resume) await writeFile(destination + '.part', bytes('prefix'))
    fetchMock.mockImplementationOnce(async () => {
      if (resume) await rm(destination + '.part')
      await symlink(victim, destination + '.part')
      return response(data)
    })
    await expect(downloadModelArtifacts([artifact('late', data, destination)], new AbortController().signal)).rejects.toThrow()
    expect(await readFile(victim, 'utf8')).toBe('preserve original')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an existing hard-linked partial before a restart truncates its alias', async () => {
    const data = bytes('pinned download')
    const destination = join(directory, 'alias.bin')
    const victim = join(directory, 'alias-victim')
    await writeFile(victim, 'keep')
    await link(victim, destination + '.part')
    fetchMock.mockResolvedValueOnce(response(data))
    await expect(downloadModelArtifacts([artifact('alias', data, destination)], new AbortController().signal)).rejects.toThrow('partial changed')
    expect(await readFile(victim, 'utf8')).toBe('keep')
  })

  it('publishes a complete verified partial without a network request', async () => {
    const data = bytes('already complete')
    const destination = join(directory, 'complete-part.bin')
    await writeFile(destination + '.part', data)
    await downloadModelArtifacts([artifact('complete', data, destination)], new AbortController().signal)
    expect(await readFile(destination)).toEqual(Buffer.from(data))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hashes an unchanged verified artifact only once across completion and download checks', async () => {
    const data = bytes('verified model')
    const destination = join(directory, 'memoized.bin')
    await writeFile(destination, data)
    const pinned = artifact('memoized', data, destination)

    await expect(isModelArtifactComplete(pinned)).resolves.toBe(true)
    await expect(missingModelArtifactBytes([pinned])).resolves.toBe(0)
    await downloadModelArtifacts([pinned], new AbortController().signal)
    await expect(isModelArtifactComplete(pinned)).resolves.toBe(true)

    expect(fsMocks.createReadStream).toHaveBeenCalledOnce()
  })

  it('rehashes after an in-place same-size mutation changes file stamps', async () => {
    const data = bytes('valid artifact')
    const destination = join(directory, 'mutated.bin')
    await writeFile(destination, data)
    const pinned = artifact('mutated', data, destination)
    const before = await stat(destination)

    await expect(isModelArtifactComplete(pinned)).resolves.toBe(true)
    await writeFile(destination, bytes('wrong artifact'))
    await utimes(destination, before.atime, new Date(before.mtimeMs + 5_000))
    const after = await stat(destination)

    expect(after.size).toBe(before.size)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).not.toBe(before.mtimeMs)
    await expect(isModelArtifactComplete(pinned)).resolves.toBe(false)
    expect(fsMocks.createReadStream).toHaveBeenCalledTimes(2)
  })

  it('rehashes a replacement file even when its bytes still match', async () => {
    const data = bytes('replacement model')
    const destination = join(directory, 'replaced.bin')
    const replacement = join(directory, 'replacement.tmp')
    await writeFile(destination, data)
    const pinned = artifact('replaced', data, destination)

    await expect(isModelArtifactComplete(pinned)).resolves.toBe(true)
    await writeFile(replacement, data)
    await rm(destination)
    await rename(replacement, destination)

    await expect(isModelArtifactComplete(pinned)).resolves.toBe(true)
    expect(fsMocks.createReadStream).toHaveBeenCalledTimes(2)
  })

  it('downloads a fresh artifact, creates parents, and reports both phases', async () => {
    const data = bytes('fresh model bytes')
    const destination = join(directory, 'nested', 'models', 'model.bin')
    const events: ModelDownloadProgress[] = []
    fetchMock.mockResolvedValueOnce(response(data))

    await downloadModelArtifacts([artifact('fresh', data, destination)], new AbortController().signal, (event) => {
      events.push(event)
    })
    await expect(readFile(destination)).resolves.toEqual(Buffer.from(data))
    await expect(stat(`${destination}.part`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(new Set(events.map((event) => event.phase))).toEqual(new Set(['downloading', 'verifying']))
    expect(events.at(-1)).toMatchObject({
      name: 'fresh', phase: 'verifying', downloadedBytes: data.byteLength,
      totalBytes: data.byteLength, percent: 100, etaSeconds: 0
    })
    expect(events.every((event) => event.bytesPerSecond === null || event.bytesPerSecond >= 0)).toBe(true)
  })

  it('resumes a partial with a truthful range response', async () => {
    const data = bytes('0123456789abcdef')
    const split = 7
    const destination = join(directory, 'resume.bin')
    await writeFile(`${destination}.part`, data.subarray(0, split))
    fetchMock.mockImplementationOnce((_url, init) => {
      expect(new Headers(init?.headers).get('range')).toBe(`bytes=${split}-`)
      return Promise.resolve(response(data.subarray(split), 206, {
        'content-range': `bytes ${split}-${data.byteLength - 1}/${data.byteLength}`
      }))
    })

    await downloadModelArtifacts([artifact('resume', data, destination)], new AbortController().signal)

    await expect(readFile(destination)).resolves.toEqual(Buffer.from(data))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('restarts safely when a range request receives a normal 200', async () => {
    const data = bytes('server ignored range')
    const destination = join(directory, 'restart.bin')
    await writeFile(`${destination}.part`, bytes('stale prefix'))
    fetchMock.mockResolvedValueOnce(response(data, 200))

    await downloadModelArtifacts([artifact('restart', data, destination)], new AbortController().signal)

    await expect(readFile(destination)).resolves.toEqual(Buffer.from(data))
  })

  it('preserves the partial when cancellation interrupts the body', async () => {
    const first = bytes('first chunk')
    const second = bytes('second chunk')
    const data = new Uint8Array(first.byteLength + second.byteLength)
    data.set(first)
    data.set(second, first.byteLength)
    const destination = join(directory, 'cancel.bin')
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(first)
        streamController.enqueue(second)
        streamController.close()
      }
    })
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }))

    await expect(downloadModelArtifacts([artifact('cancel', data, destination)], controller.signal, (event) => {
      if (event.phase === 'downloading' && event.downloadedBytes === first.byteLength) controller.abort()
    })).rejects.toThrow('cancelled')

    await expect(readFile(`${destination}.part`)).resolves.toEqual(Buffer.from(first))
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels a pending network read without masking the cancellation error', async () => {
    const data = bytes('pending response')
    const destination = join(directory, 'pending.bin')
    const controller = new AbortController()
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start() {
        setTimeout(() => controller.abort(), 0)
      }
    })))

    await expect(downloadModelArtifacts([artifact('pending', data, destination)], controller.signal))
      .rejects.toMatchObject({ name: 'AbortError', message: 'Model download cancelled' })
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a completed partial whose hash does not match', async () => {
    const data = bytes('expected bytes')
    const wrong = Uint8Array.from(data)
    wrong[0] = (wrong[0] ?? 0) ^ 1
    const destination = join(directory, 'hash-failure.bin')
    fetchMock.mockResolvedValueOnce(response(wrong))

    await expect(downloadModelArtifacts([artifact('hash-failure', data, destination)], new AbortController().signal))
      .rejects.toThrow('SHA-256')
    await expect(stat(`${destination}.part`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('verifies and skips an already correct final destination', async () => {
    const data = bytes('already installed')
    const destination = join(directory, 'verified.bin')
    await writeFile(destination, data)
    const events: ModelDownloadProgress[] = []

    await downloadModelArtifacts([artifact('verified', data, destination)], new AbortController().signal, (event) => {
      events.push(event)
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(events.every((event) => event.phase === 'verifying')).toBe(true)
    expect(events.at(-1)?.percent).toBe(100)
  })

  it('never overwrites an occupied destination, even when its bytes are wrong', async () => {
    const expected = bytes('expected')
    const occupied = bytes('user file')
    const destination = join(directory, 'occupied.bin')
    await writeFile(destination, occupied)

    await expect(downloadModelArtifacts([artifact('occupied', expected, destination)], new AbortController().signal))
      .rejects.toThrow('occupied')
    expect(await readFile(destination)).toEqual(Buffer.from(occupied))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects invalid pins, non-HTTPS URLs, bad responses, and misleading lengths', async () => {
    const data = bytes('valid')
    const base = artifact('invalid', data)
    await expect(downloadModelArtifacts([{ ...base, url: 'http://models.example.test/invalid' }], new AbortController().signal))
      .rejects.toThrow('HTTPS')
    await expect(downloadModelArtifacts([{ ...base, bytes: 0 }], new AbortController().signal))
      .rejects.toThrow('byte count')
    await expect(downloadModelArtifacts([{ ...base, sha256: 'bad' }], new AbortController().signal))
      .rejects.toThrow('SHA-256')

    fetchMock.mockResolvedValueOnce(response(data, 503))
    await expect(downloadModelArtifacts([base], new AbortController().signal)).rejects.toThrow('HTTP 503')
    fetchMock.mockResolvedValueOnce(response(data, 200, { 'content-length': '99' }))
    await expect(downloadModelArtifacts([base], new AbortController().signal)).rejects.toThrow('Content-Length')
  })

  it('rejects a misleading range and an empty body without changing the partial', async () => {
    const data = bytes('range artifact')
    const destination = join(directory, 'bad-range.bin')
    const prefix = data.subarray(0, 4)
    await writeFile(`${destination}.part`, prefix)
    fetchMock.mockResolvedValueOnce(response(data.subarray(4), 206, {
      'content-range': `bytes 2-${data.byteLength - 1}/${data.byteLength}`
    }))
    await expect(downloadModelArtifacts([artifact('bad-range', data, destination)], new AbortController().signal))
      .rejects.toThrow('Content-Range')
    await expect(readFile(`${destination}.part`)).resolves.toEqual(Buffer.from(prefix))

    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start: (streamController) => streamController.close() })))
    const emptyDestination = join(directory, 'empty.bin')
    await expect(downloadModelArtifacts([artifact('empty', data, emptyDestination)], new AbortController().signal))
      .rejects.toThrow('progress')
  })

  it('processes multiple artifacts sequentially', async () => {
    const first = bytes('first')
    const second = bytes('second')
    fetchMock.mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(second))

    await downloadModelArtifacts([
      artifact('first', first),
      artifact('second', second)
    ], new AbortController().signal)

    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('/first'), expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('/second'), expect.any(Object))
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['first', 'second']))
  })

  it('parses only bounded HTTPS manifests with safe unique paths', () => {
    const valid: ModelManifest = {
      format: 1,
      modelId: 'seedvr2-v1',
      artifacts: [{
        path: 'models/sr.xml', url: 'https://models.example.test/sr.xml', bytes: 3,
        sha256: 'a'.repeat(64)
      }]
    }
    expect(parseModelManifest(valid)).toEqual(valid)
    const manifestWithArtifacts = (count: number): ModelManifest => ({
      ...valid,
      artifacts: Array.from({ length: count }, (_, index) => ({
        path: `models/seedvr-${index}.bin`,
        url: `https://models.example.test/seedvr-${index}.bin`,
        bytes: 1,
        sha256: 'a'.repeat(64)
      }))
    })
    expect(parseModelManifest(manifestWithArtifacts(160)).artifacts).toHaveLength(160)
    expect(() => parseModelManifest(manifestWithArtifacts(161))).toThrow('bounded list')
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, modelId: '../outside' },
      { ...valid, artifacts: [{ ...valid.artifacts[0], path: '../outside' }] },
      { ...valid, artifacts: [{ ...valid.artifacts[0], path: 'models\\sr.xml' }] },
      { ...valid, artifacts: [{ ...valid.artifacts[0], url: 'http://models.example.test/sr.xml' }] },
      { ...valid, artifacts: [{ ...valid.artifacts[0], bytes: 0 }] },
      { ...valid, artifacts: [{ ...valid.artifacts[0], sha256: 'not-a-hash' }] },
      { ...valid, artifacts: [valid.artifacts[0], valid.artifacts[0]] }
    ]) {
      expect(() => parseModelManifest(invalid)).toThrow('Invalid model manifest')
    }
  })

  it('keeps resumed bytes in aggregate progress without counting them as new transfer', async () => {
    const first = bytes('one')
    const second = bytes('second')
    const manifest: ModelManifest = {
      format: 1,
      modelId: 'seedvr2-progress',
      artifacts: [
        { path: 'sr.xml', url: 'https://models.example.test/sr.xml', bytes: first.byteLength, sha256: createHash('sha256').update(first).digest('hex') },
        { path: 'sr.bin', url: 'https://models.example.test/sr.bin', bytes: second.byteLength, sha256: createHash('sha256').update(second).digest('hex') }
      ]
    }
    const root = join(directory, manifest.modelId)
    const resumedBytes = 2
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'sr.xml.part'), Buffer.from(first.subarray(0, resumedBytes)))
    const events: ModelDownloadProgress[] = []
    fetchMock.mockImplementationOnce((_url, init) => {
      expect(new Headers(init?.headers).get('range')).toBe(`bytes=${resumedBytes}-`)
      return Promise.resolve(response(first.subarray(resumedBytes), 206, {
        'content-range': `bytes ${resumedBytes}-${first.byteLength - 1}/${first.byteLength}`
      }))
    }).mockResolvedValueOnce(response(second))

    await downloadModelManifest(manifest, root, new AbortController().signal, (event) => events.push(event))

    await expect(readFile(join(root, 'sr.xml'))).resolves.toEqual(Buffer.from(first))
    await expect(readFile(join(root, 'sr.bin'))).resolves.toEqual(Buffer.from(second))
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('/sr.xml'), expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('/sr.bin'), expect.any(Object))
    expect(events.at(-1)).toMatchObject({
      phase: 'verifying', downloadedBytes: first.byteLength + second.byteLength,
      totalBytes: first.byteLength + second.byteLength, percent: 100, etaSeconds: 0
    })
    expect(events.find((event) => event.name === 'sr.xml' && event.phase === 'downloading')).toMatchObject({
      downloadedBytes: resumedBytes,
      totalBytes: first.byteLength + second.byteLength,
      percent: resumedBytes / (first.byteLength + second.byteLength) * 100,
      bytesPerSecond: null,
      etaSeconds: null
    })
    expect(events.some((event) => event.downloadedBytes > first.byteLength && event.totalBytes === first.byteLength + second.byteLength)).toBe(true)
    const firstManifestArtifact = manifest.artifacts[0]
    const secondManifestArtifact = manifest.artifacts[1]
    if (!firstManifestArtifact || !secondManifestArtifact) throw new Error('manifest fixture incomplete')
    expect(await missingModelArtifactBytes([
      { name: 'sr.xml', ...firstManifestArtifact, destination: join(root, 'sr.xml') },
      { name: 'sr.bin', ...secondManifestArtifact, destination: join(root, 'sr.bin') }
    ])).toBe(0)
  })
})
