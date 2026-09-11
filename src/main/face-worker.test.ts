import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const replacement = { ...actual, ...fsMocks }
  return { ...replacement, default: replacement }
})

import { buildFaceWorkerCommand, nativeFaceWorkerCommand, restrictedIntelRenderNode } from './face-worker'

const pack = {
  executable: '/host/face-pack/otc-face-blur',
  model: '/host/face-pack/model.xml'
}
const canvas = { width: 1280, height: 720, fps: 30, fit: 'contain' as const }
const nativeArgs = ['--model', pack.model, '--width', '1280', '--height', '720', '--fps', '30', '--effects', '/tmp/faces.tsv']
const linux = vi.spyOn(process, 'platform', 'get')

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('otc_CPU_ONLY', '0')
  vi.clearAllMocks()
  linux.mockReturnValue('linux')
  fsMocks.readdir.mockResolvedValue(['renderD128'])
  fsMocks.readFile.mockResolvedValue('0x8086\n')
  fsMocks.access.mockResolvedValue(undefined)
})

describe('face worker command selection', () => {
  it('builds native worker arguments for either device', () => {
    expect(nativeFaceWorkerCommand(pack, canvas, '/tmp/faces.tsv', 'CPU')).toEqual({
      executable: pack.executable,
      args: [...nativeArgs, '--device', 'CPU']
    })
  })

  it('keeps the native AUTO worker when an Intel render node is accessible', async () => {
    await expect(buildFaceWorkerCommand(pack, canvas, '/tmp/faces.tsv')).resolves.toEqual({
      executable: pack.executable,
      args: [...nativeArgs, '--device', 'AUTO']
    })
    expect(fsMocks.readdir).toHaveBeenCalledWith('/sys/class/drm')
    expect(fsMocks.readFile).toHaveBeenCalledWith('/sys/class/drm/renderD128/device/vendor', 'utf8')
    expect(fsMocks.access).toHaveBeenCalledWith('/dev/dri/renderD128', 6)
  })

  it('keeps native AUTO when the render node is missing', async () => {
    fsMocks.access.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(buildFaceWorkerCommand(pack, canvas, '/tmp/faces.tsv')).resolves.toEqual({
      executable: pack.executable,
      args: [...nativeArgs, '--device', 'AUTO']
    })
    expect(fsMocks.access).toHaveBeenCalledTimes(1)
  })

  it('keeps native AUTO for non-Intel render nodes', async () => {
    fsMocks.readFile.mockResolvedValue('0x1002\n')
    await expect(buildFaceWorkerCommand(pack, canvas, '/tmp/faces.tsv')).resolves.toEqual({
      executable: pack.executable,
      args: [...nativeArgs, '--device', 'AUTO']
    })
    expect(fsMocks.access).not.toHaveBeenCalled()
  })

  it('uses pkexec for a permission-denied Intel render node', async () => {
    fsMocks.access
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    const command = await buildFaceWorkerCommand(pack, canvas, '/tmp/faces.tsv')
    expect(command).toEqual({
      executable: '/usr/bin/pkexec',
      args: ['--disable-internal-agent', pack.executable, ...nativeArgs, '--device', 'AUTO'],
      elevated: true
    })
    expect(fsMocks.access).toHaveBeenCalledTimes(1)
  })

  it('requests pkexec for any denied Intel node even when another Intel node is accessible', async () => {
    fsMocks.readdir.mockResolvedValue(['renderD128', 'renderD129'])
    fsMocks.access
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))
    const command = await buildFaceWorkerCommand(pack, canvas, '/tmp/faces.tsv')
    expect(command.executable).toBe('/usr/bin/pkexec')
    expect(command.elevated).toBe(true)
    expect(fsMocks.access).toHaveBeenNthCalledWith(2, '/dev/dri/renderD129', 6)
  })

  it('does not preflight pkexec after a permission-denied render node', async () => {
    fsMocks.access.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(buildFaceWorkerCommand(pack, canvas, '/tmp/faces.tsv')).resolves.toEqual({
      executable: '/usr/bin/pkexec',
      args: ['--disable-internal-agent', pack.executable, ...nativeArgs, '--device', 'AUTO'],
      elevated: true
    })
    expect(fsMocks.access).toHaveBeenCalledTimes(1)
  })

  it('uses native CPU without probing sysfs in CPU-only mode', async () => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    await expect(buildFaceWorkerCommand(pack, canvas, '/tmp/faces.tsv')).resolves.toEqual({
      executable: pack.executable,
      args: [...nativeArgs, '--device', 'CPU']
    })
    expect(fsMocks.readdir).not.toHaveBeenCalled()
    expect(fsMocks.access).not.toHaveBeenCalled()
    await expect(restrictedIntelRenderNode()).resolves.toBeUndefined()
  })

  it('uses native AUTO without probing sysfs outside Linux', async () => {
    linux.mockReturnValue('darwin')
    await expect(buildFaceWorkerCommand(pack, canvas, '/tmp/faces.tsv')).resolves.toEqual({
      executable: pack.executable,
      args: [...nativeArgs, '--device', 'AUTO']
    })
    expect(fsMocks.readdir).not.toHaveBeenCalled()
    expect(fsMocks.access).not.toHaveBeenCalled()
  })

  it('ignores non-permission access errors and keeps native AUTO', async () => {
    fsMocks.access.mockRejectedValueOnce(Object.assign(new Error('I/O error'), { code: 'EIO' }))
    await expect(buildFaceWorkerCommand(pack, canvas, '/tmp/faces.tsv')).resolves.toEqual({
      executable: pack.executable,
      args: [...nativeArgs, '--device', 'AUTO']
    })
    expect(fsMocks.access).toHaveBeenCalledTimes(1)
  })

  it('returns the first denied Intel render node for other workers', async () => {
    fsMocks.readdir.mockResolvedValue(['card0', 'renderD130', 'renderD128'])
    fsMocks.access.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(restrictedIntelRenderNode()).resolves.toBe('/dev/dri/renderD128')
    expect(fsMocks.readFile).toHaveBeenCalledWith('/sys/class/drm/renderD128/device/vendor', 'utf8')
  })
})
