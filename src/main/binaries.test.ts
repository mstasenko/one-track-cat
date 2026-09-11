import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  app: { isPackaged: true, getPath: vi.fn(() => '/tmp/app') }
}))
const fsMocks = vi.hoisted(() => ({
  accessSync: vi.fn()
}))

vi.mock('electron', () => electronMock)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const replacement = { ...actual, ...fsMocks }
  return { ...replacement, default: replacement }
})

import { bundledMemePath, ffmpegPath, ffprobePath, hardwareFfmpegCandidates, sidecarMemePath } from './binaries'

beforeEach(() => {
  electronMock.app.isPackaged = true
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/tmp/otc-resources' })
  fsMocks.accessSync.mockReset()
})

afterEach(() => vi.unstubAllEnvs())

describe('media sidecar location', () => {
  it('places the meme directory beside the AppImage', () => {
    expect(sidecarMemePath('/tmp/mounted/otc', '/home/sap/Downloads/OneTrackCat.AppImage'))
      .toBe('/home/sap/Downloads/meme')
  })
})

describe('development FFmpeg selection', () => {
  beforeEach(() => { electronMock.app.isPackaged = false })

  it('keeps packaged FFmpeg at the resources path without probing the host', () => {
    electronMock.app.isPackaged = true
    expect(ffmpegPath()).toBe('/tmp/otc-resources/bin/ffmpeg')
    expect(fsMocks.accessSync).not.toHaveBeenCalled()
  })

  it('prefers an executable system FFmpeg in /usr/bin', () => {
    fsMocks.accessSync.mockImplementation((path: string) => {
      if (path !== '/usr/bin/ffmpeg') throw new Error('not selected')
    })
    expect(ffmpegPath()).toBe('/usr/bin/ffmpeg')
    expect(fsMocks.accessSync).toHaveBeenCalledWith('/usr/bin/ffmpeg', expect.any(Number))
  })

  it('tries /usr/local, then the project VAAPI build, before the static fallback', () => {
    fsMocks.accessSync.mockImplementation((path: string) => {
      if (path !== '/usr/local/bin/ffmpeg') throw new Error('not selected')
    })
    expect(ffmpegPath()).toBe('/usr/local/bin/ffmpeg')

    fsMocks.accessSync.mockImplementation((path: string) => {
      if (!path.endsWith('/dist/ffmpeg-vaapi/ffmpeg')) throw new Error('not selected')
    })
    expect(ffmpegPath()).toBe(`${process.cwd()}/dist/ffmpeg-vaapi/ffmpeg`)

    fsMocks.accessSync.mockImplementation(() => { throw new Error('not executable') })
    expect(ffmpegPath()).toBe(`${process.cwd()}/node_modules/ffmpeg-static/ffmpeg`)
  })

  it('skips a present but non-executable system candidate', () => {
    fsMocks.accessSync.mockImplementation((path: string) => {
      if (path === '/usr/bin/ffmpeg') throw new Error('permission denied')
    })
    expect(ffmpegPath()).toBe('/usr/local/bin/ffmpeg')
    expect(fsMocks.accessSync).toHaveBeenCalledWith('/usr/bin/ffmpeg', expect.any(Number))
    expect(fsMocks.accessSync).toHaveBeenCalledWith('/usr/local/bin/ffmpeg', expect.any(Number))
  })

  it('does not let CPU-only mode change the selected binary', () => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    fsMocks.accessSync.mockImplementation((path: string) => {
      if (path !== '/usr/bin/ffmpeg') throw new Error('not selected')
    })
    expect(ffmpegPath()).toBe('/usr/bin/ffmpeg')
  })

  it('centralizes development hardware candidate ordering', () => {
    expect(hardwareFfmpegCandidates()).toEqual([
      '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', `${process.cwd()}/dist/ffmpeg-vaapi/ffmpeg`,
      `${process.cwd()}/node_modules/ffmpeg-static/ffmpeg`
    ])
  })
})

describe('unchanged packaged sidecars', () => {
  it('keeps packaged ffprobe under resources/bin', () => {
    electronMock.app.isPackaged = true
    expect(ffprobePath()).toBe('/tmp/otc-resources/bin/ffprobe')
  })

  it('centralizes packaged hardware candidate ordering', () => {
    expect(hardwareFfmpegCandidates()).toEqual([
      '/tmp/otc-resources/bin/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'
    ])
  })

  it('keeps the development meme directory in the project', () => {
    electronMock.app.isPackaged = false
    expect(bundledMemePath()).toBe(`${process.cwd()}/dist/meme-pack`)
  })
})
