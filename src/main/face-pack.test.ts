import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const electronMock = vi.hoisted(() => ({ app: { isPackaged: false, getPath: vi.fn(() => '/apps/otc') } }))
vi.mock('electron', () => electronMock)
import { facePackDirectory, facePackStatus, requireFacePack } from './face-pack'

let directory: string | undefined
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
  electronMock.app.isPackaged = false
  delete process.env.APPIMAGE
})
describe('optional face pack lookup', () => {
  it('uses the development sidecar without loading any inference runtime', () => {
    expect(facePackDirectory()).toBe(join(process.cwd(), 'dist', 'face-pack'))
  })
  it('resolves the packaged sidecar beside the AppImage or executable', () => {
    electronMock.app.isPackaged = true
    process.env.APPIMAGE = '/opt/otc/OneTrackCat.AppImage'
    expect(facePackDirectory()).toBe('/opt/otc/face-pack')
    delete process.env.APPIMAGE
    expect(facePackDirectory()).toBe('/apps/face-pack')
  })
  it('reports missing, unsupported, and incomplete packs clearly', async () => {
    directory = await mkdtemp(join(tmpdir(), 'otc-face-pack-'))
    await expect(requireFacePack(join(directory, 'missing'))).rejects.toThrow('Download otc-face-pack.zip')
    await writeFile(join(directory, 'manifest.json'), '{"format":2}')
    await expect(requireFacePack(directory)).rejects.toThrow('face-pack folder beside')
    await writeFile(join(directory, 'manifest.json'), '{"format":1}')
    await expect(requireFacePack(directory)).rejects.toThrow('requires the optional')
  })
  it('accepts only complete packs with an executable helper', async () => {
    directory = await mkdtemp(join(tmpdir(), 'otc-face-pack-'))
    await mkdir(join(directory, 'lib'))
    for (const name of ['model.xml', 'model.bin', 'otc-face-blur']) await writeFile(join(directory, name), '')
    await writeFile(join(directory, 'manifest.json'), '{"format":1}')
    await expect(requireFacePack(directory)).rejects.toThrow('requires the optional')
    await chmod(join(directory, 'otc-face-blur'), 0o755)
    expect(await requireFacePack(directory)).toEqual({ executable: join(directory, 'otc-face-blur'), model: join(directory, 'model.xml') })
  })
  it('reports unavailable and available status through the default sidecar path', async () => {
    electronMock.app.isPackaged = true
    directory = await mkdtemp(join(tmpdir(), 'otc-face-status-'))
    process.env.APPIMAGE = join(directory, 'OneTrackCat.AppImage')
    const missing = await facePackStatus()
    expect(missing.available).toBe(false)

    const pack = join(directory, 'face-pack')
    await mkdir(pack)
    await writeFile(join(pack, 'manifest.json'), '{"format":1}')
    for (const name of ['model.xml', 'model.bin', 'otc-face-blur']) await writeFile(join(pack, name), '')
    await chmod(join(pack, 'otc-face-blur'), 0o755)
    const available = await facePackStatus()
    expect(available).toEqual({ available: true, message: 'Face pack available. Processing stays on this computer.' })
  })
})
