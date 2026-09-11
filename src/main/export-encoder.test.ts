import { afterEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({ app: { isPackaged: false } }))
const binaryMocks = vi.hoisted(() => ({
  ffmpegPath: vi.fn(() => '/bundled/ffmpeg'),
  hardwareFfmpegCandidates: vi.fn(() => [
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', `${process.cwd()}/dist/ffmpeg-vaapi/ffmpeg`,
    `${process.cwd()}/node_modules/ffmpeg-static/ffmpeg`
  ])
}))
const fsMocks = vi.hoisted(() => ({ access: vi.fn(), readdir: vi.fn(), readFile: vi.fn() }))
vi.mock('electron', () => electronMock)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: { ...actual, access: fsMocks.access, readdir: fsMocks.readdir, readFile: fsMocks.readFile },
    access: fsMocks.access, readdir: fsMocks.readdir, readFile: fsMocks.readFile
  }
})
vi.mock('./binaries', () => binaryMocks)

import { exportEncoders, hardwareFfmpegCandidates, hardwareLabelForRenderNode, integratedDecodeDevice, rankRenderDevices, softwareEncoder, vaapiCodecOutput, vaapiProbeArgs } from './export-encoder'

afterEach(() => {
  electronMock.app.isPackaged = false
  binaryMocks.hardwareFfmpegCandidates.mockReturnValue([
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', `${process.cwd()}/dist/ffmpeg-vaapi/ffmpeg`,
    `${process.cwd()}/node_modules/ffmpeg-static/ffmpeg`
  ])
  fsMocks.readFile.mockReset()
  fsMocks.access.mockReset()
  fsMocks.readdir.mockReset()
  vi.unstubAllEnvs()
})

describe('export encoder', () => {
  it('uses only software encoding when CPU-only testing is requested', async () => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    const encoders = await exportEncoders()
    expect(encoders).toHaveLength(1)
    const encoder = encoders[0]
    expect(encoder).toBeDefined()
    expect(encoder).toMatchObject({
      executable: '/bundled/ffmpeg',
      input: [],
      filterSuffix: '',
      output: softwareEncoder().output
    })
    expect(encoder?.videoLabel('test')).toBe('test')
  })
  it('uses the fast high-quality bounded-thread fallback', () => {
    const encoder = softwareEncoder()
    expect(encoder.executable).toBe('/bundled/ffmpeg')
    expect(encoder.output).toContain('veryfast')
    expect(encoder.output).toContain('16')
    expect(encoder.output.slice(encoder.output.indexOf('-threads'))).toEqual(expect.arrayContaining(['4']))
  })

  it('keeps system-first hardware candidates independent of the software path', () => {
    expect(hardwareFfmpegCandidates()).toEqual([
      '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', `${process.cwd()}/dist/ffmpeg-vaapi/ffmpeg`,
      `${process.cwd()}/node_modules/ffmpeg-static/ffmpeg`
    ])
  })

  it('omits the development VAAPI build from packaged candidates', () => {
    electronMock.app.isPackaged = true
    binaryMocks.hardwareFfmpegCandidates.mockReturnValue(['/bundled/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'])
    expect(hardwareFfmpegCandidates()).toEqual(['/bundled/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'])
  })

  it('probes VAAPI at an AV1-safe video resolution', () => {
    const args = vaapiProbeArgs('/dev/dri/renderD128', 'av1_vaapi')
    expect(args).toContain('color=size=1280x720:duration=0.04')
    expect(args).toEqual(expect.arrayContaining(['-frames:v', '1']))
  })

  it('uses AV1 CQP options while retaining QP options for HEVC and H.264', () => {
    expect(vaapiCodecOutput('av1_vaapi')).toEqual(['-c:v', 'av1_vaapi', '-rc_mode', 'CQP', '-global_quality', '110'])
    expect(vaapiCodecOutput('hevc_vaapi')).toEqual(['-c:v', 'hevc_vaapi', '-qp', '18'])
    expect(vaapiCodecOutput('h264_vaapi')).toEqual(['-c:v', 'h264_vaapi', '-qp', '18'])
    expect(vaapiProbeArgs('/dev/dri/renderD128', 'av1_vaapi')).toEqual(expect.arrayContaining([
      '-rc_mode', 'CQP', '-global_quality', '110'
    ]))
  })

  it('prefers an Intel discrete GPU, then its iGPU, while retaining every render node', () => {
    expect(rankRenderDevices([
      { path: '/dev/dri/renderD129', vendor: '0x1002\n' },
      { path: '/dev/dri/renderD130', vendor: '0x8086\n', pciSlot: '0000:00:02.0' },
      { path: '/dev/dri/renderD131', vendor: '0x8086\n', pciSlot: '0000:03:00.0' },
      { path: '/dev/dri/renderD128', vendor: '0x10de\n' }
    ]).map((device) => device.path)).toEqual([
      '/dev/dri/renderD131',
      '/dev/dri/renderD130',
      '/dev/dri/renderD128',
      '/dev/dri/renderD129'
    ])
  })

  it('labels a render node only from its exact Intel sysfs identity', async () => {
    fsMocks.readFile.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/vendor') ? '0x8086\n' : 'PCI_SLOT_NAME=0000:03:00.0\n'))
    const label = await hardwareLabelForRenderNode('/dev/dri/renderD131')
    expect(label).toBe('dGPU')
    expect(fsMocks.readFile).toHaveBeenNthCalledWith(1, '/sys/class/drm/renderD131/device/vendor', 'utf8')
    expect(fsMocks.readFile).toHaveBeenNthCalledWith(2, '/sys/class/drm/renderD131/device/uevent', 'utf8')

    fsMocks.readFile.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/vendor') ? '0x1002\n' : 'PCI_SLOT_NAME=0000:00:02.0\n'))
    expect(await hardwareLabelForRenderNode('/dev/dri/renderD132')).toBeUndefined()
  })

  it('selects only an accessible Intel integrated GPU for decoding', async () => {
    vi.stubEnv('otc_CPU_ONLY', '0')
    fsMocks.readdir.mockResolvedValue([
      { name: 'renderD128', isCharacterDevice: () => true },
      { name: 'renderD129', isCharacterDevice: () => true }
    ])
    fsMocks.readFile.mockImplementation((path: string) => {
      if (path.endsWith('/vendor')) return Promise.resolve('0x8086\n')
      return Promise.resolve(path.includes('renderD128')
        ? 'PCI_SLOT_NAME=0000:00:02.0\n'
        : 'PCI_SLOT_NAME=0000:03:00.0\n')
    })
    fsMocks.access.mockResolvedValue(undefined)
    await expect(integratedDecodeDevice()).resolves.toBe('/dev/dri/renderD128')
    expect(fsMocks.access).toHaveBeenCalledWith('/dev/dri/renderD128', expect.any(Number))
  })

  it('falls back to CPU decoding when the integrated GPU is inaccessible', async () => {
    vi.stubEnv('otc_CPU_ONLY', '0')
    fsMocks.readdir.mockResolvedValue([{ name: 'renderD128', isCharacterDevice: () => true }])
    fsMocks.readFile.mockImplementation((path: string) => Promise.resolve(
      path.endsWith('/vendor') ? '0x8086\n' : 'PCI_SLOT_NAME=0000:00:02.0\n'
    ))
    fsMocks.access.mockRejectedValue(new Error('permission denied'))
    await expect(integratedDecodeDevice()).resolves.toBeUndefined()
    expect(fsMocks.access).toHaveBeenCalledWith('/dev/dri/renderD128', expect.any(Number))
  })

  it('skips integrated GPU discovery in CPU-only mode', async () => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    await expect(integratedDecodeDevice()).resolves.toBeUndefined()
    expect(fsMocks.readdir).not.toHaveBeenCalled()
    expect(fsMocks.access).not.toHaveBeenCalled()
  })

  it('falls back to CPU decoding when no render devices are available', async () => {
    vi.stubEnv('otc_CPU_ONLY', '0')
    fsMocks.readdir.mockResolvedValue([])
    await expect(integratedDecodeDevice()).resolves.toBeUndefined()
    expect(fsMocks.access).not.toHaveBeenCalled()
  })
})
