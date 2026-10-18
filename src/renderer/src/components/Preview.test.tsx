import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { SourceSegment } from '@shared/types'
import { createSession } from '../model/timeline'
import { Preview } from './Preview'
import { root, metadata, props, mount, mediaClock, sourceVideo, incomingTransitionVideo, sessionWithSegments } from './preview-test-support'

describe('Preview', () => {

  it('waits for a decoded frame before starting playback', () => {
    const session = createSession(metadata)
    const app = mount({ session, playing: false })
    const video = sourceVideo(app)
    const play = vi.fn().mockResolvedValue(undefined)
    video.play = play
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })

    act(() => { root?.render(<Preview {...props({ session, playing: true })} />) })
    expect(play).not.toHaveBeenCalled()

    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
    act(() => { video.dispatchEvent(new Event('loadeddata')) })
    expect(play).not.toHaveBeenCalled()

    Object.defineProperty(video, 'readyState', { configurable: true, value: 3 })
    act(() => { video.dispatchEvent(new Event('canplay')) })
    expect(play).not.toHaveBeenCalled()

    Object.defineProperty(video, 'readyState', { configurable: true, value: 4 })
    act(() => { video.dispatchEvent(new Event('canplaythrough')) })
    expect(play).toHaveBeenCalledOnce()
  })

  it('shows the preloaded incoming clip when the frame clock reaches a transition before the main decoder switches', () => {
    const presented = new Map<HTMLVideoElement, VideoFrameRequestCallback[]>()
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn(function (this: HTMLVideoElement, callback: VideoFrameRequestCallback) {
        const callbacks = presented.get(this) ?? []
        callbacks.push(callback)
        presented.set(this, callbacks)
        return callbacks.length
      })
    })
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
      {
        id: 'second', sourceId: 'second-source', sourceStart: 0, sourceEnd: 5,
        transition: { effect: 'wipeleft', duration: 0.65 }
      }
    ]
    session.playhead = 3.9

    const onPlayhead = vi.fn()
    const app = mount({ session, playing: true, onPlayhead })
    const main = sourceVideo(app)
    mediaClock(main, 3.9)
    Object.defineProperty(main, 'readyState', { configurable: true, value: 4 })
    act(() => { main.dispatchEvent(new Event('loadeddata')) })

    const incoming = incomingTransitionVideo(app)
    mediaClock(incoming, 0)
    Object.defineProperty(incoming, 'readyState', { configurable: true, value: 2 })
    act(() => { incoming.dispatchEvent(new Event('loadedmetadata')) })
    act(() => { incoming.dispatchEvent(new Event('seeked')) })

    const outgoing = app.querySelector('.preview-transition-previous')
    if (!(outgoing instanceof HTMLVideoElement)) throw new Error('outgoing transition video missing')
    mediaClock(outgoing, 4)
    Object.defineProperty(outgoing, 'readyState', { configurable: true, value: 2 })
    act(() => { outgoing.dispatchEvent(new Event('loadedmetadata')) })
    act(() => { outgoing.dispatchEvent(new Event('seeked')) })

    act(() => { presented.get(incoming)?.[0]?.(0, { mediaTime: 0.75 } as VideoFrameCallbackMetadata) })
    act(() => { presented.get(main)?.[0]?.(0, { mediaTime: 4 } as VideoFrameCallbackMetadata) })
    expect(main.style.visibility).toBe('hidden')
    expect(incoming.style.visibility).toBe('visible')
    expect(incoming.dataset.transition).toBe('wipeleft')
    expect(outgoing.style.visibility).toBe('visible')

    act(() => { presented.get(incoming)?.[1]?.(0, { mediaTime: 1.075 } as VideoFrameCallbackMetadata) })
    expect(onPlayhead).toHaveBeenCalledWith(4.325)

    act(() => {
      root?.render(<Preview {...props({ session: { ...session, playhead: 4.325 }, playing: true, onPlayhead })} />)
    })
    expect(parseFloat(incomingTransitionVideo(app).style.clipPath.split(' ')[1] ?? '')).toBeCloseTo(50)
  })

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
    const transitionFallback = incomingTransitionVideo(app)
    mediaClock(transitionFallback, 4)
    Object.defineProperty(transitionFallback, 'readyState', { configurable: true, value: 2 })
    act(() => { transitionFallback.dispatchEvent(new Event('loadedmetadata')) })
    act(() => { transitionFallback.dispatchEvent(new Event('seeked')) })
    act(() => { incoming.dispatchEvent(new Event('loadeddata')) })
    expect(incoming.style.visibility).toBe('visible')
    expect(incomingTransitionVideo(app).style.opacity).toBe('0')

    const transitioned = { ...session, playhead: 4.25 }
    act(() => { root?.render(<Preview {...props({ session: transitioned, playing: true })} />) })
    incoming = sourceVideo(app)
    expect(incoming.style.visibility).toBe('hidden')
    expect(incomingTransitionVideo(app).style.visibility).toBe('visible')
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
    expect(app.querySelector('.preview-transition-incoming')).toBeNull()
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
    expect(fallback.style.opacity).toBe('0')

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
    expect(fallback.style.opacity).toBe('0')
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
