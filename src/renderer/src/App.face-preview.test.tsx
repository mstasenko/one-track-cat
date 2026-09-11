import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockStore, mockStoreHook, workspaceProps, saveCurrentSessionMock, autosaveCallback, startAutosaveMock } = vi.hoisted(() => {
  const store = {
    initialized: true,
    session: null,
    history: [],
    future: [],
    gesture: null,
    assets: [],
    gpu: null,
    job: null,
    busy: null,
    error: null,
    initialize: vi.fn().mockResolvedValue(undefined),
    loadVideo: vi.fn().mockResolvedValue(undefined),
    openShort: vi.fn().mockResolvedValue(undefined),
    resetProject: vi.fn().mockResolvedValue(undefined),
    setJob: vi.fn(),
    showError: vi.fn(),
    setPlayhead: vi.fn(),
    selectOverlay: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    removeSelectedOverlay: vi.fn(),
    addMark: vi.fn(),
    clearMarks: vi.fn(),
    removeMarked: vi.fn(),
    applyFaceBlur: vi.fn(),
    updateFaceBlurSettings: vi.fn(),
    removeFaceBlur: vi.fn()
  }
  const hook = Object.assign(vi.fn(() => store), { getState: vi.fn(() => store) })
  const saveCurrentSession = vi.fn().mockResolvedValue(null)
  const autosave = { current: undefined as (() => void) | undefined }
  const startAutosave = vi.fn((callback: () => void) => {
    autosave.current = callback
    return () => undefined
  })
  return {
    mockStore: store,
    mockStoreHook: hook,
    workspaceProps: { current: undefined as Record<string, unknown> | undefined },
    saveCurrentSessionMock: saveCurrentSession,
    autosaveCallback: autosave,
    startAutosaveMock: startAutosave
  }
})

vi.mock('./model/store', () => ({ useEditorStore: mockStoreHook }))
vi.mock('./session-persistence', () => ({
  saveCurrentSession: saveCurrentSessionMock,
  startAutosave: startAutosaveMock
}))
vi.mock('./components/AppLayout', () => ({
  EditorWorkspace: (props: Record<string, unknown>) => {
    workspaceProps.current = props
    return null
  },
  ExportProgress: () => null,
  GpuWarning: () => null,
  StatusBanners: () => null,
  Welcome: ({ onOpen }: { onOpen: () => void }) => <button type="button" onClick={onOpen}>Open</button>
}))
vi.mock('./components/VideoPicker', () => ({ VideoPicker: () => null }))

import App from './App'
import { useVideoPickerStore } from './model/video-picker'

let root: Root | undefined
let container: HTMLDivElement | undefined

function bridge(): void {
  Object.defineProperty(window, 'otc', {
    configurable: true,
    value: {
      onJobProgress: vi.fn(() => () => undefined),
      onOpenPath: vi.fn(() => () => undefined),
      onResetProject: vi.fn(() => () => undefined),
      onSaveRequest: vi.fn(() => () => undefined),
      previewFaces: vi.fn().mockResolvedValue('preview-url'),
      restoreFacePreview: vi.fn().mockResolvedValue([]),
      getDroppedPath: vi.fn().mockResolvedValue('/dropped.mp4'),
      chooseExportPath: vi.fn().mockResolvedValue('/exported.mp4'),
      exportVideo: vi.fn().mockResolvedValue(undefined),
      getSvgDataUrl: vi.fn().mockResolvedValue('svg')
    }
  })
}

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<App />) })
  return container
}

function createSession() {
  return {
    canvas: { width: 320, height: 180, fps: 30, fit: 'contain' as const },
    sources: [{ id: 'source', metadata: { path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10, width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true }, playbackPath: '/source.mp4', waveform: [] }],
    segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
    overlays: [], selectedOverlayId: null, playhead: 0, marks: [], focusZooms: [], faceBlurs: []
  }
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  saveCurrentSessionMock.mockReset().mockResolvedValue(null)
  autosaveCallback.current = undefined
  bridge()
  mockStore.session = null
  mockStoreHook.mockReturnValue(mockStore)
  mockStoreHook.getState.mockReturnValue(mockStore)
  useVideoPickerStore.setState({ open: false })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('face preview invalidation', () => {
  it('starts one preview with the freshly updated face-blur session', async () => {
    const session = createSession()
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    mockStoreHook.getState.mockReturnValue(currentStore)
    mount()

    const updatedSession = {
      ...session,
      faceBlurs: [{
        id: 'new-face-blur', start: 0, duration: 10, sensitivity: 0.7, detail: 'standard' as const,
        holdSeconds: 0.3, strength: 0.7, style: 'pixelate' as const
      }]
    }
    const updatedStore = { ...currentStore, session: updatedSession } as unknown as typeof mockStore
    mockStoreHook.getState.mockReturnValue(currentStore)
    currentStore.applyFaceBlur.mockImplementationOnce(() => { mockStoreHook.getState.mockReturnValue(updatedStore) })
    const applyAction = workspaceProps.current?.onApplyFaceBlur
    if (typeof applyAction !== 'function') throw new Error('face blur apply action missing')

    await act(async () => {
      ;(applyAction as (settings: unknown) => void)({ sensitivity: 0.7, detail: 'standard', holdSeconds: 0.3, strength: 0.7, style: 'pixelate' })
      await Promise.resolve()
    })
    expect(window.otc.previewFaces).toHaveBeenCalledOnce()
    expect(window.otc.previewFaces).toHaveBeenCalledWith(expect.objectContaining({ faceBlurs: updatedSession.faceBlurs }))
  })

  it('re-previews unchanged settings for an explicitly selected effect without changing its range', async () => {
    const session = {
      ...createSession(),
      playhead: 8,
      marks: [1, 9],
      faceBlurs: [{
        id: 'selected-face', start: 2, duration: 3, sensitivity: 0.42, detail: 'small' as const,
        holdSeconds: 0.55, strength: 0.81, style: 'mask' as const
      }]
    }
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    mockStoreHook.getState.mockReturnValue(currentStore)
    mount()
    const selectFace = workspaceProps.current?.onSelectFaceBlur
    const applyAction = workspaceProps.current?.onApplyFaceBlur
    if (typeof selectFace !== 'function' || typeof applyAction !== 'function') throw new Error('face action missing')
    act(() => { (selectFace as (id: string) => void)('selected-face') })

    await act(async () => {
      ;(workspaceProps.current?.onApplyFaceBlur as (settings: unknown) => void)({ sensitivity: 0.42, detail: 'small', holdSeconds: 0.55, strength: 0.81, style: 'mask' })
      await Promise.resolve()
    })

    expect(currentStore.updateFaceBlurSettings).toHaveBeenCalledWith('selected-face', expect.objectContaining({ style: 'mask' }))
    expect(window.otc.previewFaces).toHaveBeenCalledOnce()
    expect(window.otc.previewFaces).toHaveBeenCalledWith(expect.objectContaining({ previewRange: [2, 5] }))
    expect(session.playhead).toBe(8)
  })

  it('keeps a rendered face preview through a playhead-only update', async () => {
    const session = createSession()
    const preview = vi.mocked(window.otc.previewFaces)
    let resolvePreview!: (url: string) => void
    const deferred = new Promise<string>((resolve) => { resolvePreview = resolve })
    preview.mockImplementationOnce(() => deferred)
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    const previewStore = { ...currentStore, session: { ...session, faceBlurs: [] } } as unknown as typeof mockStore
    mockStoreHook.getState.mockReturnValue(currentStore)
    currentStore.applyFaceBlur.mockImplementationOnce(() => { mockStoreHook.getState.mockReturnValue(previewStore) })
    mount()
    const applyAction = workspaceProps.current?.onApplyFaceBlur
    if (typeof applyAction !== 'function') throw new Error('face blur apply action missing')
    await act(async () => {
      ;(applyAction as (settings: unknown) => void)({ sensitivity: 0.7, detail: 'standard', holdSeconds: 0.3, strength: 0.7, style: 'pixelate' })
      await Promise.resolve()
    })
    await act(async () => {
      resolvePreview('preview-url')
      await Promise.resolve()
    })
    const updatedStore = { ...currentStore, session: { ...session, playhead: 4 } } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(updatedStore)
    mockStoreHook.getState.mockReturnValue(updatedStore)
    act(() => { root?.render(<App />) })
    expect(workspaceProps.current?.renderedPreview).toMatchObject({ url: 'preview-url', start: 0, end: 10 })
    expect(workspaceProps.current?.facePreviewing).toBe(false)
  })

  it('leaves editing controls enabled after the rendered preview is ready', async () => {
    const session = createSession()
    const preview = vi.mocked(window.otc.previewFaces)
    let resolvePreview!: (url: string) => void
    preview.mockImplementationOnce(() => new Promise<string>((resolve) => { resolvePreview = resolve }))
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    const previewStore = { ...currentStore, session: { ...session, faceBlurs: [] } } as unknown as typeof mockStore
    mockStoreHook.getState.mockReturnValue(currentStore)
    currentStore.applyFaceBlur.mockImplementationOnce(() => { mockStoreHook.getState.mockReturnValue(previewStore) })
    const app = mount()
    const applyAction = workspaceProps.current?.onApplyFaceBlur
    if (typeof applyAction !== 'function') throw new Error('face blur apply action missing')
    await act(async () => {
      ;(applyAction as (settings: unknown) => void)({ sensitivity: 0.7, detail: 'standard', holdSeconds: 0.3, strength: 0.7, style: 'pixelate' })
      await Promise.resolve()
    })
    await act(async () => {
      resolvePreview('preview-url')
      await Promise.resolve()
    })

    const shortcut = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'ArrowRight' })
    act(() => { app.dispatchEvent(shortcut) })
    expect(shortcut.defaultPrevented).toBe(true)
    expect(currentStore.setPlayhead).toHaveBeenCalledOnce()

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [{}] } })
    const surface = container?.querySelector('.app')
    if (!(surface instanceof HTMLElement)) throw new Error('app surface missing')
    act(() => { surface.dispatchEvent(drop) })
    await act(async () => { await Promise.resolve() })
    expect(drop.defaultPrevented).toBe(true)
    expect(window.otc.getDroppedPath).toHaveBeenCalledOnce()
    expect(currentStore.loadVideo).toHaveBeenCalledWith('/dropped.mp4')
    expect(workspaceProps.current?.renderedPreview).toMatchObject({ url: 'preview-url', start: 0, end: 10 })
  })
})
