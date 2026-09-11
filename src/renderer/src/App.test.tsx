import { act, type DragEvent } from 'react'
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
  Welcome: ({ onOpen, onOpenShort, onDrop }: {
    onOpen: () => void
    onOpenShort: () => void
    onDrop: (event: DragEvent<HTMLElement>, short: boolean) => void
  }) => <>
    <button type="button" onClick={onOpen}>Open</button>
    <button type="button" onClick={onOpenShort}>Open Short</button>
    <div data-testid="short-drop" onDrop={(event) => { event.stopPropagation(); onDrop(event, true) }} />
  </>
}))
vi.mock('./components/VideoPicker', () => ({ VideoPicker: () => null }))

import App from './App'
import { useVideoPickerStore } from './model/video-picker'

let root: Root | undefined
let container: HTMLDivElement | undefined
let originalShowModal: PropertyDescriptor | undefined
let originalClose: PropertyDescriptor | undefined

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

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  saveCurrentSessionMock.mockReset().mockResolvedValue(null)
  autosaveCallback.current = undefined
  bridge()
  originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
  originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function close(this: HTMLDialogElement) {
      this.open = false
      this.dispatchEvent(new Event('close'))
    })
  })
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
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close
  vi.restoreAllMocks()
})

function dispatch(target: EventTarget, code = 'Space', modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, ...modifiers })
  act(() => { target.dispatchEvent(event) })
  return event
}

function createSession(name = 'source.mp4') {
  return {
    canvas: { width: 320, height: 180, fps: 30, fit: 'contain' as const },
    sources: [{ id: 'source', metadata: { path: `/media/${name}`, name, size: 1, modifiedAt: 1, duration: 10, width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true }, playbackPath: `/media/${name}`, waveform: [] }],
    segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
    overlays: [], selectedOverlayId: null, playhead: 1, marks: [], focusZooms: [], faceBlurs: []
  }
}

describe('editor keyboard shortcuts', () => {
  it('leaves Space activation to focused buttons', () => {
    const app = mount()
    const button = app.querySelector('button')
    if (!button) throw new Error('welcome button missing')

    const event = dispatch(button)

    expect(event.defaultPrevented).toBe(false)
    expect(mockStore.setPlayhead).not.toHaveBeenCalled()
  })

  it('handles Space on the editor surface and prevents the browser default', () => {
    const app = mount()
    const event = dispatch(app.querySelector('.app') ?? app)

    expect(event.defaultPrevented).toBe(true)
  })

  it('keeps non-Space shortcuts active on focused buttons', () => {
    const app = mount()
    const button = app.querySelector('button')
    if (!button) throw new Error('welcome button missing')

    const event = dispatch(button, 'KeyZ', { ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(mockStore.undo).toHaveBeenCalledOnce()
  })

  it('keeps the global key listener stable when the store snapshot changes', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    mount()
    const updatedUndo = vi.fn()
    const updatedStore = { ...mockStore, session: null, undo: updatedUndo }
    mockStoreHook.mockReturnValue(updatedStore)
    mockStoreHook.getState.mockReturnValue(updatedStore)
    act(() => { root?.render(<App />) })

    const button = container?.querySelector('button')
    if (!button) throw new Error('welcome button missing')
    dispatch(button, 'KeyZ', { ctrlKey: true })
    expect(updatedUndo).toHaveBeenCalledOnce()

    const keydownAdds = add.mock.calls.filter(([type]) => type === 'keydown')
    const keydownRemoves = remove.mock.calls.filter(([type]) => type === 'keydown')
    expect(keydownAdds).toHaveLength(1)
    expect(keydownRemoves).toHaveLength(0)
  })

  it('handles timeline stepping, deletion, ignored fields, and unknown shortcuts', () => {
    const session = createSession()
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    mockStoreHook.getState.mockReturnValue(currentStore)
    const app = mount()

    dispatch(app, 'ArrowLeft')
    dispatch(app, 'ArrowRight')
    dispatch(app, 'ArrowLeft', { shiftKey: true })
    dispatch(app, 'ArrowRight', { shiftKey: true })
    expect(currentStore.setPlayhead).toHaveBeenCalledTimes(4)

    dispatch(app, 'Delete')
    expect(currentStore.removeMarked).toHaveBeenCalledOnce()
    const selectedStore = { ...currentStore, session: { ...session, selectedOverlayId: 'overlay' } } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(selectedStore)
    mockStoreHook.getState.mockReturnValue(selectedStore)
    dispatch(app, 'Delete')
    expect(selectedStore.removeSelectedOverlay).toHaveBeenCalledOnce()

    const onStep = workspaceProps.current?.onStep
    if (typeof onStep !== 'function') throw new Error('step action missing')
    ;(onStep as (direction: -1 | 1) => void)(1)
    expect(selectedStore.setPlayhead).toHaveBeenCalledTimes(5)

    const field = document.createElement('input')
    app.append(field)
    const ignored = dispatch(field, 'KeyZ', { ctrlKey: true })
    expect(ignored.defaultPrevented).toBe(false)
    dispatch(app, 'KeyA')
    expect(currentStore.undo).not.toHaveBeenCalled()
  })

  it('deletes an explicitly selected face effect without deleting the mark selection', () => {
    const session = {
      ...createSession(),
      marks: [2, 6],
      faceBlurs: [{
        id: 'selected-face', start: 1, duration: 3, sensitivity: 0.7, detail: 'standard' as const,
        holdSeconds: 0.3, strength: 0.7, style: 'pixelate' as const
      }]
    }
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    mockStoreHook.getState.mockReturnValue(currentStore)
    const app = mount()
    const selectFace = workspaceProps.current?.onSelectFaceBlur
    if (typeof selectFace !== 'function') throw new Error('face selection action missing')
    act(() => { (selectFace as (id: string) => void)('selected-face') })

    dispatch(app, 'Delete')

    expect(currentStore.removeFaceBlur).toHaveBeenCalledWith('selected-face')
    expect(currentStore.removeMarked).not.toHaveBeenCalled()
    expect(currentStore.setPlayhead).not.toHaveBeenCalled()
    expect(session.segments).toHaveLength(1)
    expect(session.marks).toEqual([2, 6])
  })
})

describe('bridge actions and media drops', () => {
  it('handles open, save, autosave, and welcome actions', async () => {
    const app = mount()
    const openButton = [...app.querySelectorAll('button')].find((button) => button.textContent === 'Open')
    if (!(openButton instanceof HTMLButtonElement)) throw new Error('welcome button missing')
    act(() => { openButton.click() })
    expect(mockStore.loadVideo).toHaveBeenCalledOnce()

    const shortButton = [...app.querySelectorAll('button')].find((button) => button.textContent === 'Open Short')
    if (!(shortButton instanceof HTMLButtonElement)) throw new Error('welcome Short button missing')
    act(() => { shortButton.click() })
    expect(mockStore.openShort).toHaveBeenCalledOnce()

    const shortDrop = app.querySelector('[data-testid="short-drop"]')
    if (!(shortDrop instanceof HTMLElement)) throw new Error('welcome Short drop target missing')
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [{}] } })
    await act(async () => { shortDrop.dispatchEvent(drop); await Promise.resolve() })
    expect(mockStore.loadVideo).toHaveBeenCalledWith('/dropped.mp4', true)

    const openListener = vi.mocked(window.otc.onOpenPath).mock.calls[0]?.[0]
    if (typeof openListener !== 'function') throw new Error('open listener missing')
    act(() => { openListener('/opened.mp4') })
    expect(mockStore.loadVideo).toHaveBeenCalledWith('/opened.mp4')

    const saveListener = vi.mocked(window.otc.onSaveRequest).mock.calls[0]?.[0]
    if (typeof saveListener !== 'function') throw new Error('save listener missing')
    await act(async () => { await saveListener() })
    expect(saveCurrentSessionMock).toHaveBeenCalledOnce()

    const autosave = autosaveCallback.current
    if (!autosave) throw new Error('autosave callback missing')
    autosave()
    expect(mockStore.showError).toHaveBeenCalledWith(expect.stringContaining('could not autosave'))
  })

  it('loads dropped media, ignores empty drops, and reports drop failures', async () => {
    const session = createSession()
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    mockStoreHook.getState.mockReturnValue(currentStore)
    const app = mount()
    const surface = app.querySelector('.app')
    if (!(surface instanceof HTMLElement)) throw new Error('app surface missing')

    const dragOver = new Event('dragover', { bubbles: true, cancelable: true })
    act(() => { surface.dispatchEvent(dragOver) })
    expect(dragOver.defaultPrevented).toBe(true)

    const emptyDrop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(emptyDrop, 'dataTransfer', { value: { files: [] } })
    act(() => { surface.dispatchEvent(emptyDrop) })
    expect(emptyDrop.defaultPrevented).toBe(true)
    expect(window.otc.getDroppedPath).not.toHaveBeenCalled()

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [{}] } })
    await act(async () => {
      surface.dispatchEvent(drop)
      await Promise.resolve()
    })
    expect(currentStore.loadVideo).toHaveBeenCalledWith('/dropped.mp4')

    vi.mocked(window.otc.getDroppedPath).mockRejectedValueOnce(new Error('bad drop'))
    const failedDrop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(failedDrop, 'dataTransfer', { value: { files: [{}] } })
    await act(async () => {
      surface.dispatchEvent(failedDrop)
      await Promise.resolve()
    })
    expect(currentStore.showError).toHaveBeenCalledWith('OneTrackCat could not open this video. Try another file.')
  })
})

describe('export actions', () => {
  it('exports the saved session and handles cancellation and failures', async () => {
    const session = createSession()
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    mockStoreHook.getState.mockReturnValue(currentStore)
    mount()
    const onExport = workspaceProps.current?.onExport
    if (typeof onExport !== 'function') throw new Error('export action missing')

    saveCurrentSessionMock.mockResolvedValueOnce(session)
    await act(async () => {
      ;(onExport as () => void)()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(window.otc.chooseExportPath).toHaveBeenCalledWith('source-edited.mp4')
    expect(window.otc.exportVideo).toHaveBeenCalledWith(expect.objectContaining({ outputPath: '/exported.mp4' }))

    vi.mocked(window.otc.chooseExportPath).mockRejectedValueOnce(new Error('cancelled by user'))
    await act(async () => {
      ;(onExport as () => void)()
      await Promise.resolve()
    })
    expect(currentStore.showError).not.toHaveBeenCalled()

    vi.mocked(window.otc.chooseExportPath).mockRejectedValueOnce(new Error('disk unavailable'))
    await act(async () => {
      ;(onExport as () => void)()
      await Promise.resolve()
    })
    expect(currentStore.showError).toHaveBeenCalledWith(expect.stringContaining('disk unavailable'))
  })
})

describe('reset project dialog', () => {
  it('opens for a reset request and blocks shortcuts and drops until cancelled', async () => {
    const session = {
      canvas: { width: 320, height: 180, fps: 30, fit: 'contain' as const },
      sources: [{ id: 'source', metadata: { path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10, width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true }, playbackPath: '/source.mp4', waveform: [] }],
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
      overlays: [], selectedOverlayId: null, playhead: 0, marks: [], focusZooms: [], faceBlurs: []
    }
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    mockStoreHook.getState.mockReturnValue(currentStore)
    const app = mount()
    const resetListener = vi.mocked(window.otc.onResetProject).mock.calls[0]?.[0]
    if (typeof resetListener !== 'function') throw new Error('reset listener missing')

    act(() => { resetListener() })
    expect(container?.querySelector('[data-confirm-dialog]')).not.toBeNull()

    const shortcut = dispatch(app, 'ArrowRight')
    expect(shortcut.defaultPrevented).toBe(false)
    expect(currentStore.setPlayhead).not.toHaveBeenCalled()

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [{}] } })
    const surface = container?.querySelector('.app')
    if (!(surface instanceof HTMLElement)) throw new Error('app surface missing')
    act(() => { surface.dispatchEvent(drop) })
    await act(async () => { await Promise.resolve() })
    expect(drop.defaultPrevented).toBe(true)
    expect(window.otc.getDroppedPath).not.toHaveBeenCalled()
    expect(currentStore.loadVideo).not.toHaveBeenCalled()

    const cancel = container?.querySelector('[data-confirm-cancel]')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('cancel button missing')
    act(() => { cancel.click() })
    const dialog = container?.querySelector('[data-confirm-dialog]')
    expect(dialog instanceof HTMLDialogElement && dialog.open).toBe(false)
  })

  it('confirms only after the explicit Reset action', () => {
    const app = mount()
    const resetListener = vi.mocked(window.otc.onResetProject).mock.calls[0]?.[0]
    if (typeof resetListener !== 'function') throw new Error('reset listener missing')
    act(() => { resetListener() })

    const reset = app.querySelector('[data-confirm-submit]')
    if (!(reset instanceof HTMLButtonElement)) throw new Error('reset button missing')
    act(() => { reset.click() })

    expect(mockStore.resetProject).toHaveBeenCalledOnce()
  })

  it('blocks delete, reset, and drops while the video picker is open', async () => {
    const session = createSession()
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    mockStoreHook.getState.mockReturnValue(currentStore)
    useVideoPickerStore.setState({ open: true })
    const app = mount()

    const resetListener = vi.mocked(window.otc.onResetProject).mock.calls[0]?.[0]
    if (typeof resetListener !== 'function') throw new Error('reset listener missing')
    act(() => { resetListener() })
    const resetDialog = container?.querySelector('[data-confirm-dialog]')
    expect(resetDialog instanceof HTMLDialogElement && resetDialog.open).toBe(false)

    const shortcut = dispatch(app, 'Delete')
    expect(shortcut.defaultPrevented).toBe(false)
    expect(currentStore.removeMarked).not.toHaveBeenCalled()
    expect(currentStore.removeSelectedOverlay).not.toHaveBeenCalled()

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [{}] } })
    const surface = container?.querySelector('.app')
    if (!(surface instanceof HTMLElement)) throw new Error('app surface missing')
    await act(async () => {
      surface.dispatchEvent(drop)
      await Promise.resolve()
    })
    expect(drop.defaultPrevented).toBe(true)
    expect(window.otc.getDroppedPath).not.toHaveBeenCalled()
    expect(currentStore.loadVideo).not.toHaveBeenCalled()
    expect(currentStore.resetProject).not.toHaveBeenCalled()
    expect(saveCurrentSessionMock).not.toHaveBeenCalled()
    expect(currentStore.session).toBe(session)
  })
})
