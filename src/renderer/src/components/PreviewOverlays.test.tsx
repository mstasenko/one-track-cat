import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageOverlay, MediaMetadata, Overlay } from '@shared/types'
import { createSession } from '../model/timeline'
import type { PreviewAudioMixer } from './usePreviewAudioMixer'
import { PreviewOverlays } from './PreviewOverlays'

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

type VideoOverlay = Extract<Overlay, { type: 'video' }>
type AudioOverlay = Extract<Overlay, { type: 'audio' }>

function videoOverlay(): VideoOverlay {
  return {
    id: 'video-overlay', type: 'video', name: 'Clip', path: '/overlay.mp4',
    start: 0, duration: 10, zIndex: 1, x: 0, y: 0, width: 1, height: 1,
    opacity: 1, loop: false, audioEnabled: true, hasAudio: true,
    volume: 1, sourceIn: 0, sourceDuration: 10
  }
}

function audioOverlay(): AudioOverlay {
  return {
    id: 'audio-overlay', type: 'audio', name: 'Sound', path: '/overlay.ogg',
    start: 0, duration: 4, zIndex: 1, volume: 1, sourceIn: 5
  }
}

function imageOverlay(): ImageOverlay {
  return {
    id: 'image-overlay', type: 'image', name: 'Badge', path: '/badge.png',
    start: 0, duration: 1, zIndex: 1, x: 0, y: 0, width: 1, height: 1,
    opacity: 0.6, animation: 'fade'
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function mixer(): PreviewAudioMixer {
  return { register: vi.fn(() => () => undefined), setGain: vi.fn(), resume: vi.fn() }
}

function sessionWithOverlay(overlay: Overlay) {
  const session = createSession(metadata)
  session.overlays = [overlay]
  return session
}

function installBridge(getPathUrl: (path: string) => Promise<string>): void {
  Object.defineProperty(window, 'otc', {
    configurable: true,
    value: { getPathUrl }
  })
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function mount(session: ReturnType<typeof sessionWithOverlay>, playing: boolean, outputTime: number, audioMixer: PreviewAudioMixer): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const stageRef = { current: null } as React.RefObject<HTMLDivElement | null>
  act(() => {
    root?.render(<PreviewOverlays
      session={session}
      playing={playing}
      outputTime={outputTime}
      stageRef={stageRef}
      onSelect={vi.fn()}
      onChange={vi.fn()}
      onGestureStart={vi.fn()}
      onGestureEnd={vi.fn()}
      onGestureCancel={vi.fn()}
      mixer={audioMixer}
    />)
  })
  return container
}

function update(session: ReturnType<typeof sessionWithOverlay>, playing: boolean, outputTime: number, audioMixer: PreviewAudioMixer): void {
  act(() => {
    root?.render(<PreviewOverlays
      session={session}
      playing={playing}
      outputTime={outputTime}
      stageRef={{ current: null }}
      onSelect={vi.fn()}
      onChange={vi.fn()}
      onGestureStart={vi.fn()}
      onGestureEnd={vi.fn()}
      onGestureCancel={vi.fn()}
      mixer={audioMixer}
    />)
  })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

describe('preview overlay media synchronization', () => {
  it('resynchronizes playback and reapplies gain after a delayed media URL', async () => {
    const url = deferred<string>()
    installBridge(() => url.promise)
    const audioMixer = mixer()
    const app = mount(sessionWithOverlay(videoOverlay()), true, 2, audioMixer)
    const video = app.querySelector('video')
    if (!video) throw new Error('preview video missing')
    const play = vi.fn().mockResolvedValue(undefined)
    video.play = play
    expect(audioMixer.setGain).toHaveBeenCalledOnce()

    await act(async () => {
      url.resolve('media:/overlay.mp4')
      await url.promise
    })

    expect(video.src).toContain('/overlay.mp4')
    expect(video.currentTime).toBeCloseTo(2)
    expect(play).toHaveBeenCalled()
    expect(audioMixer.setGain).toHaveBeenCalledTimes(2)
  })

  it('only schedules overlay gain when the scalar changes', async () => {
    installBridge((path) => Promise.resolve(`media:${path}`))
    const audioMixer = mixer()
    const flatSession = sessionWithOverlay(videoOverlay())
    const app = mount(flatSession, true, 2, audioMixer)
    const video = app.querySelector('video')
    if (!video) throw new Error('preview video missing')
    video.play = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(audioMixer.setGain).toHaveBeenCalledTimes(2)
    update(flatSession, true, 3, audioMixer)
    expect(audioMixer.setGain).toHaveBeenCalledTimes(2)

    update(sessionWithOverlay({ ...videoOverlay(), volume: 0.5 }), true, 3, audioMixer)
    expect(audioMixer.setGain).toHaveBeenLastCalledWith(video, 0.5)

    update(sessionWithOverlay({ ...videoOverlay(), volume: 0.5, fadeIn: 1 }), true, 0.5, audioMixer)
    expect(audioMixer.setGain).toHaveBeenLastCalledWith(video, 0.25)

    update(sessionWithOverlay({ ...videoOverlay(), volume: 0.5, fadeIn: 1 }), true, 2, audioMixer)
    expect(audioMixer.setGain).toHaveBeenLastCalledWith(video, 0.5)
  })

  it('resynchronizes a paused nonzero source offset after metadata loads', async () => {
    installBridge((path) => Promise.resolve(`media:${path}`))
    const app = mount(sessionWithOverlay(audioOverlay()), false, 3, mixer())
    const audio = app.querySelector('audio')
    if (!audio) throw new Error('preview audio missing')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(audio.currentTime).toBe(4)

    Object.defineProperty(audio, 'duration', { configurable: true, value: 20 })
    act(() => { audio.dispatchEvent(new Event('loadedmetadata')) })

    expect(audio.currentTime).toBe(8)
  })

  it('fades image content while keeping user opacity on the parent selection layer', () => {
    installBridge((path) => Promise.resolve(`media:${path}`))
    const overlay = imageOverlay()
    const session = sessionWithOverlay(overlay)
    session.selectedOverlayId = overlay.id
    const audioMixer = mixer()
    const app = mount(session, false, 0, audioMixer)
    const image = (): HTMLImageElement => {
      const element = app.querySelector('img')
      if (!(element instanceof HTMLImageElement)) throw new Error('preview image missing')
      return element
    }

    expect(image().style.opacity).toBe('0')
    expect(image().parentElement?.style.opacity).toBe('0.6')
    expect(app.querySelector('.resize-handle')).not.toBeNull()

    update(session, false, 0.5, audioMixer)
    expect(image().style.opacity).toBe('1')
    update(session, false, 0.999, audioMixer)
    expect(Number(image().style.opacity)).toBeLessThan(0.001)
  })

  it('fades video content with the same envelope as image overlays', () => {
    installBridge((path) => Promise.resolve(`media:${path}`))
    const overlay: VideoOverlay = { ...videoOverlay(), duration: 1, sourceDuration: 1, opacity: 0.7, animation: 'fade' }
    const session = sessionWithOverlay(overlay)
    const audioMixer = mixer()
    const app = mount(session, false, 0, audioMixer)
    const video = (): HTMLVideoElement => {
      const element = app.querySelector('video')
      if (!(element instanceof HTMLVideoElement)) throw new Error('preview video missing')
      return element
    }

    expect(video().style.opacity).toBe('0')
    update(session, false, 0.5, audioMixer)
    expect(video().style.opacity).toBe('1')
    expect(video().parentElement?.style.opacity).toBe('0.7')
    update(session, false, 0.999, audioMixer)
    expect(Number(video().style.opacity)).toBeLessThan(0.001)
  })

  it('applies text animation transforms and explicit visual fade timing to media content', () => {
    installBridge((path) => Promise.resolve(`media:${path}`))
    const image = imageOverlay()
    const imageSession = sessionWithOverlay({ ...image, animation: 'pop' })
    const imageMixer = mixer()
    const imageApp = mount(imageSession, false, 0, imageMixer)
    const imageElement = imageApp.querySelector('img')
    if (!(imageElement instanceof HTMLImageElement)) throw new Error('preview image missing')
    expect(imageElement.style.opacity).toBe('0')
    expect(imageElement.style.transform).toContain('scale(0.65)')
    expect(imageElement.parentElement?.style.opacity).toBe('0.6')

    update(sessionWithOverlay({ ...image, animation: 'fade', animationFadeIn: 0.1, animationFadeOut: 0.1 }), false, 0.05, imageMixer)
    expect(Number(imageElement.style.opacity)).toBeCloseTo(0.5, 5)
    expect(imageElement.style.transform).toBe('translate(0%, 0%) scale(1)')

    act(() => { root?.unmount() })
    root = undefined
    container?.remove()
    container = undefined

    const video = { ...videoOverlay(), duration: 1, sourceDuration: 1, animation: 'bounce' as const }
    const videoApp = mount(sessionWithOverlay(video), false, 0, mixer())
    const videoElement = videoApp.querySelector('video')
    if (!(videoElement instanceof HTMLVideoElement)) throw new Error('preview video missing')
    expect(videoElement.style.opacity).toBe('0')
    expect(videoElement.style.transform).toContain('translate(0%, 20%) scale(0.92)')
  })
})
