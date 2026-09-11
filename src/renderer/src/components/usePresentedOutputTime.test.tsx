import { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditSession } from '@shared/types'
import { usePresentedOutputTime } from './usePresentedOutputTime'

const session: EditSession = {
  canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
  sources: [],
  segments: [{ id: 'segment', sourceId: 'source', sourceStart: 10, sourceEnd: 20 }],
  overlays: [],
  selectedOverlayId: null,
  playhead: 0,
  marks: [],
  focusZooms: []
}

interface TestVideo {
  video: HTMLVideoElement
  emit: (mediaTime: number) => void
  pending: () => number
  requestVideoFrameCallback: ReturnType<typeof vi.fn>
  cancelVideoFrameCallback: ReturnType<typeof vi.fn>
}

function testVideo(): TestVideo {
  const callbacks = new Map<number, VideoFrameRequestCallback>()
  let nextId = 0
  const requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback): number => {
    const id = ++nextId
    callbacks.set(id, callback)
    return id
  })
  const cancelVideoFrameCallback = vi.fn((id: number): void => { callbacks.delete(id) })
  const video = {
    currentTime: 0,
    requestVideoFrameCallback,
    cancelVideoFrameCallback
  } as unknown as HTMLVideoElement
  return {
    video,
    emit: (mediaTime: number): void => {
      const next = callbacks.entries().next()
      if (next.done) throw new Error('No presented-frame callback is pending')
      const [id, callback] = next.value
      callbacks.delete(id)
      callback(0, { mediaTime } as VideoFrameCallbackMetadata)
    },
    pending: () => callbacks.size,
    requestVideoFrameCallback,
    cancelVideoFrameCallback
  }
}

interface HarnessProps {
  video: HTMLVideoElement
  playing: boolean
  onOutput: (value: number) => void
}

function Harness({ video, playing, onOutput }: HarnessProps): null {
  const videoRef = useRef(video)
  const output = usePresentedOutputTime(videoRef, session, 0, playing, 'source')
  useEffect(() => onOutput(output), [onOutput, output])
  return null
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function render(props: HarnessProps): void {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  act(() => { root?.render(<Harness {...props} />) })
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('usePresentedOutputTime', () => {
  it('maps advancing currentTime on the watchdog faster than timeupdate cadence', async () => {
    const media = testVideo()
    const onOutput = vi.fn()
    render({ video: media.video, playing: true, onOutput })

    media.video.currentTime = 13
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(onOutput).toHaveBeenLastCalledWith(3)

    media.video.currentTime = 14
    await act(async () => { await vi.advanceTimersByTimeAsync(42) })
    expect(onOutput).toHaveBeenLastCalledWith(4)
    expect(onOutput.mock.calls.filter(([value]) => value !== 0)).toHaveLength(2)
  })

  it('prefers presented metadata and restores it after a fallback', async () => {
    const media = testVideo()
    const onOutput = vi.fn()
    render({ video: media.video, playing: true, onOutput })

    media.video.currentTime = 19
    act(() => { media.emit(11) })
    expect(onOutput).toHaveBeenLastCalledWith(1)

    media.video.currentTime = 12
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(onOutput).toHaveBeenLastCalledWith(2)
    act(() => { media.emit(15) })
    expect(onOutput).toHaveBeenLastCalledWith(5)

    media.video.currentTime = 19
    const callsAfterMetadata = onOutput.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(onOutput.mock.calls.length).toBe(callsAfterMetadata)
    await act(async () => { await vi.advanceTimersByTimeAsync(60) })
    expect(onOutput).toHaveBeenLastCalledWith(9)
  })

  it('cancels the callback and watchdog when paused', async () => {
    const media = testVideo()
    const onOutput = vi.fn()
    render({ video: media.video, playing: true, onOutput })
    render({ video: media.video, playing: false, onOutput })
    const callsAfterPause = onOutput.mock.calls.length

    expect(media.cancelVideoFrameCallback).toHaveBeenCalledOnce()
    expect(media.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    media.video.currentTime = 15
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(onOutput.mock.calls.length).toBe(callsAfterPause)
  })

  it('cancels the callback and watchdog when unmounted', async () => {
    const media = testVideo()
    const onOutput = vi.fn()
    render({ video: media.video, playing: true, onOutput })
    act(() => { root?.unmount() })
    root = undefined

    expect(media.cancelVideoFrameCallback).toHaveBeenCalledOnce()
    expect(media.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    media.video.currentTime = 15
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(onOutput).toHaveBeenCalledOnce()
  })
})
