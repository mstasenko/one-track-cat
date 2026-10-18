import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { otcApi, MediaMetadata } from '@shared/types'
import { useEditorStore } from './store'
import { savedSession } from './store-session'
import { createSession } from './timeline'

vi.mock('./video-picker', () => ({ chooseVideo: () => window.otc.openVideo() }))

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

function api(): otcApi {
  return {
    openVideo: vi.fn().mockResolvedValue('/source.mp4'),
    openVideoPath: vi.fn().mockResolvedValue('/source.mp4'),
    listVideoDirectory: vi.fn().mockResolvedValue({ path: '/videos', parent: null, entries: [], truncated: false }),
    authorizeVideo: vi.fn().mockResolvedValue('/source.mp4'), searchTemplates: vi.fn().mockResolvedValue([]),
    importTemplate: vi.fn().mockResolvedValue({ type: 'image', name: 'template.png', path: '/template.png' }),
    openTemplatePage: vi.fn().mockResolvedValue(undefined),
    openMedia: vi.fn().mockResolvedValue({ path: '/effect.ogg', type: 'audio', name: 'Effect' }),
    probe: vi.fn().mockResolvedValue(metadata), probeAsset: vi.fn().mockResolvedValue({ duration: 2, hasAudio: true }),
    waveform: vi.fn().mockResolvedValue([0.1, 0.8]), scanAssets: vi.fn().mockResolvedValue([]),
    chooseExportPath: vi.fn().mockResolvedValue('/output.mp4'), exportVideo: vi.fn().mockResolvedValue(undefined),
    facePackStatus: vi.fn().mockResolvedValue({ available: false, message: 'Face model pack unavailable' }),
    previewFaces: vi.fn().mockResolvedValue('/preview.mp4'), restoreFacePreview: vi.fn().mockResolvedValue([]),
    loadSession: vi.fn().mockResolvedValue(null), saveSession: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined), clearFaceCache: vi.fn().mockResolvedValue(undefined),
    cancelJob: vi.fn().mockResolvedValue(true),
    getGpuDiagnostics: vi.fn().mockResolvedValue({ hardwareAcceleration: true, videoDecode: 'enabled', gpuCompositing: 'enabled' }),
    getPathUrl: vi.fn((path: string) => Promise.resolve(`media:${path}`)),
    getSvgDataUrl: vi.fn((path: string) => Promise.resolve(`data:image/svg+xml,${path}`)),
    getDroppedPath: vi.fn().mockResolvedValue('/drop.mp4'),
    onOpenPath: vi.fn(() => () => undefined), onResetProject: vi.fn(() => () => undefined),
    onJobProgress: vi.fn(() => () => undefined), onSaveRequest: vi.fn(() => () => undefined)
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'otc', { value: api(), configurable: true })
  useEditorStore.setState({
    initialized: false, session: null, history: [], future: [], gesture: null, assets: [],
    gpu: null, job: null, busy: null, error: null
  })
})

describe('face preview cache lifecycle in the editor store', () => {
  it('retains previews when restoring a saved project', async () => {
    const session = createSession(metadata)
    vi.mocked(window.otc.loadSession).mockResolvedValue(savedSession(session))
    await useEditorStore.getState().initialize()
    await vi.waitFor(() => expect(useEditorStore.getState().session?.sources[0]?.waveform).toEqual([0.1, 0.8]))
    expect(window.otc.clearFaceCache).not.toHaveBeenCalled()
  })

  it('clears face cache after a new video is probed and before switching sessions', async () => {
    const previous = createSession({ ...metadata, path: '/previous.mp4', name: 'previous.mp4' })
    useEditorStore.setState({ session: previous, history: [], future: [] })
    const next = { ...metadata, path: '/next.mp4', name: 'next.mp4' }
    vi.mocked(window.otc.probe).mockResolvedValueOnce(next)
    vi.mocked(window.otc.clearFaceCache).mockImplementationOnce(() => {
      expect(useEditorStore.getState().session).toBe(previous)
      return Promise.resolve()
    })

    await useEditorStore.getState().loadVideo('/next.mp4')

    expect(window.otc.clearFaceCache).toHaveBeenCalledOnce()
    expect(useEditorStore.getState().session?.sources[0]?.metadata.path).toBe('/next.mp4')
  })

  it('does not clear face cache when opening is cancelled or probing fails', async () => {
    vi.mocked(window.otc.openVideo).mockResolvedValueOnce(null)
    await useEditorStore.getState().loadVideo()
    expect(window.otc.clearFaceCache).not.toHaveBeenCalled()

    vi.mocked(window.otc.probe).mockRejectedValueOnce(new Error('bad video'))
    await useEditorStore.getState().loadVideo('/bad.mp4')
    expect(window.otc.clearFaceCache).not.toHaveBeenCalled()
  })
})
