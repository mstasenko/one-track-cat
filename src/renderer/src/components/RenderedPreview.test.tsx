import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RenderedPreview } from './RenderedPreview'
import type { RenderedFacePreview } from '../model/use-face-preview'

let root: Root | undefined
let container: HTMLDivElement | undefined
let requestVideoFrameCallback: PropertyDescriptor | undefined
let cancelVideoFrameCallback: PropertyDescriptor | undefined

const preview: RenderedFacePreview = { url: 'media://face-preview', start: 2, end: 7 }

function mount(overrides: Partial<React.ComponentProps<typeof RenderedPreview>> = {}): HTMLVideoElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<RenderedPreview
      preview={preview}
      playhead={2}
      playing={false}
      total={10}
      onPlayhead={vi.fn()}
      onPlayingChange={vi.fn()}
      {...overrides}
    />)
  })
  const video = container.querySelector('video')
  if (!video) throw new Error('rendered preview video missing')
  return video
}

function setMediaClock(video: HTMLVideoElement, currentTime: number, duration = 5): void {
  let time = currentTime
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => { time = value }
  })
  Object.defineProperty(video, 'duration', { configurable: true, value: duration })
}

function frameClock(): {
  pending: Map<number, VideoFrameRequestCallback>
  cancel: ReturnType<typeof vi.fn>
  present: (mediaTime: number) => void
} {
  let nextId = 0
  const pending = new Map<number, VideoFrameRequestCallback>()
  const cancel = vi.fn((id: number) => { pending.delete(id) })
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value: vi.fn((callback: VideoFrameRequestCallback) => {
      const id = ++nextId
      pending.set(id, callback)
      return id
    })
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
    configurable: true,
    value: cancel
  })
  return {
    pending,
    cancel,
    present: (mediaTime) => {
      const next = pending.entries().next().value
      if (!next) throw new Error('no pending rendered frame callback')
      const [id, callback] = next
      pending.delete(id)
      act(() => { callback(0, { mediaTime } as VideoFrameCallbackMetadata) })
    }
  }
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  requestVideoFrameCallback = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback')
  cancelVideoFrameCallback = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'cancelVideoFrameCallback')
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  if (requestVideoFrameCallback) Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', requestVideoFrameCallback)
  else Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback')
  if (cancelVideoFrameCallback) Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', cancelVideoFrameCallback)
  else Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RenderedPreview', () => {
  it('publishes successive presented frames and cancels the clock when paused or unmounted', () => {
    const frames = frameClock()
    const onPlayhead = vi.fn()
    const onPlayingChange = vi.fn()
    const video = mount({ playing: true, onPlayhead, onPlayingChange })
    setMediaClock(video, 0.9)
    frames.present(0.25)
    act(() => { video.dispatchEvent(new Event('timeupdate')) })
    frames.present(0.25 + 1 / 30)
    expect(onPlayhead.mock.calls).toEqual([[2.25], [2.25 + 1 / 30]])
    expect(frames.pending.size).toBe(1)
    const pausedCallback = frames.pending.get(3)

    act(() => {
      root?.render(<RenderedPreview
        preview={preview} playhead={2.25 + 1 / 30} playing={false} total={10}
        onPlayhead={onPlayhead} onPlayingChange={onPlayingChange}
      />)
    })
    expect(frames.cancel).toHaveBeenLastCalledWith(3)
    expect(frames.pending.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    act(() => { pausedCallback?.(0, { mediaTime: 1 } as VideoFrameCallbackMetadata) })
    expect(onPlayhead).toHaveBeenCalledTimes(2)

    act(() => {
      root?.render(<RenderedPreview
        preview={preview} playhead={2.25 + 1 / 30} playing total={10}
        onPlayhead={onPlayhead} onPlayingChange={onPlayingChange}
      />)
      video.dispatchEvent(new Event('seeked'))
    })
    frames.present(0.35)
    expect(onPlayhead).toHaveBeenLastCalledWith(2.35)
    const unmountedCallback = frames.pending.get(5)
    act(() => { root?.unmount() })
    root = undefined
    expect(frames.cancel).toHaveBeenLastCalledWith(5)
    expect(vi.getTimerCount()).toBe(0)
    act(() => { unmountedCallback?.(0, { mediaTime: 2 } as VideoFrameCallbackMetadata) })
    expect(onPlayhead).toHaveBeenCalledTimes(3)
  })

  it('suppresses presented frames during a timeline seek and hands off the range once without pausing', () => {
    const frames = frameClock()
    const onPlayhead = vi.fn()
    const onPlayingChange = vi.fn()
    const video = mount({ playhead: 3, playing: true, onPlayhead, onPlayingChange })
    const pause = vi.fn()
    video.pause = pause
    setMediaClock(video, 1)
    frames.present(0.8)
    expect(onPlayhead).not.toHaveBeenCalled()
    act(() => { video.dispatchEvent(new Event('seeked')) })
    frames.present(1.1)
    expect(onPlayhead).toHaveBeenLastCalledWith(3.1)
    frames.present(5)
    act(() => {
      video.dispatchEvent(new Event('ended'))
      video.dispatchEvent(new Event('timeupdate'))
    })
    expect(onPlayhead.mock.calls).toEqual([[3.1], [7]])
    expect(onPlayingChange).not.toHaveBeenCalled()
    expect(pause).not.toHaveBeenCalled()
  })

  it('advances each frame interval when presented-frame callbacks are unavailable', () => {
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, value: undefined })
    const onPlayhead = vi.fn()
    const video = mount({ playing: true, fps: 50, onPlayhead })
    setMediaClock(video, 0.25)
    act(() => { vi.advanceTimersByTime(20) })
    expect(onPlayhead).toHaveBeenLastCalledWith(2.25)
    video.currentTime = 0.27
    act(() => { vi.advanceTimersByTime(20) })
    expect(onPlayhead.mock.calls).toEqual([[2.25], [2.27]])
  })

  it('falls back if presented frames stall and resets the watchdog when they resume', () => {
    const frames = frameClock()
    const onPlayhead = vi.fn()
    const video = mount({ playing: true, fps: 50, onPlayhead })
    setMediaClock(video, 0.1)
    frames.present(0.1)
    video.currentTime = 0.25
    act(() => { vi.advanceTimersByTime(99) })
    expect(onPlayhead).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1) })
    expect(onPlayhead).toHaveBeenLastCalledWith(2.25)
    video.currentTime = 0.27
    act(() => { vi.advanceTimersByTime(20) })
    expect(onPlayhead).toHaveBeenLastCalledWith(2.27)
    frames.present(0.28)
    expect(onPlayhead.mock.lastCall?.[0]).toBeCloseTo(2.28)
    act(() => { vi.advanceTimersByTime(20) })
    expect(onPlayhead).toHaveBeenCalledTimes(4)
  })

  it('discards callbacks from the previous rendered range after replacement', () => {
    const frames = frameClock()
    const onPlayhead = vi.fn()
    const video = mount({ playing: true, onPlayhead })
    setMediaClock(video, 0.4)
    frames.present(0.4)
    const previousCallback = frames.pending.get(2)
    act(() => {
      root?.render(<RenderedPreview
        preview={{ url: 'media://next-preview', start: 5, end: 10 }}
        playhead={5} playing total={10}
        onPlayhead={onPlayhead} onPlayingChange={vi.fn()}
      />)
    })
    act(() => { video.dispatchEvent(new Event('seeked')) })
    expect(frames.cancel).toHaveBeenLastCalledWith(2)
    act(() => { previousCallback?.(0, { mediaTime: 0.5 } as VideoFrameCallbackMetadata) })
    expect(onPlayhead).toHaveBeenCalledTimes(1)
    frames.present(0.5)
    expect(onPlayhead.mock.calls).toEqual([[2.4], [5.5]])
  })

  it('maps local playback time to the global range and ignores paused updates', () => {
    const onPlayhead = vi.fn()
    const video = mount({ playing: true, fps: 50, onPlayhead })
    setMediaClock(video, 0.4)
    act(() => { vi.advanceTimersByTime(20) })
    expect(onPlayhead).toHaveBeenCalledWith(2.4)

    act(() => {
      root?.render(<RenderedPreview
        preview={preview}
        playhead={2.4}
        playing={false}
        total={10}
        onPlayhead={onPlayhead}
        onPlayingChange={vi.fn()}
      />)
    })
    setMediaClock(video, 1)
    act(() => { vi.advanceTimersByTime(20) })
    expect(onPlayhead).toHaveBeenCalledTimes(1)
  })

  it('seeks paused global positions into the rendered file with a frame inset', () => {
    const video = mount({ playhead: 2, fps: 30 })
    setMediaClock(video, 0)
    act(() => {
      root?.render(<RenderedPreview
        preview={preview}
        playhead={3}
        playing={false}
        total={10}
        fps={30}
        onPlayhead={vi.fn()}
        onPlayingChange={vi.fn()}
      />)
    })
    expect(video.currentTime).toBeCloseTo(1 + 0.5 / 30)
  })

  it('hands off a processed range without pausing and stops at full timeline end', () => {
    const onPlayhead = vi.fn()
    const onPlayingChange = vi.fn()
    const video = mount({ preview, playing: true, onPlayhead, onPlayingChange })
    setMediaClock(video, 5)
    act(() => { vi.advanceTimersByTime(34) })
    expect(onPlayhead).toHaveBeenLastCalledWith(7)
    expect(onPlayingChange).not.toHaveBeenCalled()

    const fullEndPlayhead = vi.fn()
    const fullEndPlaying = vi.fn()
    const fullEnd = { url: `${preview.url}-full`, start: 2, end: 7 }
    act(() => {
      root?.render(<RenderedPreview
        preview={fullEnd}
        playhead={2}
        playing
        total={7}
        onPlayhead={fullEndPlayhead}
        onPlayingChange={fullEndPlaying}
      />)
    })
    setMediaClock(video, 5)
    act(() => { video.dispatchEvent(new Event('seeked')) })
    act(() => { video.dispatchEvent(new Event('ended')) })
    expect(fullEndPlayhead).toHaveBeenLastCalledWith(7)
    expect(fullEndPlaying).toHaveBeenCalledWith(false)
  })

  it('does not report a paused seek ending at the media boundary and surfaces media errors', () => {
    const onPlayhead = vi.fn()
    const video = mount({ playing: false, onPlayhead })
    setMediaClock(video, 0)
    act(() => { video.dispatchEvent(new Event('ended')) })
    expect(onPlayhead).not.toHaveBeenCalled()

    act(() => { video.dispatchEvent(new Event('error')) })
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain('rendered face-blur preview')
    expect(container?.querySelector('audio')).toBeNull()
    expect(container?.querySelector('.visual-overlay')).toBeNull()
  })
})
