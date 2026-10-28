import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { store, storeHook, workspaceProps, saveCurrentSession, startAutosave } = vi.hoisted(() => {
  const editorStore = {
    initialized: true, session: null, history: [], future: [], gesture: null, assets: [], gpu: null, job: null, busy: null, error: null,
    initialize: vi.fn().mockResolvedValue(undefined), loadVideo: vi.fn().mockResolvedValue(undefined), openShort: vi.fn().mockResolvedValue(undefined),
    resetProject: vi.fn().mockResolvedValue(undefined), setJob: vi.fn(), showError: vi.fn(), setPlayhead: vi.fn(), selectOverlay: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), removeSelectedOverlay: vi.fn(), addMark: vi.fn(), clearMark: vi.fn(), removeMarked: vi.fn(),
    applyFaceBlur: vi.fn(), updateFaceBlurSettings: vi.fn(), removeFaceBlur: vi.fn()
  }
  const hook = Object.assign(vi.fn(() => editorStore), { getState: vi.fn(() => editorStore) })
  return {
    store: editorStore, storeHook: hook, workspaceProps: { current: undefined as Record<string, unknown> | undefined },
    saveCurrentSession: vi.fn().mockResolvedValue(null), startAutosave: vi.fn(() => () => undefined)
  }
})

vi.mock('./model/store', () => ({ useEditorStore: storeHook }))
vi.mock('./session-persistence', () => ({ saveCurrentSession, startAutosave }))
vi.mock('./components/AppLayout', () => ({
  EditorWorkspace: (props: Record<string, unknown>) => { workspaceProps.current = props; return null },
  ExportProgress: () => null, GpuWarning: () => null, StatusBanners: () => null, Welcome: () => null
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
      onJobProgress: vi.fn(() => () => undefined), onOpenPath: vi.fn(() => () => undefined),
      onResetProject: vi.fn(() => () => undefined), onSaveRequest: vi.fn(() => () => undefined),
      previewFaces: vi.fn().mockResolvedValue('preview-url'), restoreFacePreview: vi.fn().mockResolvedValue([]),
      getDroppedPath: vi.fn().mockResolvedValue('/dropped.mp4'), chooseExportPath: vi.fn().mockResolvedValue('/exported.mp4'),
      exportVideo: vi.fn().mockResolvedValue(undefined), upscalePackStatus: vi.fn().mockResolvedValue({ available: true, message: 'ready' }),
      getSvgDataUrl: vi.fn().mockResolvedValue('svg')
    }
  })
}

function session() {
  return {
    canvas: { width: 320, height: 180, fps: 30, fit: 'contain' as const },
    sources: [{ id: 'source', metadata: {
      path: '/media/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
      width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true
    }, playbackPath: '/media/source.mp4', waveform: [] }],
    segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
    overlays: [], selectedOverlayId: null, playhead: 1, marks: [2, 6], focusZooms: [], faceBlurs: []
  }
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
  saveCurrentSession.mockReset().mockResolvedValue(null)
  bridge()
  store.session = null
  storeHook.mockReturnValue(store)
  storeHook.getState.mockReturnValue(store)
  useVideoPickerStore.setState({ open: false })
  originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
  originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function showModal(this: HTMLDialogElement) { this.open = true }) })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function close(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')) }) })
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

describe('Upscale export integration', () => {
  it('keeps the chosen mode when the editor rerenders with the dialog open', async () => {
    const currentStore = { ...store, session: session() } as unknown as typeof store
    storeHook.mockReturnValue(currentStore)
    storeHook.getState.mockReturnValue(currentStore)
    const app = mount()
    const onExport = workspaceProps.current?.onExport
    if (typeof onExport !== 'function') throw new Error('export action missing')
    act(() => { (onExport as () => void)() })
    await act(async () => { await Promise.resolve() })
    const selector = app.querySelector('[data-upscale-select]')
    if (!(selector instanceof HTMLSelectElement)) throw new Error('AI mode selector missing')
    await act(async () => {
      selector.value = 'base'
      selector.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => { root?.render(<App />); await Promise.resolve() })
    expect(selector.value).toBe('base')
  })
  it.each([
    [3840, 2160, false],
    [1920, 1080, true]
  ] as const)('passes %sx%s spatial=%s through App to the real dialog status callback', async (width, height, spatial) => {
    const currentSession = session()
    currentSession.canvas.width = width
    currentSession.canvas.height = height
    currentSession.canvas.fps = 30
    const currentStore = { ...store, session: currentSession } as unknown as typeof store
    storeHook.mockReturnValue(currentStore)
    storeHook.getState.mockReturnValue(currentStore)
    mount()
    const onExport = workspaceProps.current?.onExport
    if (typeof onExport !== 'function') throw new Error('export action missing')
    saveCurrentSession.mockResolvedValueOnce(currentSession)
    act(() => { (onExport as () => void)() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    if (spatial) expect(window.otc.upscalePackStatus).toHaveBeenCalledWith(true, 'turbo')
    else expect(window.otc.upscalePackStatus).toHaveBeenCalledWith(false)
  })
  it('passes enhancement only when selected and exports the finished timeline, not marks', async () => {
    const currentSession = session()
    const currentStore = { ...store, session: currentSession } as unknown as typeof store
    storeHook.mockReturnValue(currentStore)
    storeHook.getState.mockReturnValue(currentStore)
    const app = mount()
    const onExport = workspaceProps.current?.onExport
    if (typeof onExport !== 'function') throw new Error('export action missing')

    saveCurrentSession.mockResolvedValueOnce(currentSession)
    act(() => { (onExport as () => void)() })
    await act(async () => { await Promise.resolve() })
    const selector = app.querySelector('[data-upscale-select]')
    const start = app.querySelector('[data-upscale-export-start]')
    if (!(selector instanceof HTMLSelectElement) || !(start instanceof HTMLButtonElement)) throw new Error('Upscale export controls missing')
    expect(selector.value).toBe('off')
    act(() => {
      selector.value = 'turbo'
      selector.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { start.click(); await Promise.resolve(); await Promise.resolve() })

    const request = vi.mocked(window.otc.exportVideo).mock.calls[0]?.[0]
    expect(request).toMatchObject({
      outputPath: '/exported.mp4',
      upscale: { mode: 'turbo' },
      segments: currentSession.segments
    })
    expect(request).not.toHaveProperty('marks')
  })
})
