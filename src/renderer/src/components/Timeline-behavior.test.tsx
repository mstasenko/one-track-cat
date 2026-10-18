import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditSession, Overlay } from '@shared/types'
import { createSession } from '../model/timeline'
import { Timeline } from './Timeline'

vi.mock('./useMediaUrl', () => ({ useMediaUrl: (path: string) => path ? `media:${path}` : '' }))

const metadata = {
  path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
  width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true
}
const visual = { x: 0.1, y: 0.2, width: 0.3, height: 0.4, opacity: 0.8 }
const base = { start: 1, duration: 5, zIndex: 1 }
const text: Overlay = {
  ...base, ...visual, id: 'text', name: 'Caption', type: 'text', text: 'Hello',
  fontFamily: 'Arial', fontSize: 10, color: '#ffffff', outlineColor: '#000000',
  outlineWidth: 2, shadow: true, align: 'center', animation: 'pop'
}
const video: Overlay = {
  ...base, ...visual, id: 'video', name: 'Clip', type: 'video', path: '/clip.mp4',
  sourceIn: 2, sourceDuration: 10, loop: false, hasAudio: true, audioEnabled: true,
  volume: 1, fadeIn: 0.5, fadeOut: 1, duckGameAudio: true
}
type Props = Parameters<typeof Timeline>[0]
let root: Root | undefined
let container: HTMLDivElement | undefined

function mount(session: EditSession, overrides: Partial<Props> = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<Timeline session={session} zoom={1} onZoom={vi.fn()} onSeek={vi.fn()}
    onSelectOverlay={vi.fn()} selectedFaceBlurId={null} onSelectFaceBlur={vi.fn()}
    onOverlayChange={vi.fn()} onOverlayGestureStart={vi.fn()} onOverlayGestureEnd={vi.fn()}
    onOverlayGestureCancel={vi.fn()} {...overrides} />) })
  const track = container.querySelector('.timeline')
  if (!track) throw new Error('timeline missing')
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 200 } as DOMRect)
  return container
}

function pointer(target: EventTarget, type: string, options: Record<string, unknown> = {}): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: 160, clientY: 300, pointerType: 'mouse', buttons: 0, ...options })
  act(() => { target.dispatchEvent(event) })
}

function element(app: HTMLDivElement, selector: string): HTMLElement {
  const result = app.querySelector<HTMLElement>(selector)
  if (!result) throw new Error(`Missing ${selector}`)
  return result
}

beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }) })
afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('Timeline interactions', () => {
  it('clamps seeks to the timeline and zooms in either direction', () => {
    const onSeek = vi.fn()
    const onZoom = vi.fn()
    const app = mount(createSession(metadata), { onSeek, onZoom, zoom: 2 })
    const track = element(app, '.timeline')
    pointer(track, 'pointerdown', { clientX: 80 })
    pointer(track, 'pointerdown', { clientX: 400 })
    expect(onSeek.mock.calls).toEqual([[0], [10]])
    const scroll = element(app, '.timeline-scroll')
    act(() => { scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 })) })
    act(() => { scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 })) })
    expect(onZoom.mock.calls).toEqual([[2.25], [1.75]])
  })

  it('opens a clamped mouse-hover thumbnail, seeks it after metadata, and dismisses other pointer modes', () => {
    const app = mount(createSession(metadata))
    const track = element(app, '.timeline')
    pointer(track, 'pointermove')
    const popup = element(app, '.timeline-hover-preview')
    expect(popup.getAttribute('aria-label')).toContain('source.mp4')
    expect(popup.style.top).toBe('157px')
    const media = element(app, '.timeline-hover-camera > video:not(.preview-transition-previous)') as HTMLVideoElement
    act(() => { media.dispatchEvent(new Event('loadedmetadata')) })
    expect(media.currentTime).toBe(3)
    expect(media.muted).toBe(true)
    pointer(track, 'pointermove', { pointerType: 'touch' })
    expect(app.querySelector('.timeline-hover-preview')).toBeNull()
    pointer(track, 'pointermove', { buttons: 1 })
    expect(app.querySelector('.timeline-hover-preview')).toBeNull()
    pointer(track, 'pointermove', { clientY: 0, clientX: 300 })
    expect(element(app, '.timeline-hover-preview').style.top).toBe('18px')
    pointer(track, 'pointerout')
    expect(app.querySelector('.timeline-hover-preview')).toBeNull()
  })

  it('does not show thumbnails when the source or timeline is unavailable', () => {
    const session = createSession(metadata)
    const source = session.sources[0]
    if (!source) throw new Error('source missing')
    source.playbackPath = ''
    const app = mount(session)
    pointer(element(app, '.timeline'), 'pointermove')
    expect(app.querySelector('.timeline-hover-preview')).toBeNull()
    act(() => { root?.render(<Timeline session={{ ...session, segments: [] }} zoom={1} onZoom={vi.fn()}
      onSeek={vi.fn()} onSelectOverlay={vi.fn()} selectedFaceBlurId={null} onSelectFaceBlur={vi.fn()}
      onOverlayChange={vi.fn()} onOverlayGestureStart={vi.fn()} onOverlayGestureEnd={vi.fn()}
      onOverlayGestureCancel={vi.fn()} />) })
    pointer(element(app, '.timeline'), 'pointermove')
    expect(app.querySelector('.timeline-hover-preview')).toBeNull()
    expect(element(app, '.playhead').style.left).toBe('0%')
  })

  it('renders visual overlay thumbnails in stacking order while keeping audio out of the thumbnail', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(1)
    const session = createSession(metadata, true)
    session.canvas.shortFramePosition = 1
    session.overlays = [
      { ...text, zIndex: 3 }, video,
      { ...base, ...visual, id: 'image', name: 'Image', type: 'image', path: '/image.png', renderedImageDataUrl: 'data:image/png;base64,a', zIndex: 2 },
      { ...base, ...visual, id: 'gif', name: 'GIF', type: 'gif', path: '/gif.gif', playbackPath: '/gif.webm', sourceIn: 1, sourceDuration: 10, zIndex: 4 },
      { ...base, id: 'audio', name: 'Sound', type: 'audio', path: '/audio.ogg', sourceIn: 0, volume: 1 }
    ]
    const app = mount(session)
    pointer(element(app, '.timeline'), 'pointermove')
    const overlays = [...app.querySelectorAll('.timeline-hover-overlay')]
    expect(overlays.map((overlay) => overlay.getAttribute('aria-label'))).toEqual(['Clip', 'Image', 'Caption', 'GIF'])
    expect(element(app, '.timeline-hover-overlay img').getAttribute('src')).toBe('data:image/png;base64,a')
    expect(element(app, '.timeline-hover-text').textContent).toBe('Hello')
    expect(element(app, '[aria-label="Caption"]').style.textShadow).toBe('0 2px 4px #000')
    const videos = [...app.querySelectorAll<HTMLVideoElement>('.timeline-hover-overlay video')]
    expect(videos.map((media) => media.currentTime)).toEqual([4, 3])
    expect(videos.map((media) => media.getAttribute('src'))).toEqual(['media:/clip.mp4', 'media:/gif.webm'])
    expect(element(app, '.timeline-hover-camera > video:not(.preview-transition-previous)').style.objectPosition).toBe('100% 50%')
    const clip = [...app.querySelectorAll<HTMLButtonElement>('.timeline-overlay')].find((button) => button.textContent.includes('Clip'))
    if (!clip) throw new Error('Clip overlay missing')
    expect(clip.title).toContain('Fade 0.5s / 1s')
    expect(clip.title).toContain('lowers game sound to 30%')
    expect(clip.querySelectorAll('.overlay-fade')).toHaveLength(2)
    expect(clip.querySelector('.game-sound-badge')).not.toBeNull()
  })

  it('uses original image/GIF paths and plain captions without animation, shadow or enabled video audio', () => {
    const session = createSession(metadata)
    session.overlays = [
      { ...text, animation: undefined, shadow: false },
      { ...base, ...visual, id: 'image', name: 'Image', type: 'image', path: '/image.png' },
      { ...base, ...visual, id: 'gif', name: 'GIF', type: 'gif', path: '/gif.gif', sourceIn: 0, sourceDuration: 10 },
      { ...video, audioEnabled: false, fadeIn: undefined, fadeOut: undefined, duckGameAudio: false }
    ]
    const app = mount(session)
    pointer(element(app, '.timeline'), 'pointermove')
    expect(element(app, '.timeline-hover-overlay img').getAttribute('src')).toBe('media:/image.png')
    expect([...app.querySelectorAll<HTMLVideoElement>('.timeline-hover-overlay video')].map((media) => media.getAttribute('src'))).toContain('media:/gif.gif')
    expect(element(app, '[aria-label="Caption"]').style.textShadow).toBe('none')
    expect([...app.querySelectorAll<HTMLButtonElement>('.timeline-overlay')].map((button) => button.title)).toEqual(['Caption', 'Image', 'GIF', 'Clip'])
    expect(app.querySelector('.overlay-fade')).toBeNull()
  })

  it('drags overlays within project bounds and ends or cancels each gesture exactly once', () => {
    const session = createSession(metadata)
    session.overlays = [text]
    const onSelectOverlay = vi.fn()
    const onSeek = vi.fn()
    const onOverlayChange = vi.fn()
    const onOverlayGestureStart = vi.fn()
    const onOverlayGestureEnd = vi.fn()
    const onOverlayGestureCancel = vi.fn()
    const app = mount(session, { onSelectOverlay, onSeek, onOverlayChange, onOverlayGestureStart, onOverlayGestureEnd, onOverlayGestureCancel })
    const button = element(app, '.timeline-overlay')
    pointer(button, 'pointerdown', { clientX: 150 })
    pointer(window, 'pointermove', { clientX: 500 })
    pointer(window, 'pointerup')
    expect(onOverlayChange).toHaveBeenLastCalledWith('text', { start: 5 })
    pointer(window, 'pointermove', { clientX: 0 })
    expect(onOverlayChange).toHaveBeenCalledTimes(1)
    pointer(button, 'pointerdown', { clientX: 150 })
    pointer(window, 'pointermove', { clientX: 0 })
    pointer(window, 'pointercancel')
    expect(onOverlayChange).toHaveBeenLastCalledWith('text', { start: 0 })
    expect(onOverlayGestureStart).toHaveBeenCalledTimes(2)
    expect(onOverlayGestureEnd).toHaveBeenCalledOnce()
    expect(onOverlayGestureCancel).toHaveBeenCalledOnce()
    expect(onSelectOverlay).toHaveBeenCalledWith('text')
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('shows marks, selection, transition/focus/face bands and selects faces without seeking', () => {
    const session = createSession(metadata)
    session.marks = [2, 4]
    session.focusZooms = [{ id: 'focus', start: 1, duration: 2, zoom: 2, focusX: 0.5, focusY: 0.5 }]
    session.videoTransitions = [{ id: 'range', start: 3, duration: 1 }]
    session.faceBlurs = [{ id: 'face', start: 2, duration: 3, sensitivity: 0.5, detail: 'standard', holdSeconds: 0.5, strength: 0.5, style: 'blur' }]
    const onSelectFaceBlur = vi.fn()
    const onSeek = vi.fn()
    const app = mount(session, { selectedFaceBlurId: 'face', onSelectFaceBlur, onSeek })
    expect(app.querySelectorAll('.timeline-mark')).toHaveLength(2)
    expect(element(app, '.timeline-selection').style.width).toBe('20%')
    expect(element(app, '.focus-zoom-range').textContent).toBe('2×')
    expect(element(app, '.video-transition-range').textContent).toBe('Transition')
    const face = element(app, '.face-blur-range')
    expect(face.getAttribute('aria-pressed')).toBe('true')
    pointer(face, 'pointerdown')
    act(() => { face.click() })
    expect(onSelectFaceBlur).toHaveBeenCalledExactlyOnceWith('face')
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('distinguishes slow motion, replay, transitions, freeze frames and unavailable sources', () => {
    const session = createSession(metadata)
    const sourceId = session.sources[0]?.id
    if (!sourceId) throw new Error('source missing')
    session.segments = [
      { id: 'normal', sourceId, sourceStart: 0, sourceEnd: 1, playbackRate: 1 },
      { id: 'quarter', sourceId, sourceStart: 1, sourceEnd: 2, playbackRate: 0.25 },
      { id: 'half', sourceId, sourceStart: 2, sourceEnd: 3, playbackRate: 0.5, replayGroupId: 'replay' },
      { id: 'double', sourceId, sourceStart: 3, sourceEnd: 4, playbackRate: 2, transition: { effect: 'fade', duration: 0.5 } },
      { id: 'freeze', kind: 'freeze', sourceId, sourceTime: 4, duration: 1 },
      { id: 'missing', sourceId: 'unavailable', sourceStart: 0, sourceEnd: 1 }
    ]
    session.overlays = [
      { ...base, id: 'audio', name: 'Plain sound', type: 'audio', path: '/audio.ogg', sourceIn: 0, volume: 1 },
      { ...video, id: 'duck', fadeIn: 0, fadeOut: 0, gameAudioLevel: 0.15 }
    ]
    const app = mount(session)
    expect([...app.querySelectorAll('.speed-badge')].map((badge) => badge.textContent)).toEqual(['¼×', '½×', '2×'])
    expect(element(app, '.freeze-badge').textContent).toBe('❄ 1s')
    expect(app.querySelector('.replay-range')).not.toBeNull()
    expect([...app.querySelectorAll<HTMLElement>('.source-segment')].map((segment) => segment.title)).toEqual([
      'source.mp4', 'source.mp4', 'source.mp4 · Replay ½×', 'source.mp4 · fade 0.5s', 'source.mp4', 'Video'
    ])
    expect([...app.querySelectorAll<HTMLButtonElement>('.timeline-overlay')].map((button) => button.title)).toEqual([
      'Plain sound', 'Clip · lowers game sound to 15%'
    ])
  })
})
