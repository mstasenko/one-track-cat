import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditSession, MediaMetadata } from '@shared/types'
import { createSession } from '../model/timeline'
import type { PreviewProps } from './Preview'
import { Preview } from './Preview'

const audioMixer = vi.hoisted(() => ({
  register: vi.fn(() => () => undefined),
  setGain: vi.fn(),
  resume: vi.fn()
}))

vi.mock('./usePreviewAudioMixer', () => ({ usePreviewAudioMixer: () => audioMixer }))

const metadata: MediaMetadata = {
  path: '/first.mp4', name: 'first.mp4', size: 1, modifiedAt: 1, duration: 10,
  width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true
}

let root: Root | undefined
let container: HTMLDivElement | undefined
let frameCallbackDescriptor: PropertyDescriptor | undefined
let cancelCallbackDescriptor: PropertyDescriptor | undefined

function previewProps(session: EditSession, playing: boolean): PreviewProps {
  return {
    session, playing, zoom: 1, canUndo: false, canRedo: false,
    onPlayingChange: vi.fn(), onZoom: vi.fn(), onPlayhead: vi.fn(), onSelect: vi.fn(),
    onOverlayChange: vi.fn(), onOverlayGestureStart: vi.fn(), onOverlayGestureEnd: vi.fn(),
    onOverlayGestureCancel: vi.fn(), onAddMark: vi.fn(), onClearMarks: vi.fn(),
    onRemoveMarked: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), onStep: vi.fn(),
    focusPicking: null, onFocusZoom: vi.fn(), onCancelFocusPick: vi.fn(), renderedPreview: null
  }
}

function mount(session: EditSession, playing: boolean): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<Preview {...previewProps(session, playing)} />) })
  return container
}

function sourceVideo(app: HTMLDivElement): HTMLVideoElement {
  const video = app.querySelector('.preview-source-video:not(.preview-rendered-video, .preview-transition-previous)')
  if (!(video instanceof HTMLVideoElement)) throw new Error('source video missing')
  return video
}

function mediaClock(video: HTMLVideoElement, currentTime: number): void {
  let time = currentTime
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => { time = value }
  })
  Object.defineProperty(video, 'duration', { configurable: true, value: 10 })
  Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
  Object.defineProperty(video, 'seeking', { configurable: true, value: false })
}

function twoClipSession(): EditSession {
  const session = createSession(metadata)
  const sourceId = session.sources[0]?.id
  if (!sourceId) throw new Error('first source missing')
  session.sources.push({
    id: 'second-source', metadata: { ...metadata, path: '/second.mp4', name: 'second.mp4' },
    playbackPath: '/second.mp4', waveform: []
  })
  session.segments = [
    { id: 'first', sourceId, sourceStart: 0, sourceEnd: 4 },
    { id: 'second', sourceId: 'second-source', sourceStart: 0, sourceEnd: 5 }
  ]
  session.playhead = 3.9
  return session
}

function threeClipSession(): EditSession {
  const session = createSession(metadata)
  const sourceId = session.sources[0]?.id
  if (!sourceId) throw new Error('first source missing')
  session.sources.push(
    { id: 'second-source', metadata: { ...metadata, path: '/second.mp4', name: 'second.mp4' }, playbackPath: '/second.mp4', waveform: [] },
    { id: 'third-source', metadata: { ...metadata, path: '/third.mp4', name: 'third.mp4' }, playbackPath: '/third.mp4', waveform: [] }
  )
  session.segments = [
    { id: 'first', sourceId, sourceStart: 0, sourceEnd: 4 },
    { id: 'second', sourceId: 'second-source', sourceStart: 0, sourceEnd: 4 },
    { id: 'third', sourceId: 'third-source', sourceStart: 0, sourceEnd: 4 }
  ]
  session.playhead = 3.9
  return session
}

function fallbackBoundarySession(): EditSession {
  const session = createSession(metadata)
  const firstSource = session.sources[0]
  if (!firstSource) throw new Error('first source missing')
  session.sources.push({
    id: 'second-source',
    metadata: { ...metadata, path: '/second.mp4', name: 'second.mp4', duration: 0.5 },
    playbackPath: '/second.mp4', waveform: []
  })
  session.segments = [
    { id: 'first', sourceId: firstSource.id, sourceStart: 0, sourceEnd: 1 },
    { id: 'second', sourceId: 'second-source', sourceStart: 0, sourceEnd: 0.5 },
    { id: 'third', sourceId: firstSource.id, sourceStart: 0, sourceEnd: 0.5 }
  ]
  session.playhead = 0.9
  return session
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  audioMixer.register.mockClear()
  audioMixer.setGain.mockClear()
  audioMixer.resume.mockClear()
  frameCallbackDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback')
  cancelCallbackDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'cancelVideoFrameCallback')
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true, value: vi.fn(() => 1)
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
    configurable: true, value: vi.fn()
  })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  if (frameCallbackDescriptor) Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', frameCallbackDescriptor)
  else Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback')
  if (cancelCallbackDescriptor) Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', cancelCallbackDescriptor)
  else Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback')
  vi.restoreAllMocks()
})

describe('Preview late-frame handoff', () => {
  it('reveals a playing hard-cut handoff from a presented late frame', () => {
    const session = twoClipSession()
    let presented: VideoFrameRequestCallback | undefined
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn((callback: VideoFrameRequestCallback) => { presented = callback; return 1 })
    })

    const app = mount(session, true)
    const incoming = sourceVideo(app)
    mediaClock(incoming, 3.9)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('visible')

    const fallback = app.querySelector('.preview-transition-previous')
    if (!(fallback instanceof HTMLVideoElement)) throw new Error('preloaded cut video missing')
    mediaClock(fallback, 0.3)
    const switched = { ...session, playhead: 4 }
    act(() => { root?.render(<Preview {...previewProps(switched, true)} />) })
    mediaClock(incoming, 0.3)
    mediaClock(fallback, 0.3)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('hidden')

    act(() => { presented?.(0, { mediaTime: 0.3 } as VideoFrameCallbackMetadata) })
    expect(incoming.style.visibility).toBe('visible')
  })

  it('keeps a paused handoff hidden when the presented frame misses its exact seek target', () => {
    const session = twoClipSession()
    let presented: VideoFrameRequestCallback | undefined
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn((callback: VideoFrameRequestCallback) => { presented = callback; return 1 })
    })

    const app = mount(session, false)
    const incoming = sourceVideo(app)
    mediaClock(incoming, 3.9 + 0.5 / metadata.fps)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('visible')

    const switched = { ...session, playhead: 4 }
    act(() => { root?.render(<Preview {...previewProps(switched, false)} />) })
    const fallback = app.querySelector('.preview-transition-previous')
    if (!(fallback instanceof HTMLVideoElement)) throw new Error('preloaded cut video missing')
    mediaClock(incoming, 0.3)
    mediaClock(fallback, 0.3)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('hidden')

    act(() => { presented?.(0, { mediaTime: 0.3 } as VideoFrameCallbackMetadata) })
    expect(incoming.style.visibility).toBe('hidden')
  })

  it('reveals a paused handoff at the inset seek target without a presented-frame callback', () => {
    const session = twoClipSession()
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      // A paused, exactly-seeked video may not produce another presented frame.
      value: vi.fn(() => 1)
    })

    const app = mount(session, false)
    const incoming = sourceVideo(app)
    mediaClock(incoming, 3.9 + 0.5 / metadata.fps)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('visible')

    const switched = { ...session, playhead: 4 }
    act(() => { root?.render(<Preview {...previewProps(switched, false)} />) })
    const fallback = app.querySelector('.preview-transition-previous')
    if (!(fallback instanceof HTMLVideoElement)) throw new Error('preloaded cut video missing')
    mediaClock(incoming, 0.5 / metadata.fps)
    mediaClock(fallback, 0.3)
    act(() => { incoming.dispatchEvent(new Event('seeked')) })
    expect(incoming.style.visibility).toBe('visible')
  })

  it('keeps a revisited segment hidden until it presents a fresh frame', () => {
    const session = twoClipSession()
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      // Withhold the second segment's presented frame entirely.
      value: vi.fn(() => 1)
    })

    const app = mount(session, true)
    const incoming = sourceVideo(app)
    mediaClock(incoming, 3.9)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('visible')

    const switched = { ...session, playhead: 4 }
    act(() => { root?.render(<Preview {...previewProps(switched, true)} />) })
    const fallback = app.querySelector('.preview-transition-previous')
    if (!(fallback instanceof HTMLVideoElement)) throw new Error('preloaded cut video missing')
    mediaClock(incoming, 0.1)
    mediaClock(fallback, 0.1)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('hidden')

    const revisited = { ...session, playhead: 3.9 }
    act(() => { root?.render(<Preview {...previewProps(revisited, true)} />) })
    mediaClock(incoming, 3.9)
    expect(incoming.style.visibility).toBe('hidden')
  })

  it('ignores a stale presented-frame callback after another segment is selected', () => {
    const session = createSession(metadata)
    const sourceId = session.sources[0]?.id
    if (!sourceId) throw new Error('first source missing')
    session.sources.push(
      { id: 'second-source', metadata: { ...metadata, path: '/second.mp4', name: 'second.mp4' }, playbackPath: '/second.mp4', waveform: [] },
      { id: 'third-source', metadata: { ...metadata, path: '/third.mp4', name: 'third.mp4' }, playbackPath: '/third.mp4', waveform: [] }
    )
    session.segments = [
      { id: 'first', sourceId, sourceStart: 0, sourceEnd: 4 },
      { id: 'second', sourceId: 'second-source', sourceStart: 0, sourceEnd: 4 },
      { id: 'third', sourceId: 'third-source', sourceStart: 0, sourceEnd: 4 }
    ]
    session.playhead = 3.9
    const presented: VideoFrameRequestCallback[] = []
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn((callback: VideoFrameRequestCallback) => { presented.push(callback); return presented.length })
    })

    const app = mount(session, true)
    const incoming = sourceVideo(app)
    mediaClock(incoming, 3.9)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })

    const firstSwitch = { ...session, playhead: 4 }
    act(() => { root?.render(<Preview {...previewProps(firstSwitch, true)} />) })
    const fallback = app.querySelector('.preview-transition-previous')
    if (!(fallback instanceof HTMLVideoElement)) throw new Error('preloaded cut video missing')
    mediaClock(incoming, 0.3)
    mediaClock(fallback, 0.3)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    const stale = presented[presented.length - 1]
    if (!stale) throw new Error('stale callback missing')

    const secondSwitch = { ...session, playhead: 8 }
    act(() => { root?.render(<Preview {...previewProps(secondSwitch, true)} />) })
    mediaClock(incoming, 0.4)
    mediaClock(fallback, 1)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    const currentTime = incoming.currentTime
    const playbackRate = incoming.playbackRate
    const source = incoming.src
    const fallbackSource = fallback.src
    expect(incoming.style.visibility).toBe('hidden')

    act(() => { stale(0, { mediaTime: 0.3 } as VideoFrameCallbackMetadata) })
    expect(incoming.style.visibility).toBe('hidden')
    expect(incoming.currentTime).toBe(currentTime)
    expect(incoming.playbackRate).toBe(playbackRate)
    expect(incoming.src).toBe(source)
    expect(fallback.src).toBe(fallbackSource)
  })

  it('keeps a playing fallback source through the hidden audio fade before preloading the third clip', () => {
    vi.useFakeTimers()
    try {
      const session = threeClipSession()
      let presented: VideoFrameRequestCallback | undefined
      Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
        configurable: true,
        value: vi.fn((callback: VideoFrameRequestCallback) => { presented = callback; return 1 })
      })

      const app = mount(session, true)
      const incoming = sourceVideo(app)
      mediaClock(incoming, 3.9)
      act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
      const fallback = app.querySelector('.preview-transition-previous')
      if (!(fallback instanceof HTMLVideoElement)) throw new Error('preloaded cut video missing')
      mediaClock(fallback, 0)
      fallback.play = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(fallback, 'readyState', { configurable: true, value: 2 })
      act(() => { fallback.dispatchEvent(new Event('loadedmetadata')) })
      const pause = vi.fn()
      fallback.pause = pause
      Object.defineProperty(fallback, 'paused', { configurable: true, value: false })
      const pauseCallsBeforeHandoff = pause.mock.calls.length

      const switched = { ...session, playhead: 4 }
      act(() => { root?.render(<Preview {...previewProps(switched, true)} />) })
      mediaClock(incoming, 0.3)
      mediaClock(fallback, 0.3)
      act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
      expect(incoming.style.visibility).toBe('hidden')

      act(() => { presented?.(0, { mediaTime: 0.3 } as VideoFrameCallbackMetadata) })
      expect(incoming.style.visibility).toBe('visible')
      expect(pause).toHaveBeenCalledTimes(pauseCallsBeforeHandoff)
      expect(fallback.src).toContain('/second.mp4')

      act(() => { vi.advanceTimersByTime(40) })
      expect(pause.mock.calls.length).toBeGreaterThan(pauseCallsBeforeHandoff)
      expect(fallback.src).toContain('/third.mp4')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a handoff hidden when fallback and incoming media clocks differ despite aligned frame metadata', () => {
    const session = twoClipSession()
    session.canvas.fps = 60
    const presented: VideoFrameRequestCallback[] = []
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn((callback: VideoFrameRequestCallback) => { presented.push(callback); return presented.length })
    })

    const app = mount(session, true)
    const incoming = sourceVideo(app)
    mediaClock(incoming, 3.9)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    const fallback = app.querySelector('.preview-transition-previous')
    if (!(fallback instanceof HTMLVideoElement)) throw new Error('preloaded cut video missing')
    const switched = { ...session, playhead: 4 }
    act(() => { root?.render(<Preview {...previewProps(switched, true)} />) })
    mediaClock(incoming, 0.010667)
    mediaClock(fallback, 0.032)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('hidden')
    const first = presented[presented.length - 1]
    if (!first) throw new Error('handoff callback missing')

    act(() => { first(0, { mediaTime: 0.033367 } as VideoFrameCallbackMetadata) })
    expect(incoming.style.visibility).toBe('hidden')
    expect(incoming.playbackRate).toBe(2)

    mediaClock(incoming, 0.033367)
    mediaClock(fallback, 0.033367)
    const matching = presented[presented.length - 1]
    if (!matching) throw new Error('matching callback missing')
    act(() => { matching(0, { mediaTime: 0.033367 } as VideoFrameCallbackMetadata) })
    expect(incoming.style.visibility).toBe('visible')
    expect(incoming.playbackRate).toBe(1)
  })

  it('schedules the internal cut fade for a three-clip audible fallback', async () => {
    const session = fallbackBoundarySession()
    const app = mount(session, true)
    const current = sourceVideo(app)
    const fallback = app.querySelector('.preview-transition-previous')
    if (!(fallback instanceof HTMLVideoElement)) throw new Error('fallback video missing')
    fallback.play = vi.fn().mockResolvedValue(undefined)
    mediaClock(current, 0.9)
    mediaClock(fallback, 0)
    act(() => {
      current.dispatchEvent(new Event('loadeddata'))
      fallback.dispatchEvent(new Event('loadedmetadata'))
      fallback.dispatchEvent(new Event('loadeddata'))
    })

    const joined = { ...session, playhead: 1 }
    await act(async () => {
      root?.render(<Preview {...previewProps(joined, true)} />)
      await Promise.resolve()
    })
    expect(fallback.style.visibility).toBe('visible')
    mediaClock(current, 0.45)
    mediaClock(fallback, 0.4)

    const final100ms = { ...joined, playhead: 1.45 }
    await act(async () => {
      root?.render(<Preview {...previewProps(final100ms, true)} />)
      await Promise.resolve()
    })
    expect(fallback.style.visibility).toBe('visible')

    const fade = audioMixer.setGain.mock.calls.find(([media, gain, delay, duration]) =>
      media === fallback && gain === 0 && delay !== undefined && duration === 0.01)
    expect(fade).toBeDefined()
    expect(fade?.[2]).toBeCloseTo(0.09, 6)
  })
})
