import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageOverlay, MediaMetadata, Overlay } from '@shared/types'
import { createSession } from '../model/timeline'
import { Timeline } from './Timeline'

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 3,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

function imageOverlay(): ImageOverlay {
  return {
    id: 'image', type: 'image', name: 'Badge', path: '/badge.png', start: 0, duration: 3,
    zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 0.6, animation: 'fade'
  }
}

function videoOverlay(): Extract<Overlay, { type: 'video' }> {
  return {
    id: 'video', type: 'video', name: 'Clip', path: '/clip.mp4', start: 0, duration: 3,
    zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 0.6, animation: 'fade',
    loop: false, audioEnabled: false, hasAudio: false, volume: 1, sourceIn: 0, sourceDuration: 3
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function mount(
  session: ReturnType<typeof createSession>,
  onSeek: (time: number) => void = vi.fn(),
  onSelectFaceBlur: (id: string) => void = vi.fn(),
  selectedFaceBlurId: string | null = null
): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<Timeline
      session={session}
      zoom={1}
      onZoom={vi.fn()}
      onSeek={onSeek}
      onSelectOverlay={vi.fn()}
      selectedFaceBlurId={selectedFaceBlurId}
      onSelectFaceBlur={onSelectFaceBlur}
      onOverlayChange={vi.fn()}
      onOverlayGestureStart={vi.fn()}
      onOverlayGestureEnd={vi.fn()}
      onOverlayGestureCancel={vi.fn()}
    />)
  })
  return container
}

function movePointer(timeline: Element, clientX: number): void {
  const event = new Event('pointermove', { bubbles: true })
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: 100 },
    pointerType: { value: 'mouse' },
    buttons: { value: 0 }
  })
  act(() => { timeline.dispatchEvent(event) })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'otc', {
    configurable: true,
    value: { getPathUrl: (path: string): Promise<string> => Promise.resolve(`media:${path}`) }
  })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

describe('timeline hover overlay animation', () => {
  it('matches the preview fade envelope for image and video content', () => {
    for (const [overlay, selector] of [[imageOverlay(), '.timeline-hover-overlay img'], [videoOverlay(), '.timeline-hover-overlay video']] as const) {
      const session = createSession(metadata)
      session.overlays = [overlay]
      const app = mount(session)
      const timeline = app.querySelector('.timeline')
      if (!timeline) throw new Error('timeline missing')
      Object.defineProperty(timeline, 'getBoundingClientRect', {
        configurable: true,
        value: (): { left: number; width: number } => ({ left: 0, width: 100 })
      })

      movePointer(timeline, 0)
      const mediaAt = (): HTMLImageElement | HTMLVideoElement => {
        const media = app.querySelector(selector)
        if (!(media instanceof HTMLImageElement) && !(media instanceof HTMLVideoElement)) throw new Error('hover media missing')
        return media
      }
      expect(mediaAt().style.opacity).toBe('0')
      expect(mediaAt().parentElement?.style.opacity).toBe('0.6')

      movePointer(timeline, 50)
      expect(mediaAt().style.opacity).toBe('1')
      movePointer(timeline, 99.9)
      expect(Number(mediaAt().style.opacity)).toBeLessThan(0.001)

      act(() => { root?.unmount() })
      root = undefined
      container?.remove()
      container = undefined
    }
  })

  it('matches text animation transforms and custom visual fade timing for media hover', () => {
    const cases = [
      { overlay: { ...imageOverlay(), animation: 'pop' as const }, selector: '.timeline-hover-overlay img', transform: 'scale(0.65)' },
      { overlay: { ...videoOverlay(), animation: 'bounce' as const }, selector: '.timeline-hover-overlay video', transform: 'scale(0.92)' }
    ] as const
    for (const { overlay, selector, transform } of cases) {
      const session = createSession(metadata)
      session.overlays = [overlay]
      const app = mount(session)
      const timeline = app.querySelector('.timeline')
      if (!timeline) throw new Error('timeline missing')
      Object.defineProperty(timeline, 'getBoundingClientRect', {
        configurable: true,
        value: (): { left: number; width: number } => ({ left: 0, width: 100 })
      })
      movePointer(timeline, 0)
      const media = app.querySelector(selector)
      if (!(media instanceof HTMLImageElement) && !(media instanceof HTMLVideoElement)) throw new Error('hover media missing')
      expect(media.style.opacity).toBe('0')
      expect(media.style.transform).toContain(transform)

      act(() => { root?.unmount() })
      root = undefined
      container?.remove()
      container = undefined
    }

    const timed = { ...imageOverlay(), animation: 'fade' as const, animationFadeIn: 0.1, animationFadeOut: 0.1 }
    const timedSession = createSession(metadata)
    timedSession.overlays = [timed]
    const timedApp = mount(timedSession)
    const timedTimeline = timedApp.querySelector('.timeline')
    if (!timedTimeline) throw new Error('timeline missing')
    Object.defineProperty(timedTimeline, 'getBoundingClientRect', {
      configurable: true,
      value: (): { left: number; width: number } => ({ left: 0, width: 100 })
    })
    movePointer(timedTimeline, 100 * (0.05 / metadata.duration))
    const timedMedia = timedApp.querySelector('.timeline-hover-overlay img')
    if (!(timedMedia instanceof HTMLImageElement)) throw new Error('timed hover image missing')
    expect(Number(timedMedia.style.opacity)).toBeCloseTo(0.5, 5)
  })
})

describe('face blur timeline ranges', () => {
  it('renders labeled face-blur bands and selects their settings without seeking', () => {
    const session = createSession(metadata)
    session.faceBlurs = [{
      id: 'face-range', start: 0.5, duration: 1.25, sensitivity: 0.7, detail: 'standard',
      holdSeconds: 0.3, strength: 0.7, style: 'pixelate'
    }]
    const onSeek = vi.fn()
    const onSelectFaceBlur = vi.fn()
    const app = mount(session, onSeek, onSelectFaceBlur)
    const marker = app.querySelector('.face-blur-range')
    if (!(marker instanceof HTMLButtonElement)) throw new Error('face blur marker missing')
    expect(marker.textContent).toContain('Face blur')
    expect(marker.style.left).toBe(`${(0.5 / metadata.duration) * 100}%`)
    expect(marker.style.width).toBe(`${(1.25 / metadata.duration) * 100}%`)

    act(() => { marker.click() })
    expect(onSelectFaceBlur).toHaveBeenCalledWith('face-range')
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('marks the explicitly selected face-blur band', () => {
    const session = createSession(metadata)
    session.faceBlurs = [{
      id: 'face-range', start: 0.5, duration: 1.25, sensitivity: 0.7, detail: 'standard',
      holdSeconds: 0.3, strength: 0.7, style: 'pixelate'
    }]
    const app = mount(session, vi.fn(), vi.fn(), 'face-range')
    const marker = app.querySelector('.face-blur-range')
    if (!(marker instanceof HTMLButtonElement)) throw new Error('face blur marker missing')
    expect(marker.classList.contains('selected')).toBe(true)
    expect(marker.getAttribute('aria-pressed')).toBe('true')
  })
})
