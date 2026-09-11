import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: Error | null,
      result: { stdout: Buffer; stderr: string }
    ) => void
    callback(null, { stdout: Buffer.alloc(4), stderr: '' })
  })
}))
const jobsMock = vi.hoisted(() => ({ run: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp'), isPackaged: false } }))
vi.mock('./binaries', () => ({ ffmpegPath: () => '/ffmpeg', ffprobePath: () => '/ffprobe' }))
vi.mock('./jobs', () => ({ jobs: jobsMock }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: childProcess.execFile,
    default: { ...actual, execFile: childProcess.execFile }
  }
})

let peaksFromPcm: typeof import('./media').peaksFromPcm
let displayDimensions: typeof import('./media').displayDimensions
let pruneProxyCache: typeof import('./media').pruneProxyCache
let proxyCacheKey: typeof import('./media').proxyCacheKey
let firstPositiveNumber: typeof import('./media').firstPositiveNumber
let firstFrameRate: typeof import('./media').firstFrameRate
let proxyVideoFilter: typeof import('./media').proxyVideoFilter
let proxyArgs: typeof import('./media').proxyArgs
let waveformFor: typeof import('./media').waveformFor
let createProxy: typeof import('./media').createProxy
let shutdownProxyJobs: typeof import('./media').shutdownProxyJobs
const directories: string[] = []

beforeAll(async () => {
  ;({
    peaksFromPcm, displayDimensions, pruneProxyCache, proxyCacheKey,
    firstPositiveNumber, firstFrameRate,
    proxyVideoFilter, proxyArgs, waveformFor, createProxy,
    shutdownProxyJobs
  } = await import('./media'))
})

afterEach(async () => {
  childProcess.execFile.mockClear()
  jobsMock.run.mockReset()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('media waveform extraction', () => {
  it('aggregates and normalizes PCM samples into display peaks', () => {
    const samples = [0, 0.25, -0.5, 1]
    const buffer = Buffer.alloc(samples.length * 4)
    samples.forEach((sample, index) => buffer.writeFloatLE(sample, index * 4))
    expect(peaksFromPcm(buffer, 2)).toEqual([0.25, 1])
  })

  it('returns no invented peaks for empty audio', () => {
    expect(peaksFromPcm(Buffer.alloc(0))).toEqual([])
  })

  it('keeps fine-grained peaks for precise timeline zooming', () => {
    expect(peaksFromPcm(Buffer.alloc(10_001 * 4))).toHaveLength(10_001)
  })

  it('uses display dimensions for rotated phone video', () => {
    expect(displayDimensions(1920, 1080, 90)).toEqual({ width: 1080, height: 1920 })
    expect(displayDimensions(1920, 1080, -90)).toEqual({ width: 1080, height: 1920 })
    expect(displayDimensions(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 })
  })

  it('bounds proxy storage while preserving the newly generated proxy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-proxies-'))
    directories.push(directory)
    const oldProxy = join(directory, 'old.mp4')
    const newestProxy = join(directory, 'new.mp4')
    const activeProxy = join(directory, '.key.job.partial.mp4')
    await writeFile(oldProxy, Buffer.alloc(20))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(newestProxy, Buffer.alloc(20))
    await writeFile(activeProxy, Buffer.alloc(20))
    await pruneProxyCache(directory, 20, newestProxy)
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['new.mp4', '.key.job.partial.mp4']))
    expect(await readdir(directory)).toHaveLength(2)
  })

  it('bounds proxy decoder, filter, and encoder threads', () => {
    const args = proxyArgs({ path: '/video.mp4', fps: 59.94 }, '/cache/proxy.partial.mp4')
    expect(args).toEqual([
      '-hide_banner', '-y', '-threads', '2', '-i', '/video.mp4',
      '-map', '0:v:0', '-map', '0:a:0?', '-filter_threads', '4', '-vf', proxyVideoFilter(),
      '-c:v', 'libx264', '-threads', '4', '-preset', 'ultrafast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '/cache/proxy.partial.mp4'
    ])
  })

  it('deduplicates in-flight proxies by key and retries failed jobs', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'otc-proxy-cache-'))
    directories.push(cacheRoot)
    const previousCacheRoot = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = cacheRoot
    const metadata = {
      path: '/video.mp4', name: 'video.mp4', size: 100, modifiedAt: 1, duration: 10,
      width: 1920, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: true
    }
    jobsMock.run.mockRejectedValue(new Error('proxy failed'))
    try {
      const first = createProxy(metadata)
      const duplicate = createProxy(metadata)
      const different = createProxy({ ...metadata, path: '/other.mp4', name: 'other.mp4' })
      await expect(first).rejects.toThrow('proxy failed')
      await expect(duplicate).rejects.toThrow('proxy failed')
      await expect(different).rejects.toThrow('proxy failed')
      expect(jobsMock.run).toHaveBeenCalledTimes(2)

      await expect(createProxy(metadata)).rejects.toThrow('proxy failed')
      expect(jobsMock.run).toHaveBeenCalledTimes(3)
    } finally {
      if (previousCacheRoot === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = previousCacheRoot
    }
  })

  it('serializes proxy generation across distinct cache keys', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'otc-proxy-serial-'))
    directories.push(cacheRoot)
    const previousCacheRoot = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = cacheRoot
    const metadata = {
      path: '/video.mp4', name: 'video.mp4', size: 100, modifiedAt: 1, duration: 10,
      width: 1920, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: true
    }
    let releaseFirst!: () => void
    let rejectSecond!: (error: Error) => void
    jobsMock.run
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve }))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSecond = reject }))
    try {
      const first = createProxy(metadata)
      const second = createProxy({ ...metadata, path: '/other.mp4', name: 'other.mp4' })
      await vi.waitFor(() => expect(jobsMock.run).toHaveBeenCalledTimes(1))

      releaseFirst()
      await expect(first).rejects.toThrow('generated playback proxy is invalid')
      await vi.waitFor(() => expect(jobsMock.run).toHaveBeenCalledTimes(2))
      rejectSecond(new Error('proxy failed'))
      await expect(second).rejects.toThrow('proxy failed')
    } finally {
      if (previousCacheRoot === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = previousCacheRoot
    }
  })

  it('generates and atomically publishes a validated GIF-compatible proxy', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'otc-proxy-gif-'))
    directories.push(cacheRoot)
    const previousCacheRoot = process.env.XDG_CACHE_HOME
    const previousExecFile = childProcess.execFile.getMockImplementation()
    process.env.XDG_CACHE_HOME = cacheRoot
    childProcess.execFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        result: { stdout: Buffer; stderr: string }
      ) => void
      callback(null, {
        stdout: Buffer.from(JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video' }] })),
        stderr: ''
      })
    })
    jobsMock.run.mockImplementation(async (_executable: string, args: string[]) => {
      const temporaryPath = args.at(-1)
      if (typeof temporaryPath !== 'string') throw new Error('Missing proxy path')
      await writeFile(temporaryPath, Buffer.alloc(2048))
    })
    const metadata = {
      path: '/video.mp4', name: 'video.mp4', size: 100, modifiedAt: 1, duration: 10,
      width: 1920, height: 1080, fps: 30, videoCodec: 'hevc', hasAudio: true
    }
    try {
      const result = await createProxy(metadata)
      expect(result).toMatch(/\.mp4$/)
      expect(jobsMock.run).toHaveBeenCalledWith(
        '/ffmpeg', expect.any(Array), 'proxy', 10, expect.any(String)
      )
      expect(await readdir(join(cacheRoot, 'otc', 'proxies'))).toEqual([result.split('/').at(-1)])
    } finally {
      if (previousCacheRoot === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = previousCacheRoot
      if (previousExecFile) childProcess.execFile.mockImplementation(previousExecFile)
      else childProcess.execFile.mockReset()
    }
  })

  it('finishes the active proxy and rejects queued work during shutdown', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'otc-proxy-shutdown-'))
    directories.push(cacheRoot)
    const previousCacheRoot = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = cacheRoot
    const previousExecFile = childProcess.execFile.getMockImplementation()
    childProcess.execFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        result: { stdout: Buffer; stderr: string }
      ) => void
      callback(null, {
        stdout: Buffer.from(JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video' }] })),
        stderr: ''
      })
    })
    const metadata = {
      path: '/video.mp4', name: 'video.mp4', size: 100, modifiedAt: 1, duration: 10,
      width: 1920, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: true
    }
    let releaseFirst!: () => void
    jobsMock.run.mockImplementationOnce(async (_executable: string, args: string[]) => {
      await new Promise<void>((resolve) => { releaseFirst = resolve })
      const temporaryPath = args.at(-1)
      if (typeof temporaryPath !== 'string') throw new Error('Missing proxy path')
      await writeFile(temporaryPath, Buffer.alloc(2048))
    })
    try {
      const first = createProxy(metadata)
      const second = createProxy({ ...metadata, path: '/other.mp4', name: 'other.mp4' })
      await vi.waitFor(() => expect(jobsMock.run).toHaveBeenCalledTimes(1))
      const shutdown = shutdownProxyJobs()
      const firstResult = expect(first).resolves.toMatch(/\.mp4$/)
      const queuedFailure = expect(second).rejects.toThrow('shutdown')

      releaseFirst()
      await firstResult
      await queuedFailure
      await shutdown
      expect(jobsMock.run).toHaveBeenCalledTimes(1)
    } finally {
      if (previousExecFile === undefined) childProcess.execFile.mockReset()
      else childProcess.execFile.mockImplementation(previousExecFile)
      if (previousCacheRoot === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = previousCacheRoot
    }
  })

  it('invalidates a proxy when the source file modification time changes', () => {
    const metadata = {
      path: '/video.mp4', name: 'video.mp4', size: 100, modifiedAt: 1, duration: 10,
      width: 1920, height: 1080, fps: 30, videoCodec: 'h264',
      hasAudio: true
    }
    expect(proxyCacheKey(metadata)).not.toBe(proxyCacheKey({ ...metadata, modifiedAt: 2 }))
  })

  it('skips unusable probe candidates and bounds portrait proxies', () => {
    expect(firstPositiveNumber('N/A', '12.5')).toBe(12.5)
    expect(firstPositiveNumber(null, 1234)).toBe(1234)
    expect(firstFrameRate('0/0', '60/1')).toBe(60)
    expect(proxyVideoFilter()).toBe('scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2')
  })

  it('returns no waveform for a missing file and retries when it appears', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-waveform-'))
    directories.push(directory)
    const path = join(directory, 'missing.wav')
    const before = childProcess.execFile.mock.calls.length
    expect(await waveformFor(path)).toEqual([])
    expect(childProcess.execFile.mock.calls).toHaveLength(before)

    await writeFile(path, Buffer.from('audio'))
    const peaks = await waveformFor(path)
    expect(peaks).toHaveLength(1)
    expect(childProcess.execFile.mock.calls).toHaveLength(before + 1)
  })

  it('deduplicates a file waveform and invalidates changed file identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-waveform-'))
    directories.push(directory)
    const path = join(directory, 'audio.wav')
    await writeFile(path, Buffer.from('audio'))
    const before = childProcess.execFile.mock.calls.length
    const [first, second] = await Promise.all([waveformFor(path), waveformFor(path)])
    expect(first).toEqual(second)
    expect(childProcess.execFile.mock.calls).toHaveLength(before + 1)

    await writeFile(path, Buffer.alloc(32))
    await waveformFor(path)
    expect(childProcess.execFile.mock.calls).toHaveLength(before + 2)
  })

  it('evicts empty waveforms so a later attempt can retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-waveform-'))
    directories.push(directory)
    const path = join(directory, 'empty-first.wav')
    await writeFile(path, Buffer.from('audio'))
    childProcess.execFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        result: { stdout: Buffer; stderr: string }
      ) => void
      callback(null, { stdout: Buffer.alloc(0), stderr: '' })
    })
    expect(await waveformFor(path)).toEqual([])
    const beforeRetry = childProcess.execFile.mock.calls.length
    expect(await waveformFor(path)).toHaveLength(1)
    expect(childProcess.execFile.mock.calls).toHaveLength(beforeRetry + 1)
  })

  it('keeps only a bounded FIFO waveform cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-waveform-'))
    directories.push(directory)
    const paths = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const path = join(directory, `${index}.wav`)
      await writeFile(path, Buffer.from([index]))
      return path
    }))
    const before = childProcess.execFile.mock.calls.length
    for (const path of paths) await waveformFor(path)
    expect(childProcess.execFile.mock.calls).toHaveLength(before + paths.length)

    const firstPath = paths[0]
    if (!firstPath) throw new Error('Expected a waveform test path')
    await waveformFor(firstPath)
    expect(childProcess.execFile.mock.calls).toHaveLength(before + paths.length + 1)
  })
})
