import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, otcApi } from './types'
import type { VideoDirectory } from './video-picker'
import type { OnlineTemplate } from './online-templates'

const listeners = new Map<string, () => void>()
const send = vi.fn()
const invoke = vi.fn()
let exposedApi: otcApi
let exposedName = ''

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: otcApi) => {
    exposedName = name
    exposedApi = api
  } },
  ipcRenderer: {
    invoke,
    on: vi.fn((channel: string, listener: () => void) => listeners.set(channel, listener)),
    removeListener: vi.fn(),
    send
  },
  webUtils: { getPathForFile: vi.fn() }
}))

beforeAll(async () => { await import('./preload') })
beforeEach(() => {
  send.mockClear()
  invoke.mockClear()
})

describe('close-time session saving', () => {
  it('exposes the OneTrackCat bridge name', () => {
    expect(exposedName).toBe('otc')
  })

  it('approves closing only after persistence succeeds', async () => {
    exposedApi.onSaveRequest(() => Promise.resolve())
    listeners.get('session:save-request')?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(send).toHaveBeenCalledWith('session:close-ready')
    expect(send).not.toHaveBeenCalledWith('session:close-failed', expect.anything())
  })

  it('does not approve closing when persistence fails', async () => {
    exposedApi.onSaveRequest(() => Promise.reject(new Error('disk full')))
    listeners.get('session:save-request')?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(send).not.toHaveBeenCalledWith('session:close-ready')
    expect(send).toHaveBeenCalledWith('session:close-failed', 'disk full')
  })
})

describe('face preview restoration bridge', () => {
  it('invokes the read-only restoration channel', async () => {
    const request = {
      outputPath: '',
      canvas: { width: 320, height: 180, fps: 30, fit: 'contain' as const },
      sources: [], segments: [], overlays: [], focusZooms: [], faceBlurs: []
    } satisfies ExportRequest
    invoke.mockResolvedValueOnce([{ url: 'media://preview', start: 0, end: 10 }])
    await expect(exposedApi.restoreFacePreview(request)).resolves.toEqual([{
      url: 'media://preview', start: 0, end: 10
    }])
    expect(invoke).toHaveBeenCalledWith('faces:restore', request)
  })
})

describe('video picker bridge', () => {
  it('forwards directory listing requests to the video channel', async () => {
    const directory: VideoDirectory = { path: '/videos', parent: null, entries: [], truncated: false }
    invoke.mockResolvedValueOnce(directory)

    await expect(exposedApi.listVideoDirectory('/videos')).resolves.toEqual(directory)
    expect(invoke).toHaveBeenCalledWith('video:list', '/videos')
  })

  it('forwards video authorization through the existing media channel', async () => {
    invoke.mockResolvedValueOnce('/videos/clip.mp4')

    await expect(exposedApi.authorizeVideo('/videos/clip.mp4')).resolves.toBe('/videos/clip.mp4')
    expect(invoke).toHaveBeenCalledWith('media:authorize-drop', '/videos/clip.mp4')
  })
})

describe('online template bridge', () => {
  it('forwards template searches with source, category, and query', async () => {
    const templates: OnlineTemplate[] = [{ id: '123', source: 'imgflip', name: 'Cat', type: 'image', url: 'https://i.imgflip.com/123.png' }]
    invoke.mockResolvedValueOnce(templates)

    await expect(exposedApi.searchTemplates('imgflip', 'image', 'cat')).resolves.toEqual(templates)
    expect(invoke).toHaveBeenCalledWith('templates:search', 'imgflip', 'image', 'cat')
  })

  it('forwards template imports and page links to their channels', async () => {
    const asset = { type: 'image' as const, name: 'Cat', path: '/imported/cat.png' }
    invoke.mockResolvedValueOnce(asset)
    await expect(exposedApi.importTemplate('imgflip', '123')).resolves.toEqual(asset)
    expect(invoke).toHaveBeenCalledWith('templates:import', 'imgflip', '123')

    invoke.mockResolvedValueOnce(undefined)
    await exposedApi.openTemplatePage('imgflip', '123')
    expect(invoke).toHaveBeenCalledWith('templates:open-page', 'imgflip', '123')
  })
})
