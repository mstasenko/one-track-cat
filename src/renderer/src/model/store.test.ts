import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { otcApi, MediaMetadata, SourceSegment, VideoSegment } from '@shared/types'
import { useEditorStore } from './store'
import { savedSession } from './store-session'
import { createSession } from './timeline'

vi.mock('./video-picker', () => ({ chooseVideo: () => window.otc.openVideo() }))

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264',
  hasAudio: true
}

function video(segment: SourceSegment | undefined): VideoSegment {
  if (!segment || segment.kind === 'freeze') throw new Error('video segment missing')
  return segment
}

function api(): otcApi {
  return {
    openVideo: vi.fn().mockResolvedValue('/source.mp4'),
    listVideoDirectory: vi.fn().mockResolvedValue({ path: '/videos', parent: null, entries: [], truncated: false }),
    authorizeVideo: vi.fn().mockResolvedValue('/source.mp4'),
    searchTemplates: vi.fn().mockResolvedValue([]),
    importTemplate: vi.fn().mockResolvedValue({ type: 'image', name: 'template.png', path: '/template.png' }),
    openTemplatePage: vi.fn().mockResolvedValue(undefined),
    openMedia: vi.fn().mockResolvedValue({ path: '/effect.ogg', type: 'audio', name: 'Effect' }),
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

beforeEach(() => {
  Object.defineProperty(window, 'otc', { value: api(), configurable: true })
  useEditorStore.setState({
    initialized: false, session: null, history: [], future: [], gesture: null, assets: [],
    gpu: null, job: null, busy: null, error: null
  })
})

describe('editor store', () => {
  it('initializes diagnostics and assets', async () => {
    await useEditorStore.getState().initialize()
    expect(useEditorStore.getState().initialized).toBe(true)
    expect(useEditorStore.getState().gpu?.videoDecode).toBe('enabled')
  })

  it('does not reload an already initialized project or overwrite its edits', async () => {
    const session = createSession(metadata)
    session.marks = [2]
    const history = [structuredClone(session)]
    useEditorStore.setState({ initialized: true, session, history, future: [] })
    await useEditorStore.getState().initialize()
    expect(window.otc.loadSession).not.toHaveBeenCalled()
    expect(useEditorStore.getState().session).toBe(session)
    expect(useEditorStore.getState().session?.marks).toEqual([2])
    expect(useEditorStore.getState().history).toBe(history)
  })

  it('restores a saved multi-source project and reloads its waveform', async () => {
    const session = createSession(metadata)
    const inserted = { ...metadata, path: '/inserted.mp4', name: 'inserted.mp4' }
    session.sources.push({ id: 'inserted', metadata: inserted, playbackPath: inserted.path, waveform: [] })
    vi.mocked(window.otc.loadSession).mockResolvedValue(savedSession(session))
    await useEditorStore.getState().initialize()
    await vi.waitFor(() => expect(useEditorStore.getState().session?.sources[0]?.waveform).toEqual([0.1, 0.8]))
    expect(useEditorStore.getState().session?.sources.map((source) => source.playbackPath)).toEqual([
      'media:/source.mp4', 'media:/inserted.mp4'
    ])
  })

  it('restores bounded undo and redo history', async () => {
    const previous = createSession(metadata)
    const current = structuredClone(previous)
    current.marks = [2]
    const future = structuredClone(current)
    future.marks = [2, 4]
    vi.mocked(window.otc.loadSession).mockResolvedValue(savedSession(current, [previous], [future]))

    await useEditorStore.getState().initialize()
    expect(useEditorStore.getState()).toMatchObject({ history: [{ marks: [] }], future: [{ marks: [2, 4] }] })
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.marks).toEqual([])
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session?.marks).toEqual([2])
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session?.marks).toEqual([2, 4])
  })

  it('inserts a video at the playhead and undoes the ripple edit', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    useEditorStore.getState().setPlayhead(4)
    const inserted = { ...metadata, path: '/inserted.mp4', name: 'inserted.mp4', duration: 2 }
    vi.mocked(window.otc.openVideo).mockResolvedValue('/inserted.mp4')
    vi.mocked(window.otc.probe).mockResolvedValueOnce(inserted)
    await useEditorStore.getState().insertVideo({
      into: { effect: 'dissolve', duration: 0.5 },
      back: { effect: 'slideleft', duration: 0.75 }
    })
    const session = useEditorStore.getState().session
    expect(session?.sources).toHaveLength(2)
    expect(session?.segments.map((segment) => video(segment).sourceEnd - video(segment).sourceStart)).toEqual([3.5, 1.25, 6])
    expect(session?.segments[1]?.sourceId).toBe(session?.sources[1]?.id)
    expect(video(session?.segments[1]).transition).toEqual({ effect: 'dissolve', duration: 0.5 })
    expect(video(session?.segments[2]).transition).toEqual({ effect: 'slideleft', duration: 0.75 })
    expect(session?.playhead).toBe(4.75)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.segments).toHaveLength(1)
  })

  it('handles cancelled and failed insertions', async () => {
    vi.mocked(window.otc.openVideo).mockResolvedValueOnce(null)
    await useEditorStore.getState().insertVideo()
    expect(useEditorStore.getState().session).toBeNull()

    await useEditorStore.getState().loadVideo('/source.mp4')
    const inserted = { ...metadata, path: '/inserted.mp4', name: 'inserted.mp4', duration: 2 }
    vi.mocked(window.otc.openVideo).mockResolvedValue('/inserted.mp4')
    vi.mocked(window.otc.probe).mockResolvedValueOnce(inserted)
    await useEditorStore.getState().insertVideo()
    expect(useEditorStore.getState().session?.sources[1]?.playbackPath).toBe('media:/inserted.mp4')

    vi.mocked(window.otc.probe).mockRejectedValueOnce(new Error('bad video'))
    await useEditorStore.getState().insertVideo()
    expect(useEditorStore.getState().error).toBe('OneTrackCat could not insert this video. Try another file.')
  })

  it('opens a Short project and resets saved and in-memory state', async () => {
    await useEditorStore.getState().openShort()
    expect(useEditorStore.getState().session?.canvas).toEqual({ width: 1080, height: 1920, fps: 30, fit: 'cover' })
    await useEditorStore.getState().resetProject()
    expect(window.otc.resetSession).toHaveBeenCalledOnce()
    expect(useEditorStore.getState().session).toBeNull()
  })

  it('reports rejected insert, media, and reset requests', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    vi.mocked(window.otc.openVideo).mockRejectedValueOnce(new Error('dialog failed'))
    await useEditorStore.getState().insertVideo()
    expect(useEditorStore.getState().error).toBe('OneTrackCat could not insert this video. Try another file.')

    vi.mocked(window.otc.openMedia).mockRejectedValueOnce(new Error('dialog failed'))
    await useEditorStore.getState().addExternalMedia()
    expect(useEditorStore.getState().error).toBe('OneTrackCat could not add this item. Try another file.')

    vi.mocked(window.otc.resetSession).mockRejectedValueOnce(new Error('reset failed'))
    await useEditorStore.getState().resetProject()
    expect(useEditorStore.getState().session).not.toBeNull()
    expect(useEditorStore.getState().error).toBe('OneTrackCat could not reset this project. Try again.')
  })

  it('loads media, edits the timeline, and supports undo/redo', async () => {
    const store = useEditorStore.getState()
    await store.loadVideo()
    expect(useEditorStore.getState().session?.sources[0]?.playbackPath).toBe('media:/source.mp4')
    await vi.waitFor(() => expect(useEditorStore.getState().session?.sources[0]?.waveform).toEqual([0.1, 0.8]))
    useEditorStore.getState().setPlayhead(4)
    useEditorStore.getState().addMark()
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.marks).toEqual([])
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session?.marks).toEqual([4])
    useEditorStore.getState().setPlayhead(6)
    useEditorStore.getState().addMark()
    useEditorStore.getState().removeMarked()
    expect(video(useEditorStore.getState().session?.segments[0]).sourceEnd).toBe(4)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.segments).toHaveLength(1)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session?.segments).toHaveLength(2)
  })

  it('adds and edits text and video overlays', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    useEditorStore.getState().addText()
    const text = useEditorStore.getState().session?.overlays[0]
    expect(text?.type).toBe('text')
    if (!text) throw new Error('missing overlay')
    useEditorStore.getState().updateOverlay(text.id, { duration: 5 })
    expect(useEditorStore.getState().session?.overlays[0]?.duration).toBe(5)
    await useEditorStore.getState().addAsset({ type: 'video', name: 'Meme', path: '/meme.mp4' })
    const video = useEditorStore.getState().session?.overlays.at(-1)
    expect(video).toMatchObject({ type: 'video', audioEnabled: false, sourceDuration: 2 })
    useEditorStore.getState().removeSelectedOverlay()
    expect(useEditorStore.getState().session?.overlays).toHaveLength(1)
  })

  it('clears the current mark selection without deleting media', () => {
    const session = createSession(metadata)
    session.marks = [1, 2, 6, 8]
    session.playhead = 4
    useEditorStore.setState({ session, history: [], future: [] })
    const segments = session.segments

    useEditorStore.getState().clearMarks()
    expect(useEditorStore.getState().session?.marks).toEqual([1, 8])
    expect(useEditorStore.getState().session?.segments).toBe(segments)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.marks).toEqual([1, 2, 6, 8])
  })

  it('keeps Appears at fixed when Visible for reaches the timeline end', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    useEditorStore.getState().setPlayhead(8)
    useEditorStore.getState().addText()
    const text = useEditorStore.getState().session?.overlays[0]
    if (!text) throw new Error('text overlay missing')

    useEditorStore.getState().updateOverlay(text.id, { duration: 5 })
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ start: 8, duration: 2 })
  })

  it('keeps added and edited overlays inside the timeline', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    useEditorStore.getState().setPlayhead(9)
    useEditorStore.getState().addText()
    await useEditorStore.getState().addAsset({
      type: 'audio', name: 'Sound', path: '/sound.ogg'
    })
    useEditorStore.getState().setPlayhead(metadata.duration)
    useEditorStore.getState().addText()

    for (const overlay of useEditorStore.getState().session?.overlays ?? []) {
      expect(overlay.duration).toBeGreaterThan(0)
      expect(overlay.start + overlay.duration).toBeLessThanOrEqual(metadata.duration)
    }

    const text = useEditorStore.getState().session?.overlays[0]
    if (!text) throw new Error('text overlay missing')
    useEditorStore.getState().updateOverlay(text.id, { start: metadata.duration })
    const updated = useEditorStore.getState().session?.overlays[0]
    expect((updated?.start ?? Infinity) + (updated?.duration ?? Infinity)).toBeLessThanOrEqual(metadata.duration)
  })

  it('records a drag as one undoable history transaction', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    useEditorStore.getState().addText()
    const overlay = useEditorStore.getState().session?.overlays[0]
    if (!overlay) throw new Error('missing overlay')
    const historyBefore = useEditorStore.getState().history.length
    useEditorStore.getState().beginOverlayGesture()
    for (let x = 0.2; x <= 0.5; x += 0.1) {
      useEditorStore.getState().updateOverlayGesture(overlay.id, { x })
    }
    useEditorStore.getState().commitOverlayGesture()
    expect(useEditorStore.getState().history).toHaveLength(historyBefore + 1)
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ x: 0.5 })
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ x: 0.15 })
  })

  it('cancels gesture previews and ignores empty transactions', async () => {
    const empty = useEditorStore.getState()
    empty.beginOverlayGesture()
    empty.updateOverlayGesture('missing', { start: 2 })
    empty.commitOverlayGesture()
    empty.cancelOverlayGesture()
    await empty.loadVideo('/source.mp4')
    useEditorStore.getState().addText()
    const overlay = useEditorStore.getState().session?.overlays[0]
    if (!overlay) throw new Error('missing overlay')
    const historyBefore = useEditorStore.getState().history.length
    useEditorStore.getState().beginOverlayGesture()
    useEditorStore.getState().commitOverlayGesture()
    expect(useEditorStore.getState().history).toHaveLength(historyBefore)
    useEditorStore.getState().beginOverlayGesture()
    useEditorStore.getState().updateOverlayGesture(overlay.id, { x: 0.7 })
    useEditorStore.getState().cancelOverlayGesture()
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ x: 0.15 })
  })

  it('does not let a slower video load replace a newer project', async () => {
    let finishFirstProbe: (value: MediaMetadata) => void = () => undefined
    const firstProbe = new Promise<MediaMetadata>((resolve) => { finishFirstProbe = resolve })
    const second = { ...metadata, path: '/second.mp4', name: 'second.mp4' }
    vi.mocked(window.otc.probe)
      .mockReturnValueOnce(firstProbe)
      .mockResolvedValueOnce(second)

    const firstLoad = useEditorStore.getState().loadVideo('/first.mp4')
    await vi.waitFor(() => expect(window.otc.probe).toHaveBeenCalledWith('/first.mp4'))
    await useEditorStore.getState().loadVideo('/second.mp4')
    finishFirstProbe({ ...metadata, path: '/first.mp4', name: 'first.mp4' })
    await firstLoad

    expect(useEditorStore.getState().session?.sources[0]?.metadata.path).toBe('/second.mp4')
  })

  it('discards pending media additions when the project is replaced', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    let finishAssetProbe: (value: Awaited<ReturnType<otcApi['probeAsset']>>) => void = () => undefined
    const assetProbe = new Promise<Awaited<ReturnType<otcApi['probeAsset']>>>((resolve) => {
      finishAssetProbe = resolve
    })
    vi.mocked(window.otc.probeAsset).mockReturnValueOnce(assetProbe)

    const addition = useEditorStore.getState().addAsset({
      type: 'image', name: 'Late image', path: '/late.png'
    })
    await vi.waitFor(() => expect(window.otc.probeAsset).toHaveBeenCalledWith('/late.png'))
    await useEditorStore.getState().loadVideo('/replacement.mp4')
    finishAssetProbe({ duration: 3, hasAudio: false })
    await addition

    expect(useEditorStore.getState().session?.overlays).toEqual([])
  })

  it('discards an external media dialog result after the project is replaced', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    let finishSelection: (value: Awaited<ReturnType<otcApi['openMedia']>>) => void = () => undefined
    const selection = new Promise<Awaited<ReturnType<otcApi['openMedia']>>>((resolve) => {
      finishSelection = resolve
    })
    vi.mocked(window.otc.openMedia).mockReturnValueOnce(selection)

    const addition = useEditorStore.getState().addExternalMedia()
    await vi.waitFor(() => expect(window.otc.openMedia).toHaveBeenCalled())
    await useEditorStore.getState().loadVideo('/replacement.mp4')
    finishSelection({ type: 'audio', name: 'Late sound', path: '/late.ogg' })
    await addition

    expect(window.otc.probeAsset).not.toHaveBeenCalledWith('/late.ogg')
    expect(useEditorStore.getState().session?.overlays).toEqual([])
  })

  it('adds external audio assets', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    await useEditorStore.getState().addExternalMedia()
    expect(useEditorStore.getState().session?.overlays[0]?.type).toBe('audio')
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ name: 'Effect', duration: 2 })
  })

  it('covers image, GIF, selection, and playback actions', async () => {
    const empty = useEditorStore.getState()
    empty.setPlayhead(4)
    empty.addMark()
    empty.removeMarked()
    empty.addText()
    empty.selectOverlay('none')
    empty.removeSelectedOverlay()
    empty.undo()
    empty.redo()
    expect(useEditorStore.getState().session).toBeNull()

    await useEditorStore.getState().loadVideo('/source.mp4')
    useEditorStore.getState().setPlayhead(3)
    useEditorStore.getState().addMark()
    useEditorStore.getState().setPlayhead(1)
    useEditorStore.getState().removeMarked()
    expect(video(useEditorStore.getState().session?.segments[0]).sourceStart).toBe(3)
    vi.mocked(window.otc.probeAsset)
      .mockResolvedValueOnce({ duration: 2, hasAudio: false })
      .mockResolvedValueOnce({ duration: 2, hasAudio: false, playbackPath: '/gif-preview.mp4' })
    await useEditorStore.getState().addAsset({ type: 'image', name: 'Image', path: '/image.png' })
    await useEditorStore.getState().addAsset({ type: 'gif', name: 'GIF', path: '/image.gif' })
    expect(useEditorStore.getState().session?.overlays.map((item) => item.type)).toEqual(['image', 'gif'])
    expect(useEditorStore.getState().session?.overlays[1]).toMatchObject({ playbackPath: '/gif-preview.mp4' })
    expect(useEditorStore.getState().session?.selectedOverlayId)
      .toBe(useEditorStore.getState().session?.overlays[1]?.id)
    useEditorStore.getState().selectOverlay(null)
    expect(useEditorStore.getState().session?.selectedOverlayId).toBeNull()
  })

  it('updates status helpers', () => {
    useEditorStore.getState().setJob({ id: 'j', kind: 'export', state: 'running', progress: 0.5, message: '50%' })
    expect(useEditorStore.getState().job?.progress).toBe(0.5)
    useEditorStore.getState().setJob({ id: 'proxy', kind: 'proxy', state: 'running', progress: 0.25, message: '25%' })
    expect(useEditorStore.getState().job).toMatchObject({ id: 'j', progress: 0.5 })
    useEditorStore.setState({ error: 'oops' })
    useEditorStore.getState().clearError()
    expect(useEditorStore.getState().error).toBeNull()
  })

  it('adds and removes focus zooms and freeze frames as undoable edits', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    const store = useEditorStore.getState()
    store.setPlayhead(4)
    const historyWithoutSelection = useEditorStore.getState().history.length
    store.addFocusZoom(1.5, 0.25, 0.75)
    expect(useEditorStore.getState().session?.focusZooms).toEqual([])
    expect(useEditorStore.getState().history).toHaveLength(historyWithoutSelection)
    store.addMark()
    store.setPlayhead(2)
    store.addMark()
    store.setPlayhead(3)
    store.addFocusZoom(1.5, 0.25, 0.75)
    expect(useEditorStore.getState().session?.focusZooms).toHaveLength(1)
    useEditorStore.getState().removeFocusZoom()
    expect(useEditorStore.getState().session?.focusZooms).toEqual([])
    useEditorStore.getState().insertFreeze(1)
    expect(useEditorStore.getState().session?.segments.some((segment) => segment.kind === 'freeze')).toBe(true)
    useEditorStore.getState().removeFreeze()
    expect(useEditorStore.getState().session?.segments.some((segment) => segment.kind === 'freeze')).toBe(false)
  })

  it('inserts and removes Replay as single undoable edits without no-op history', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    const initialHistory = useEditorStore.getState().history.length
    useEditorStore.getState().insertReplay()
    expect(useEditorStore.getState().history).toHaveLength(initialHistory)
    useEditorStore.getState().setPlayhead(2)
    useEditorStore.getState().addMark()
    useEditorStore.getState().setPlayhead(4)
    useEditorStore.getState().addMark()
    useEditorStore.getState().setPlayhead(3)
    const before = structuredClone(useEditorStore.getState().session)
    const historyBeforeReplay = useEditorStore.getState().history.length
    useEditorStore.getState().insertReplay()
    expect(useEditorStore.getState().history).toHaveLength(historyBeforeReplay + 1)
    expect(useEditorStore.getState().session?.segments.some((segment) => segment.replayGroupId)).toBe(true)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session).toEqual(before)
    useEditorStore.getState().redo()
    const historyBeforeRemoval = useEditorStore.getState().history.length
    useEditorStore.getState().removeReplay()
    expect(useEditorStore.getState().history).toHaveLength(historyBeforeRemoval + 1)
    expect(useEditorStore.getState().session?.segments.some((segment) => segment.replayGroupId)).toBe(false)
  })

  it('changes one text animation once and ignores the selected value', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    useEditorStore.getState().addText()
    const text = useEditorStore.getState().session?.overlays[0]
    if (!text) throw new Error('text overlay missing')
    const before = useEditorStore.getState().history.length
    useEditorStore.getState().setTextAnimation(text.id, 'pop')
    expect(useEditorStore.getState().history).toHaveLength(before + 1)
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ animation: 'pop' })
    useEditorStore.getState().setTextAnimation(text.id, 'pop')
    expect(useEditorStore.getState().history).toHaveLength(before + 1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.overlays[0]).not.toHaveProperty('animation')
  })

  it('stores one audio setting change as one undo entry and ignores repeats', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    await useEditorStore.getState().addExternalMedia()
    const overlay = useEditorStore.getState().session?.overlays[0]
    if (!overlay) throw new Error('audio overlay missing')
    const before = useEditorStore.getState().history.length
    useEditorStore.getState().updateOverlay(overlay.id, { fadeIn: 0.25, duckGameAudio: true, gameAudioLevel: 0.3 })
    expect(useEditorStore.getState().history).toHaveLength(before + 1)
    useEditorStore.getState().updateOverlay(overlay.id, { fadeIn: 0.25, duckGameAudio: true, gameAudioLevel: 0.3 })
    expect(useEditorStore.getState().history).toHaveLength(before + 1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.overlays[0]).not.toHaveProperty('fadeIn')
  })

  it('changes Speed only for a highlighted marked partition', async () => {
    await useEditorStore.getState().loadVideo('/source.mp4')
    const before = useEditorStore.getState().history.length
    useEditorStore.getState().setSpeed(0.5)
    expect(useEditorStore.getState().history).toHaveLength(before)
    expect(video(useEditorStore.getState().session?.segments[0]).playbackRate).toBeUndefined()
    useEditorStore.getState().setPlayhead(2)
    useEditorStore.getState().addMark()
    useEditorStore.getState().setPlayhead(1)
    useEditorStore.getState().setSpeed(0.5)
    expect(video(useEditorStore.getState().session?.segments[0]).playbackRate).toBe(0.5)
  })

  it('reports API failures without losing the source', async () => {
    vi.mocked(window.otc.getGpuDiagnostics).mockRejectedValueOnce(new Error('GPU failure'))
    await useEditorStore.getState().initialize()
    expect(useEditorStore.getState().error).toBe('OneTrackCat could not finish starting. Close it and try again.')

    vi.mocked(window.otc.probe).mockRejectedValueOnce('probe failure')
    await useEditorStore.getState().loadVideo('/bad.mp4')
    expect(useEditorStore.getState().error).toBe('OneTrackCat could not open this video. Try another file.')

    await useEditorStore.getState().loadVideo('/source.mp4')
    expect(useEditorStore.getState().session?.sources[0]?.playbackPath).toBe('media:/source.mp4')

    vi.mocked(window.otc.probeAsset).mockRejectedValueOnce(new Error('bad asset'))
    await useEditorStore.getState().addAsset({ type: 'image', name: 'Bad', path: '/bad.png' })
    expect(useEditorStore.getState().error).toBe('OneTrackCat could not add this item. Try another file.')
  })
})
