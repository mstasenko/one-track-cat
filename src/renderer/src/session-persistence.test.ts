import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaMetadata, otcApi } from '@shared/types'
import { useEditorStore } from './model/store'
import { createSession } from './model/timeline'
import { AUTOSAVE_INTERVAL_MS, saveCurrentSession, startAutosave } from './session-persistence'

const metadata: MediaMetadata = {
  path: '/game.mp4', name: 'game.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

function saveApi(): otcApi {
  return { saveSession: vi.fn().mockResolvedValue(undefined) } as unknown as otcApi
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useRealTimers()
  Object.defineProperty(window, 'otc', { value: saveApi(), configurable: true })
  useEditorStore.setState({ session: null, history: [], future: [] })
})

describe('session persistence', () => {
  it('saves the current project and returns the exact saved editing snapshot', async () => {
    const previous = createSession(metadata)
    const current = structuredClone(previous)
    current.marks = [2]
    useEditorStore.setState({ session: current, history: [previous], future: [] })

    await expect(saveCurrentSession()).resolves.toBe(current)
    expect(window.otc.saveSession).toHaveBeenCalledWith(expect.objectContaining({
      marks: [2], history: [expect.objectContaining({ marks: [] })]
    }))
  })

  it('does nothing when no project is open', async () => {
    await expect(saveCurrentSession()).resolves.toBeNull()
    expect(window.otc.saveSession).not.toHaveBeenCalled()
  })

  it('autosaves after five minutes and stops with the editor', async () => {
    vi.useFakeTimers()
    useEditorStore.setState({ session: createSession(metadata), history: [], future: [] })
    const onError = vi.fn()
    const stop = startAutosave(onError)

    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(window.otc.saveSession).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    stop()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(window.otc.saveSession).toHaveBeenCalledTimes(1)
  })

  it('reports an autosave failure without leaving later saves blocked', async () => {
    vi.useFakeTimers()
    useEditorStore.setState({ session: createSession(metadata), history: [], future: [] })
    vi.mocked(window.otc.saveSession)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)
    const onError = vi.fn()
    const stop = startAutosave(onError)

    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(window.otc.saveSession).toHaveBeenCalledTimes(2)
    stop()
  })

  it('serializes pending saves before reset and skips a save captured during reset', async () => {
    const firstWrite = deferred()
    const secondWrite = deferred()
    const resetWrite = deferred()
    const events: string[] = []
    const api = saveApi()
    vi.mocked(api.saveSession)
      .mockImplementationOnce(() => { events.push('save-1'); return firstWrite.promise })
      .mockImplementationOnce(() => { events.push('save-2'); return secondWrite.promise })
    api.resetSession = vi.fn(() => { events.push('reset'); return resetWrite.promise })
    Object.defineProperty(window, 'otc', { value: api, configurable: true })
    useEditorStore.setState({ session: createSession(metadata), history: [], future: [] })

    const first = saveCurrentSession()
    const second = saveCurrentSession()
    const reset = useEditorStore.getState().resetProject()
    await vi.waitFor(() => expect(events).toEqual(['save-1']))
    firstWrite.resolve()
    await vi.waitFor(() => expect(events).toEqual(['save-1', 'save-2']))
    secondWrite.resolve()
    await vi.waitFor(() => expect(events).toEqual(['save-1', 'save-2', 'reset']))

    const capturedDuringReset = saveCurrentSession()
    resetWrite.resolve()
    await expect(first).resolves.not.toBeNull()
    await expect(second).resolves.not.toBeNull()
    await expect(reset).resolves.toBeUndefined()
    await expect(capturedDuringReset).resolves.toBeNull()
    expect(events).toEqual(['save-1', 'save-2', 'reset'])
    expect(useEditorStore.getState().session).toBeNull()
  })

  it('keeps captured same-project snapshot semantics while queued', async () => {
    const write = deferred()
    const api = saveApi()
    vi.mocked(api.saveSession).mockReturnValue(write.promise)
    Object.defineProperty(window, 'otc', { value: api, configurable: true })
    const original = createSession(metadata)
    useEditorStore.setState({ session: original, history: [], future: [] })

    const pending = saveCurrentSession()
    const edited = structuredClone(original)
    edited.marks = [2]
    useEditorStore.setState({ session: edited })
    write.resolve()

    await expect(pending).resolves.toBe(original)
    expect(window.otc.saveSession).toHaveBeenCalledWith(expect.objectContaining({ marks: [] }))
  })

  it('recovers the shared queue after a reset failure', async () => {
    const api = saveApi()
    api.resetSession = vi.fn().mockRejectedValueOnce(new Error('reset failed'))
    Object.defineProperty(window, 'otc', { value: api, configurable: true })
    useEditorStore.setState({ session: createSession(metadata), history: [], future: [] })

    await useEditorStore.getState().resetProject()
    expect(useEditorStore.getState().session).not.toBeNull()
    await expect(saveCurrentSession()).resolves.not.toBeNull()
    expect(window.otc.saveSession).toHaveBeenCalledOnce()
  })
})
