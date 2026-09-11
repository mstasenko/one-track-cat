import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaMetadata, otcApi } from '@shared/types'
import { useEditorStore } from './store'
import { createSession } from './timeline'

vi.mock('./video-picker', () => ({ chooseVideo: () => window.otc.openVideo() }))

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function api(): otcApi {
  return {
    openVideo: vi.fn().mockResolvedValue('/source.mp4'),
    listVideoDirectory: vi.fn().mockResolvedValue({ path: '/videos', parent: null, entries: [], truncated: false }),
    authorizeVideo: vi.fn().mockResolvedValue('/source.mp4'),
    searchTemplates: vi.fn().mockResolvedValue([]),
    importTemplate: vi.fn().mockResolvedValue({ type: 'image', name: 'template.png', path: '/template.png' }),
    openTemplatePage: vi.fn().mockResolvedValue(undefined),
    openMedia: vi.fn().mockResolvedValue(null),
    probe: vi.fn().mockResolvedValue(metadata),
    probeAsset: vi.fn().mockResolvedValue({ duration: 2, hasAudio: true }),
    waveform: vi.fn().mockResolvedValue([0.1, 0.8]),
    scanAssets: vi.fn().mockResolvedValue([]),
    chooseExportPath: vi.fn().mockResolvedValue('/output.mp4'),
    exportVideo: vi.fn().mockResolvedValue(undefined),
    facePackStatus: vi.fn().mockResolvedValue({ available: false, message: 'Face model pack unavailable' }),
    previewFaces: vi.fn().mockResolvedValue('/preview.mp4'),
    restoreFacePreview: vi.fn().mockResolvedValue([]),
    loadSession: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    cancelJob: vi.fn().mockResolvedValue(true),
    getGpuDiagnostics: vi.fn().mockResolvedValue({ hardwareAcceleration: true, videoDecode: 'enabled', gpuCompositing: 'enabled' }),
    getPathUrl: vi.fn((path: string) => Promise.resolve(`media:${path}`)),
    getSvgDataUrl: vi.fn((path: string) => Promise.resolve(`data:image/svg+xml,${path}`)),
    getDroppedPath: vi.fn().mockResolvedValue('/drop.mp4'),
    onOpenPath: vi.fn(() => () => undefined),
    onResetProject: vi.fn(() => () => undefined),
    onJobProgress: vi.fn(() => () => undefined),
    onSaveRequest: vi.fn(() => () => undefined)
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

beforeEach(() => {
  Object.defineProperty(window, 'otc', { value: api(), configurable: true })
  useEditorStore.setState({
    initialized: false, session: null, history: [], future: [], gesture: null, assets: [],
    gpu: null, job: null, busy: null, error: null
  })
})

describe('editor history immutability', () => {
  it('shares waveform storage across many edits and preserves frozen snapshots', () => {
    const session = createSession(metadata)
    const waveform = Array.from({ length: 50_000 }, (_, index) => index / 50_000)
    const source = session.sources[0]
    if (!source) throw new Error('source missing')
    source.waveform = waveform
    deepFreeze(session)
    useEditorStore.setState({ session, history: [], future: [] })

    for (let index = 0; index < 50; index += 1) useEditorStore.getState().addText()
    const current = useEditorStore.getState().session
    if (!current) throw new Error('session missing after edits')
    const snapshots = [...useEditorStore.getState().history, current]
    snapshots.forEach(deepFreeze)
    expect(useEditorStore.getState().history).toHaveLength(50)
    expect(new Set(snapshots.map((snapshot) => snapshot.sources[0]?.waveform)).size).toBe(1)

    const beforeUndo = current
    const undoTarget = useEditorStore.getState().history.at(-1)
    if (!undoTarget) throw new Error('undo target missing')
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session).toBe(undoTarget)
    expect(useEditorStore.getState().future[0]).toBe(beforeUndo)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session).toBe(beforeUndo)

    const overlay = beforeUndo.overlays[0]
    if (!overlay || overlay.type === 'audio') throw new Error('visual overlay missing')
    const beforeGesture = useEditorStore.getState().session
    if (!beforeGesture) throw new Error('gesture session missing')
    useEditorStore.getState().beginOverlayGesture()
    expect(useEditorStore.getState().gesture).toBe(beforeGesture)
    useEditorStore.getState().updateOverlayGesture(overlay.id, { x: 0.4 })
    expect(useEditorStore.getState().session).not.toBe(beforeGesture)
    useEditorStore.getState().cancelOverlayGesture()
    expect(useEditorStore.getState().session).toBe(beforeGesture)
    useEditorStore.getState().beginOverlayGesture()
    useEditorStore.getState().updateOverlayGesture(overlay.id, { x: 0.4 })
    useEditorStore.getState().commitOverlayGesture()
    expect(useEditorStore.getState().history.at(-1)).toBe(beforeGesture)
  })

  it('does not add an Undo entry for a normalized no-op', () => {
    const session = createSession(metadata)
    useEditorStore.setState({ session, history: [], future: [] })
    useEditorStore.getState().addText()
    const overlay = useEditorStore.getState().session?.overlays[0]
    if (!overlay || overlay.type === 'audio') throw new Error('visual overlay missing')
    const historyLength = useEditorStore.getState().history.length
    useEditorStore.getState().updateOverlay(overlay.id, { x: overlay.x })
    expect(useEditorStore.getState().history).toHaveLength(historyLength)
  })

  it('serializes only changed session fields during mutation comparison', () => {
    const session = createSession(metadata)
    useEditorStore.setState({ session, history: [], future: [] })
    useEditorStore.getState().addText()
    const current = useEditorStore.getState().session
    if (!current) throw new Error('session missing')
    const sourceArray = current.sources
    const source = current.sources[0]
    if (!source) throw new Error('source missing')
    const stringify = vi.spyOn(JSON, 'stringify')

    const overlay = current.overlays[0]
    if (!overlay || overlay.type === 'audio') throw new Error('visual overlay missing')
    useEditorStore.getState().updateOverlay(overlay.id, { x: 0.4 })
    useEditorStore.getState().setPlayhead(2)
    useEditorStore.getState().addMark()

    expect(stringify.mock.calls.some(([value]) => value === sourceArray || value === source)).toBe(false)
    stringify.mockRestore()
  })

  it('keeps timeline edits safe when their current session is frozen', () => {
    const selectedRange = (): ReturnType<typeof createSession> => {
      const session = createSession(metadata)
      session.marks = [2, 4]
      session.playhead = 3
      return session
    }
    const exercise = (edit: () => void): void => {
      const session = selectedRange()
      deepFreeze(session)
      useEditorStore.setState({ session, history: [], future: [] })
      edit()
      expect(useEditorStore.getState().history).toHaveLength(1)
      expect(useEditorStore.getState().session).not.toBe(session)
    }

    const pointSession = createSession(metadata)
    pointSession.playhead = 2
    deepFreeze(pointSession)
    useEditorStore.setState({ session: pointSession, history: [], future: [] })
    useEditorStore.getState().addMark()
    expect(useEditorStore.getState().history).toHaveLength(1)
    exercise(() => useEditorStore.getState().removeMarked())
    exercise(() => useEditorStore.getState().setSpeed(0.5))
    exercise(() => useEditorStore.getState().addFocusZoom(1.5, 0.5, 0.5))
    exercise(() => useEditorStore.getState().insertFreeze(1))
    exercise(() => useEditorStore.getState().insertReplay())
  })

  it('keeps an earlier Undo snapshot isolated from a delayed waveform patch', async () => {
    const waveform = deferred<number[]>()
    vi.mocked(window.otc.waveform).mockReturnValue(waveform.promise)
    const loading = useEditorStore.getState().loadVideo('/source.mp4')
    await vi.waitFor(() => expect(useEditorStore.getState().session).not.toBeNull())
    useEditorStore.getState().addText()
    const previous = useEditorStore.getState().history.at(-1)
    if (!previous) throw new Error('history snapshot missing')
    deepFreeze(previous)

    waveform.resolve([0.1, 0.8])
    await loading
    await vi.waitFor(() => expect(useEditorStore.getState().session?.sources[0]?.waveform).toEqual([0.1, 0.8]))
    expect(previous.sources[0]?.waveform).toEqual([])
    expect(useEditorStore.getState().session?.sources[0]).not.toBe(previous.sources[0])
  })

})
