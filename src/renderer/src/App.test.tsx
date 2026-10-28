import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { root, container, mockStore, mockStoreHook, workspaceProps, saveCurrentSessionMock, autosaveCallback, mount, dispatch, createSession } from './app-test-support'
import App from './App'

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
  it('exports to a directly entered destination', async () => {
    const session = createSession()
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    mockStoreHook.getState.mockReturnValue(currentStore)
    saveCurrentSessionMock.mockResolvedValueOnce(session)
    mount()
    const action = workspaceProps.current?.onExport
    if (typeof action !== 'function') throw new Error('export action missing')
    act(() => { (action as () => void)() })

    const path = container?.querySelector('[data-upscale-export-path]')
    const start = container?.querySelector('[data-upscale-export-start]')
    if (!(path instanceof HTMLInputElement) || !(start instanceof HTMLButtonElement)) {
      throw new Error('Upscale export destination controls missing')
    }
    act(() => {
      // React tracks the instance setter, so tests must call the native setter.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (!setter) throw new Error('Input value setter missing')
      setter.call(path, '/exports/direct.mp4')
      path.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      start.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.otc.chooseExportPath).toHaveBeenCalledWith('source-edited.mp4', '/exports/direct.mp4')
    expect(window.otc.exportVideo).toHaveBeenCalledWith(expect.objectContaining({ outputPath: '/exported.mp4' }))
  })

  it('exports the saved session and handles cancellation and failures', async () => {
    const session = createSession()
    const currentStore = { ...mockStore, session } as unknown as typeof mockStore
    mockStoreHook.mockReturnValue(currentStore)
    mockStoreHook.getState.mockReturnValue(currentStore)
    mount()
    const onExport = (): void => {
      const action = workspaceProps.current?.onExport
      if (typeof action !== 'function') throw new Error('export action missing')
      ;(action as () => void)()
    }

    saveCurrentSessionMock.mockResolvedValueOnce(session)
    act(() => { onExport() })
    const start = container?.querySelector('[data-upscale-export-start]')
    if (!(start instanceof HTMLButtonElement)) throw new Error('Upscale export start button missing')
    await act(async () => {
      start.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(window.otc.chooseExportPath).toHaveBeenCalledWith('source-edited.mp4')
    expect(window.otc.exportVideo).toHaveBeenCalledWith(expect.objectContaining({ outputPath: '/exported.mp4' }))
    expect(vi.mocked(window.otc.exportVideo).mock.calls[0]?.[0]).not.toHaveProperty('upscale')

    vi.mocked(window.otc.chooseExportPath).mockRejectedValueOnce(new Error('cancelled by user'))
    await act(async () => {
      onExport()
      const dialogStart = container?.querySelector('[data-upscale-export-start]')
      if (!(dialogStart instanceof HTMLButtonElement)) throw new Error('Upscale export start button missing')
      dialogStart.click()
      await Promise.resolve()
    })
    expect(currentStore.showError).not.toHaveBeenCalled()

    vi.mocked(window.otc.chooseExportPath).mockRejectedValueOnce(new Error('disk unavailable'))
    await act(async () => {
      onExport()
      const dialogStart = container?.querySelector('[data-upscale-export-start]')
      if (!(dialogStart instanceof HTMLButtonElement)) throw new Error('Upscale export start button missing')
      dialogStart.click()
      await Promise.resolve()
    })
    expect(currentStore.showError).toHaveBeenCalledWith(expect.stringContaining('disk unavailable'))
  })

})
