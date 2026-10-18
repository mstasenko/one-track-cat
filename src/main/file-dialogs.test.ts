import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPathRegistry } from './path-registry'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), open: vi.fn(), save: vi.fn(), stat: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle }, dialog: { showOpenDialog: mocks.open, showSaveDialog: mocks.save } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const replacement = { ...actual, stat: mocks.stat }
  return { ...replacement, default: replacement }
})
import { registerFileDialogs } from './file-dialogs'

function setup(test: { video?: string; media?: string; output?: string } = {}) {
  const directories = { open: '/videos', media: '/media', export: '/exports' }
  const allowRead = vi.fn((path: string) => Promise.resolve(path))
  const allowWrite = vi.fn((path: string) => Promise.resolve(path))
  registerFileDialogs(directories, { allowRead, allowWrite } as unknown as SessionPathRegistry, test)
  const handler = (name: string): ((event?: unknown, value?: unknown, destination?: unknown) => Promise<unknown>) =>
    mocks.handle.mock.calls.find(([channel]) => channel === name)?.[1] as (event?: unknown, value?: unknown, destination?: unknown) => Promise<unknown>
  return { directories, allowRead, allowWrite, handler }
}

describe('file dialogs preserve authorized paths', () => {
  beforeEach(() => vi.resetAllMocks())

  it('joins an existing directory with the validated export name', async () => {
    mocks.stat.mockResolvedValue({ isDirectory: () => true })
    const context = setup()
    await expect(context.handler('dialog:export-path')(undefined, 'clip.mp4', '/chosen')).resolves.toBe('/chosen/clip.mp4')
    expect(context.allowWrite).toHaveBeenCalledWith('/chosen/clip.mp4')
    expect(context.directories.export).toBe('/chosen')
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('accepts an existing file or a missing destination but propagates other stat errors', async () => {
    const context = setup()
    const exportPath = context.handler('dialog:export-path')
    mocks.stat.mockResolvedValueOnce({ isDirectory: () => false })
    await expect(exportPath(undefined, 'clip.mp4', '/chosen/existing.mp4')).resolves.toBe('/chosen/existing.mp4')
    mocks.stat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(exportPath(undefined, 'clip.mp4', '/chosen/new.mp4')).resolves.toBe('/chosen/new.mp4')
    mocks.stat.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(exportPath(undefined, 'clip.mp4', '/denied')).rejects.toThrow('denied')
    expect(context.allowWrite).toHaveBeenCalledTimes(2)
  })

  it('validates names and requested paths before granting write access', async () => {
    const context = setup()
    await expect(context.handler('dialog:export-path')(undefined, '../bad.mp4', '/chosen')).rejects.toThrow('MP4 filename')
    await expect(context.handler('dialog:export-path')(undefined, 'clip.mp4', 12)).rejects.toThrow('Path')
    expect(context.allowWrite).not.toHaveBeenCalled()
  })

  it('authorizes a saved path and leaves directory unchanged on cancellation', async () => {
    const context = setup()
    mocks.save.mockResolvedValueOnce({ filePath: '/chosen/saved.mp4' }).mockResolvedValueOnce({})
    await expect(context.handler('dialog:export-path')(undefined, 'clip.mp4')).resolves.toBe('/chosen/saved.mp4')
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '/exports/clip.mp4' }))
    await expect(context.handler('dialog:export-path')(undefined, 'clip.mp4')).resolves.toBeNull()
    expect(context.directories.export).toBe('/chosen')
    expect(context.allowWrite).toHaveBeenCalledTimes(1)
  })

  it('preserves the test output override without opening a dialog or changing the export directory', async () => {
    const context = setup({ output: '/test/output.mp4' })
    await expect(context.handler('dialog:export-path')(undefined, 'clip.mp4', '/ignored')).resolves.toBe('/test/output.mp4')
    expect(context.directories.export).toBe('/exports')
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('authorizes video and recognized media selections before updating their directories', async () => {
    const context = setup()
    mocks.open.mockResolvedValueOnce({ filePaths: ['/chosen/video.mp4'] }).mockResolvedValueOnce({ filePaths: ['/chosen/image.png'] })
    await expect(context.handler('dialog:open-video')()).resolves.toBe('/chosen/video.mp4')
    await expect(context.handler('dialog:open-media')()).resolves.toEqual({ path: '/chosen/image.png', type: 'image', name: 'image' })
    expect(context.directories.open).toBe('/chosen')
    expect(context.directories.media).toBe('/chosen')
    expect(context.allowRead).toHaveBeenCalledTimes(2)
  })

  it('returns null for canceled or unsupported selections without authorizing them', async () => {
    const context = setup()
    mocks.open.mockResolvedValueOnce({ filePaths: [] }).mockResolvedValueOnce({ filePaths: [] }).mockResolvedValueOnce({ filePaths: ['/chosen/unknown.xyz'] })
    await expect(context.handler('dialog:open-video')()).resolves.toBeNull()
    await expect(context.handler('dialog:open-media')()).resolves.toBeNull()
    await expect(context.handler('dialog:open-media')()).resolves.toBeNull()
    expect(context.allowRead).not.toHaveBeenCalled()
  })

  it('uses headless input paths and propagates authorization failures', async () => {
    const context = setup({ video: '/test/video.mp4', media: '/test/image.png' })
    await expect(context.handler('dialog:open-video')()).resolves.toBe('/test/video.mp4')
    context.allowRead.mockRejectedValueOnce(new Error('unauthorized'))
    await expect(context.handler('dialog:open-media')()).rejects.toThrow('unauthorized')
    expect(context.directories.media).toBe('/media')
    expect(mocks.open).not.toHaveBeenCalled()
  })
})
