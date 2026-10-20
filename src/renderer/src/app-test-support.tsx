import { act, type DragEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, vi } from 'vitest'

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

export { mockStore, mockStoreHook, workspaceProps, saveCurrentSessionMock, autosaveCallback }

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

export let root: Root | undefined
export let container: HTMLDivElement | undefined
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
      aiPackStatus: vi.fn().mockResolvedValue({ available: true, message: 'ready' }),
      getSvgDataUrl: vi.fn().mockResolvedValue('svg')
    }
  })
}

export function mount(): HTMLDivElement {
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

export function dispatch(target: EventTarget, code = 'Space', modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, ...modifiers })
  act(() => { target.dispatchEvent(event) })
  return event
}

export function createSession(name = 'source.mp4') {
  return {
    canvas: { width: 320, height: 180, fps: 30, fit: 'contain' as const },
    sources: [{ id: 'source', metadata: { path: `/media/${name}`, name, size: 1, modifiedAt: 1, duration: 10, width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true }, playbackPath: `/media/${name}`, waveform: [] }],
    segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
    overlays: [], selectedOverlayId: null, playhead: 1, marks: [], focusZooms: [], faceBlurs: []
  }
}
