import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { container, mockStore, mockStoreHook, saveCurrentSessionMock, mount, dispatch, createSession } from './app-test-support'

import { useVideoPickerStore } from './model/video-picker'

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
