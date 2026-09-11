import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditSession, MediaMetadata, SourceSegment } from '@shared/types'
import { createSession } from '../model/timeline'
import type { PreviewProps } from './Preview'
import { Preview } from './Preview'

let root: Root | undefined
let container: HTMLDivElement | undefined
let requestVideoFrameCallback: PropertyDescriptor | undefined
let cancelVideoFrameCallback: PropertyDescriptor | undefined

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
  width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true
}

function props(overrides: Partial<PreviewProps> = {}): PreviewProps {
  const session = createSession(metadata)
  return {
    session,
    playing: false,
    zoom: 1,
    canUndo: false,
    canRedo: false,
    onPlayingChange: vi.fn(),
    onZoom: vi.fn(),
    onPlayhead: vi.fn(),
    onSelect: vi.fn(),
    onOverlayChange: vi.fn(),
    onOverlayGestureStart: vi.fn(),
    onOverlayGestureEnd: vi.fn(),
    onOverlayGestureCancel: vi.fn(),
    onAddMark: vi.fn(),
    onClearMarks: vi.fn(),
    onRemoveMarked: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onStep: vi.fn(),
    focusPicking: null,
    onFocusZoom: vi.fn(),
    onCancelFocusPick: vi.fn(),
    renderedPreview: null,
    ...overrides
  }
}

function mount(input: Partial<PreviewProps> = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<Preview {...props(input)} />) })
  return container
}

function mediaClock(video: HTMLVideoElement, currentTime: number, duration = 10): void {
  let time = currentTime
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => { time = value }
  })
  Object.defineProperty(video, 'duration', { configurable: true, value: duration })
}

function sourceVideo(app: HTMLDivElement): HTMLVideoElement {
  const video = app.querySelector('.preview-source-video:not(.preview-rendered-video, .preview-transition-previous)')
  if (!(video instanceof HTMLVideoElement)) throw new Error('source video missing')
  return video
}

function sessionWithSegments(segments: SourceSegment[], playhead = 0): EditSession {
  const session = createSession(metadata)
  return { ...session, segments, playhead }
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  requestVideoFrameCallback = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback')
  cancelVideoFrameCallback = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'cancelVideoFrameCallback')
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value: vi.fn(() => 1)
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
    configurable: true,
    value: vi.fn()
  })
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
  vi.restoreAllMocks()
})

describe('Preview', () => {
  it('offers a non-destructive way to clear marks', () => {
    const session = createSession(metadata)
    session.marks = [2, 6]
    const onClearMarks = vi.fn()
    const app = mount({ session, onClearMarks })
    const clear = [...app.querySelectorAll('button')].find((button) => button.textContent === 'Clear Marks')
    if (!(clear instanceof HTMLButtonElement)) throw new Error('Clear Marks button missing')
    act(() => { clear.click() })
    expect(onClearMarks).toHaveBeenCalledOnce()
  })

  it('uses the renamed mark controls', () => {
    const session = createSession(metadata)
    session.marks = [2, 6]
    const onAddMark = vi.fn()
    const onRemoveMarked = vi.fn()
    const app = mount({ session, onAddMark, onRemoveMarked })
    const button = (label: string): HTMLButtonElement => {
      const element = [...app.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
      if (!(element instanceof HTMLButtonElement)) throw new Error(`${label} button missing`)
      return element
    }
    act(() => { button('Mark').click(); button('Remove Marked').click() })
    expect(onAddMark).toHaveBeenCalledOnce()
    expect(onRemoveMarked).toHaveBeenCalledOnce()
  })

  it('renders the ordinary source preview and advances across segments', () => {
    const session = createSession(metadata)
    const baseSegment = session.segments[0]
    if (!baseSegment || baseSegment.kind === 'freeze') throw new Error('default video segment missing')
    const first: SourceSegment = { ...baseSegment, id: 'first', sourceStart: 0, sourceEnd: 5 }
    const second: SourceSegment = { ...baseSegment, id: 'second', sourceStart: 5, sourceEnd: 10 }
    const onPlayhead = vi.fn()
    const onPlayingChange = vi.fn()
    const app = mount({ session: sessionWithSegments([first, second]), playing: true, onPlayhead, onPlayingChange })
    const video = sourceVideo(app)
    mediaClock(video, 2)
    act(() => { video.dispatchEvent(new Event('timeupdate')) })
    expect(onPlayhead).toHaveBeenLastCalledWith(2)

    mediaClock(video, 4.98)
    act(() => { video.dispatchEvent(new Event('timeupdate')) })
    expect(onPlayhead).toHaveBeenLastCalledWith(4.98)

    mediaClock(video, 5)
    act(() => { video.dispatchEvent(new Event('timeupdate')) })
    expect(onPlayhead).toHaveBeenLastCalledWith(5)
    mediaClock(video, 10)
    act(() => { video.dispatchEvent(new Event('timeupdate')) })
    expect(onPlayhead).toHaveBeenLastCalledWith(10)
    expect(onPlayingChange).toHaveBeenCalledWith(false)
    expect(app.querySelector('.transport')).not.toBeNull()
  })

  it('advances on ended even when media time is just short of the segment end', () => {
    const session = createSession(metadata)
    const baseSegment = session.segments[0]
    if (!baseSegment || baseSegment.kind === 'freeze') throw new Error('default video segment missing')
    const first: SourceSegment = { ...baseSegment, id: 'first', sourceStart: 0, sourceEnd: 5 }
    const second: SourceSegment = { ...baseSegment, id: 'second', sourceStart: 5, sourceEnd: 10 }
    const onPlayhead = vi.fn()
    const app = mount({ session: sessionWithSegments([first, second]), playing: true, onPlayhead })
    const video = sourceVideo(app)
    mediaClock(video, 4.999)
    Object.defineProperty(video, 'ended', { configurable: true, value: true })

    act(() => { video.dispatchEvent(new Event('ended')) })
    expect(onPlayhead).toHaveBeenLastCalledWith(5)
  })

  it('does not advance twice when timeupdate reaches a boundary before ended', () => {
    const session = createSession(metadata)
    const baseSegment = session.segments[0]
    if (!baseSegment || baseSegment.kind === 'freeze') throw new Error('default video segment missing')
    const first: SourceSegment = { ...baseSegment, id: 'first', sourceStart: 0, sourceEnd: 5 }
    const second: SourceSegment = { ...baseSegment, id: 'second', sourceStart: 5, sourceEnd: 10 }
    const onPlayhead = vi.fn()
    const app = mount({ session: sessionWithSegments([first, second]), playing: true, onPlayhead })
    const video = sourceVideo(app)
    mediaClock(video, 5)

    act(() => { video.dispatchEvent(new Event('timeupdate')) })
    expect(onPlayhead).toHaveBeenCalledTimes(1)
    expect(onPlayhead).toHaveBeenLastCalledWith(5)

    Object.defineProperty(video, 'ended', { configurable: true, value: true })
    act(() => { video.dispatchEvent(new Event('ended')) })
    expect(onPlayhead).toHaveBeenCalledTimes(1)
    expect(onPlayhead).toHaveBeenLastCalledWith(5)
  })

  it('advances a trimmed clip from the presented frame clock without duplicating ended', () => {
    let presented: VideoFrameRequestCallback | undefined
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn((callback: VideoFrameRequestCallback) => { presented = callback; return 1 })
    })

    const session = createSession(metadata)
    const baseSegment = session.segments[0]
    if (!baseSegment || baseSegment.kind === 'freeze') throw new Error('default video segment missing')
    const first: SourceSegment = { ...baseSegment, id: 'first', sourceStart: 0, sourceEnd: 5 }
    const second: SourceSegment = { ...baseSegment, id: 'second', sourceStart: 5, sourceEnd: 10 }
    const onPlayhead = vi.fn()
    const app = mount({ session: sessionWithSegments([first, second]), playing: true, onPlayhead })
    const video = sourceVideo(app)
    mediaClock(video, 4.98)
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
    act(() => { video.dispatchEvent(new Event('seeked')) })

    act(() => { presented?.(0, { mediaTime: 4.98 } as VideoFrameCallbackMetadata) })
    expect(onPlayhead).not.toHaveBeenCalledWith(5)

    video.currentTime = 5.01
    act(() => { presented?.(0, { mediaTime: 5 } as VideoFrameCallbackMetadata) })
    expect(onPlayhead).toHaveBeenCalledOnce()
    expect(onPlayhead).toHaveBeenLastCalledWith(5)

    Object.defineProperty(video, 'ended', { configurable: true, value: true })
    act(() => { video.dispatchEvent(new Event('ended')) })
    expect(onPlayhead).toHaveBeenCalledOnce()
  })

  it('keeps a newly switched incoming transition clip hidden until its frame is ready', () => {
    const session = createSession(metadata)
    const sourceId = session.sources[0]?.id
    if (!sourceId) throw new Error('source missing')
    session.segments = [
      { id: 'first', sourceId, sourceStart: 0, sourceEnd: 4 },
      { id: 'second', sourceId, sourceStart: 4, sourceEnd: 9, transition: { effect: 'fade', duration: 1 } }
    ]
    session.playhead = 3.75

    const app = mount({ session, playing: true })
    let incoming = sourceVideo(app)
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('visible')

    const transitioned = { ...session, playhead: 4.25 }
    act(() => { root?.render(<Preview {...props({ session: transitioned, playing: true })} />) })
    incoming = sourceVideo(app)
    expect(incoming.style.visibility).toBe('hidden')
    Object.defineProperty(incoming, 'readyState', { configurable: true, value: 2 })
    Object.defineProperty(incoming, 'seeking', { configurable: true, value: false })
    let presented: VideoFrameRequestCallback | undefined
    Object.defineProperty(incoming, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn((callback: VideoFrameRequestCallback) => { presented = callback; return 2 })
    })
    act(() => { incoming.dispatchEvent(new Event('seeked')) })
    expect(incoming.style.visibility).toBe('hidden')
    act(() => { presented?.(0, { mediaTime: 4.25 } as VideoFrameCallbackMetadata) })
    expect(incoming.style.visibility).toBe('visible')
  })

  it('starts a playing transition decoder muted and fades in on playing', () => {
    const session = createSession(metadata)
    const sourceId = session.sources[0]?.id
    if (!sourceId) throw new Error('source missing')
    session.segments = [
      { id: 'first', sourceId, sourceStart: 0, sourceEnd: 4 },
      { id: 'second', sourceId, sourceStart: 4, sourceEnd: 9, transition: { effect: 'fade', duration: 1 } }
    ]
    session.playhead = 3.75

    const app = mount({ session, playing: true })
    let incoming = sourceVideo(app)
    Object.defineProperty(incoming, 'readyState', { configurable: true, value: 2 })
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })

    const transitioned = { ...session, playhead: 4.25 }
    Object.defineProperty(incoming, 'readyState', { configurable: true, value: 1 })
    act(() => { root?.render(<Preview {...props({ session: transitioned, playing: true })} />) })
    incoming = sourceVideo(app)
    expect(incoming.style.visibility).toBe('hidden')
    expect(incoming.volume).toBe(0)

    act(() => { incoming.dispatchEvent(new Event('playing')) })
    expect(incoming.volume).toBe(1)
    expect(incoming.style.visibility).toBe('hidden')
  })

  it('preloads the next clip and uses it while a seamless hard cut switches sources', async () => {
    const session = createSession({ ...metadata, path: '/first.mp4', name: 'first.mp4' })
    const sourceId = session.sources[0]?.id
    if (!sourceId) throw new Error('first source missing')
    session.sources.push({
      id: 'second-source',
      metadata: { ...metadata, path: '/second.mp4', name: 'second.mp4' },
      playbackPath: '/second.mp4',
      waveform: []
    })
    session.segments = [
      { id: 'first', sourceId, sourceStart: 0, sourceEnd: 4 },
      { id: 'second', sourceId: 'second-source', sourceStart: 0, sourceEnd: 5 }
    ]
    session.playhead = 3.9

    const app = mount({ session, playing: true })
    let incoming = sourceVideo(app)
    mediaClock(incoming, 3.9)
    Object.defineProperty(incoming, 'readyState', { configurable: true, value: 2 })
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })

    const fallback = app.querySelector('.preview-transition-previous')
    if (!(fallback instanceof HTMLVideoElement)) throw new Error('preloaded cut video missing')
    mediaClock(fallback, 0)
    Object.defineProperty(fallback, 'readyState', { configurable: true, value: 2 })
    fallback.play = vi.fn().mockResolvedValue(undefined)
    act(() => { fallback.dispatchEvent(new Event('loadedmetadata')) })
    expect(fallback.src).toContain('/second.mp4')
    expect(fallback.style.visibility).toBe('hidden')

    const switched = { ...session, playhead: 4.05 }
    await act(async () => {
      root?.render(<Preview {...props({ session: switched, playing: true })} />)
      await Promise.resolve()
    })
    incoming = sourceVideo(app)
    expect(incoming.style.visibility).toBe('hidden')
    expect(fallback.style.visibility).toBe('visible')
    expect(incoming.volume).toBe(0)
    expect(fallback.volume).toBe(1)
    act(() => { incoming.dispatchEvent(new Event('playing')) })
    expect(incoming.volume).toBe(0)

    let presented: VideoFrameRequestCallback | undefined
    Object.defineProperty(incoming, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn((callback: VideoFrameRequestCallback) => { presented = callback; return 2 })
    })
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('hidden')
    fallback.currentTime = 0.1
    act(() => { presented?.(0, { mediaTime: 0.05 } as VideoFrameCallbackMetadata) })
    expect(incoming.style.visibility).toBe('hidden')
    expect(incoming.playbackRate).toBe(2)
    fallback.currentTime = 0.1
    incoming.currentTime = 0.095
    act(() => { presented?.(0, { mediaTime: 0.095 } as VideoFrameCallbackMetadata) })
    expect(incoming.style.visibility).toBe('visible')
    expect(fallback.style.visibility).toBe('hidden')
    expect(incoming.playbackRate).toBe(1)
    expect(incoming.volume).toBe(1)
    expect(fallback.volume).toBe(0)
  })

  it('keeps a scheduled boundary fade muted through the final frame', () => {
    const session = createSession(metadata)
    const sourceId = session.sources[0]?.id
    if (!sourceId) throw new Error('source missing')
    session.segments = [
      { id: 'first', sourceId, sourceStart: 0, sourceEnd: 5 },
      { id: 'second', sourceId, sourceStart: 5, sourceEnd: 10 }
    ]
    session.playhead = 4.85

    const app = mount({ session, playing: true })
    const video = sourceVideo(app)
    const setVolume = vi.fn()
    Object.defineProperty(video, 'volume', { configurable: true, get: () => 1, set: setVolume })

    act(() => { root?.render(<Preview {...props({ session: { ...session, playhead: 4.87 }, playing: true })} />) })
    expect(setVolume).not.toHaveBeenCalled()

    act(() => { root?.render(<Preview {...props({ session: { ...session, playhead: 4.92 }, playing: true })} />) })
    expect(setVolume).toHaveBeenCalledOnce()
    expect(setVolume).toHaveBeenLastCalledWith(0)

    act(() => { root?.render(<Preview {...props({ session: { ...session, playhead: 4.94 }, playing: true })} />) })
    expect(setVolume).toHaveBeenCalledOnce()

    // Entering the last 10 ms must not cancel the fade and turn the old clip up.
    act(() => { root?.render(<Preview {...props({ session: { ...session, playhead: 4.995 }, playing: true })} />) })
    expect(setVolume).toHaveBeenCalledOnce()
    act(() => { video.dispatchEvent(new Event('playing')) })
    expect(setVolume).toHaveBeenCalledOnce()
    expect(setVolume).toHaveBeenLastCalledWith(0)
  })

  it('uses the rendered range in the same stage without source overlays or audio', () => {
    const session = createSession(metadata)
    session.playhead = 3
    const app = mount({ session, renderedPreview: { url: 'media://rendered', start: 2, end: 5 } })
    expect(app.querySelector('.preview-rendered-video')).not.toBeNull()
    expect(app.querySelector('.preview-source-video:not(.preview-rendered-video)')).toBeNull()
    expect(app.querySelector('.visual-overlay')).toBeNull()
    expect(app.querySelector('audio')).toBeNull()
    expect(app.querySelector('.transport')).not.toBeNull()
  })

  it('returns to source media outside the range and retains a full-project final frame', () => {
    const session = createSession(metadata)
    session.playhead = 3
    const rendered = { url: 'media://rendered', start: 2, end: 5 }
    const app = mount({ session, renderedPreview: rendered })
    expect(app.querySelector('.preview-rendered-video')).not.toBeNull()

    const sourceSession = { ...session, playhead: 1 }
    act(() => { root?.render(<Preview {...props({ session: sourceSession, renderedPreview: rendered })} />) })
    expect(app.querySelector('.preview-rendered-video')).toBeNull()
    expect(app.querySelector('.preview-source-video:not(.preview-rendered-video)')).not.toBeNull()

    const finalSession = { ...session, playhead: 10 }
    const fullRendered = { url: rendered.url, start: 0, end: 10 }
    act(() => { root?.render(<Preview {...props({ session: finalSession, renderedPreview: fullRendered })} />) })
    expect(app.querySelector('.preview-rendered-video')).not.toBeNull()
  })

  it('selects the rendered partial preview containing the current playhead', () => {
    const first = { url: 'media://first-rendered', start: 1, end: 2 }
    const second = { url: 'media://second-rendered', start: 6, end: 7 }
    const session = createSession(metadata)
    session.playhead = 1.5
    const app = mount({ session, renderedPreviews: [first, second] })
    expect(app.querySelector('.preview-rendered-video')?.getAttribute('src')).toContain(first.url)

    const secondSession = { ...session, playhead: 6.5 }
    act(() => { root?.render(<Preview {...props({ session: secondSession, renderedPreviews: [first, second] })} />) })
    expect(app.querySelector('.preview-rendered-video')?.getAttribute('src')).toContain(second.url)
  })

  it('handles focus picking, camera focus, and source media errors', () => {
    const session = createSession(metadata)
    session.focusZooms = [{ id: 'zoom', start: 0, duration: 5, zoom: 2, focusX: 0.5, focusY: 0.5 }]
    const onFocusZoom = vi.fn()
    const onCancelFocusPick = vi.fn()
    const onSelect = vi.fn()
    const app = mount({ session, focusPicking: 2, onFocusZoom, onCancelFocusPick, onSelect })
    const stage = app.querySelector('.preview-stage')
    if (!(stage instanceof HTMLDivElement)) throw new Error('preview stage missing')
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 100, height: 50, top: 0, left: 0, right: 100, bottom: 50, toJSON: () => ({})
    })
    const pointer = new Event('pointerdown', { bubbles: true })
    Object.defineProperties(pointer, { clientX: { value: 20 }, clientY: { value: 20 } })
    act(() => { stage.dispatchEvent(pointer) })
    expect(onFocusZoom).toHaveBeenCalledWith(2, 0.2, 0.4)
    expect(onCancelFocusPick).toHaveBeenCalledOnce()

    act(() => { root?.render(<Preview {...props({ session, onSelect, focusPicking: null })} />) })
    act(() => { stage.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(onSelect).toHaveBeenCalledWith(null)
    act(() => { root?.render(<Preview {...props({ session, onCancelFocusPick, focusPicking: 2 })} />) })
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onCancelFocusPick).toHaveBeenCalled()
    expect(app.querySelector('.camera-layer')?.getAttribute('style')).toContain('transform')

    const video = sourceVideo(app)
    act(() => { video.dispatchEvent(new Event('error')) })
    expect(app.querySelector('[role="alert"]')?.textContent).toContain('video cannot be shown')
    act(() => { video.dispatchEvent(new Event('loadeddata')) })
    expect(app.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps paused source seeks side-effect free and handles freeze or missing sources', () => {
    const session = createSession(metadata)
    session.playhead = 2
    const onPlayhead = vi.fn()
    const app = mount({ session, onPlayhead })
    const video = sourceVideo(app)
    mediaClock(video, 2)
    act(() => { video.dispatchEvent(new Event('seeked')); video.dispatchEvent(new Event('timeupdate')) })
    expect(onPlayhead).not.toHaveBeenCalled()

    const baseSegment = session.segments[0]
    if (!baseSegment || baseSegment.kind === 'freeze') throw new Error('default video segment missing')
    const missing: SourceSegment = { ...baseSegment, sourceId: 'missing' }
    const missingSession = sessionWithSegments([missing])
    act(() => { root?.render(<Preview {...props({ session: missingSession })} />) })
    expect(sourceVideo(app).getAttribute('src')).toBeNull()

    const source = session.sources[0]
    if (!source) throw new Error('default source missing')
    const freeze: SourceSegment = { kind: 'freeze', id: 'freeze', sourceId: source.id, sourceTime: 2, duration: 1 }
    const freezeSession = sessionWithSegments([freeze], 0.5)
    act(() => { root?.render(<Preview {...props({ session: freezeSession, playing: true })} />) })
    const freezeVideo = sourceVideo(app)
    mediaClock(freezeVideo, 2, 1)
    act(() => { freezeVideo.dispatchEvent(new Event('timeupdate')) })
  })
})
