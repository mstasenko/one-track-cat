import { afterEach, describe, expect, it, vi } from 'vitest'
import { ffmpegEnvironment } from './ffmpeg-environment'

afterEach(() => vi.unstubAllEnvs())

describe('FFmpeg environment', () => {
  it('keeps the default allocator profile and caller environment', () => {
    vi.stubEnv('OTC_FFMPEG_ENV_SENTINEL', 'preserved')
    const before = { ...process.env }
    const environment = ffmpegEnvironment('/usr/bin/ffmpeg')

    expect(environment).toMatchObject({
      ...before,
      MALLOC_ARENA_MAX: '2',
      MALLOC_MMAP_THRESHOLD_: '131072',
      MALLOC_TRIM_THRESHOLD_: '131072'
    })
    expect(process.env).toEqual(before)
  })

  it('uses the decoder frame-reuse profile only when requested', () => {
    const before = { ...process.env }
    const environment = ffmpegEnvironment('/opt/tools/ffmpeg', true)

    expect(environment).toMatchObject({
      ...before,
      MALLOC_ARENA_MAX: '2',
      MALLOC_MMAP_THRESHOLD_: '33554432',
      MALLOC_TRIM_THRESHOLD_: '67108864'
    })
    expect(process.env).toEqual(before)
  })

  it('rejects non-FFmpeg executables', () => {
    expect(ffmpegEnvironment('/usr/bin/ffmpeg-wrapper')).toBeUndefined()
    expect(ffmpegEnvironment('/usr/bin/ffmpeg.exe')).toBeUndefined()
  })

  it('rejects FFmpeg on non-Linux platforms', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
      expect(ffmpegEnvironment('/usr/bin/ffmpeg', true)).toBeUndefined()
    } finally {
      if (descriptor) Object.defineProperty(process, 'platform', descriptor)
    }
  })
})
