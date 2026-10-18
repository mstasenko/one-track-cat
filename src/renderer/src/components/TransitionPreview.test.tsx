import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransitionPreview } from '../model/transitions'
import { IncomingTransitionVideo, OutgoingTransitionVideo } from './TransitionPreview'
import type { PreviewAudioMixer } from './usePreviewAudioMixer'

let root: Root | undefined
let container: HTMLDivElement | undefined

function preview(previousSourceTime: number): TransitionPreview {
  return {
    active: { effect: 'fade', duration: 1, previousSegmentIndex: 0, progress: 0.5 },
    currentSourceTime: 1,
    currentPath: 'media://current.mp4',
    currentPlaybackRate: 1,
    previousSourceTime,
    previousPath: 'media://previous.mp4',
    previousPlaybackRate: 1,
    styles: { current: {}, previous: {} }
  }
}

function mount(input: TransitionPreview, playing: boolean): HTMLVideoElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<OutgoingTransitionVideo preview={input} fit="contain" playing={playing} />)
  })
  const video = container.querySelector('video')
  if (!(video instanceof HTMLVideoElement)) throw new Error('outgoing transition video missing')
  return video
}

function mediaClock(video: HTMLVideoElement, initialTime: number): {
  setter: ReturnType<typeof vi.fn>
  setTime: (value: number) => void
  time: () => number
} {
  let time = initialTime
  const setter = vi.fn((value: number) => { time = value })
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: setter
  })
  Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
  return { setter, setTime: (value) => { time = value }, time: () => time }
}

interface PreloadProps {
  playing: boolean
  preloadPath: string
  preloadRate: number
  showFallback: boolean
  audibleFallback: boolean
  fallbackGain: number
  mixer: PreviewAudioMixer
}

interface MixerHarness {
  mixer: PreviewAudioMixer
  setGain: ReturnType<typeof vi.fn>
}

function makeMixer(): MixerHarness {
  const setGain = vi.fn()
  return {
    mixer: {
      register: vi.fn(() => () => undefined),
      setGain,
      resume: vi.fn()
    },
    setGain
  }
}

function preloadProps(mixer: PreviewAudioMixer, overrides: Partial<PreloadProps> = {}): PreloadProps {
  return {
    playing: false,
    preloadPath: 'media://preloaded.mp4',
    preloadRate: 0,
    showFallback: false,
    audibleFallback: false,
    fallbackGain: 1,
    mixer,
    ...overrides
  }
}

function renderPreload(input: PreloadProps): void {
  act(() => {
    root?.render(<OutgoingTransitionVideo preview={null} fit="contain" preloadTime={0} {...input} />)
  })
}

function mountPreload(input: PreloadProps): HTMLVideoElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  renderPreload(input)
  const video = container.querySelector('video')
  if (!(video instanceof HTMLVideoElement)) throw new Error('preloaded video missing')
  return video
}

function preparePreloaded(): MixerHarness & { video: HTMLVideoElement } {
  const harness = makeMixer()
  const video = mountPreload(preloadProps(harness.mixer))
  Object.defineProperty(video, 'readyState', { configurable: true, value: 4 })
  act(() => { video.dispatchEvent(new Event('loadedmetadata')) })
  expect(harness.setGain.mock.calls.at(-1)?.[1]).toBe(0)
  harness.setGain.mockClear()
  return { ...harness, video }
}

async function flushPlayback(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('OutgoingTransitionVideo', () => {
  it('keeps a preloaded incoming clip ready for the first transition frame', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root?.render(<IncomingTransitionVideo
        preview={null}
        fit="contain"
        preloadPath="media://current.mp4"
        preloadTime={1}
      />)
    })
    const video = container.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('incoming transition video missing')
    const clock = mediaClock(video, 0)
    const play = vi.fn().mockResolvedValue(undefined)
    video.play = play
    act(() => { video.dispatchEvent(new Event('loadedmetadata')) })
    clock.setTime(1)
    act(() => { video.dispatchEvent(new Event('seeked')) })
    expect(video.style.visibility).toBe('visible')
    expect(video.style.opacity).toBe('0')

    const active = preview(4)
    active.active.effect = 'wipeleft'
    active.styles.current = { clipPath: 'inset(0 50% 0 0)' }
    act(() => {
      root?.render(<IncomingTransitionVideo preview={active} fit="contain" playing />)
    })

    expect(video.src).toContain('current.mp4')
    expect(video.style.visibility).toBe('visible')
    expect(video.style.clipPath).toBe('inset(0 50% 0 0)')
    expect(play).toHaveBeenCalledOnce()
  })

  it('repositions an inactive preloader while the main timeline is playing', () => {
    const harness = makeMixer()
    const input = preloadProps(harness.mixer, {
      playing: true,
      preloadRate: 0
    })
    const video = mountPreload(input)
    const clock = mediaClock(video, 8)
    act(() => { video.dispatchEvent(new Event('loadedmetadata')) })

    act(() => {
      root?.render(<OutgoingTransitionVideo
        preview={null}
        fit="contain"
        preloadPath={input.preloadPath}
        preloadTime={2}
        preloadRate={0}
        playing
        mixer={harness.mixer}
      />)
    })

    expect(clock.time()).toBe(2)
  })

  it('shows a transition frame when decoding becomes ready after its seek', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root?.render(<IncomingTransitionVideo
        preview={preview(4)}
        fit="contain"
        playing
      />)
    })
    const video = container.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('incoming transition video missing')
    mediaClock(video, 1)
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    act(() => { video.dispatchEvent(new Event('seeked')) })
    expect(video.style.visibility).toBe('hidden')

    video.currentTime = 1.5
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
    act(() => { video.dispatchEvent(new Event('canplay')) })
    expect(video.style.visibility).toBe('visible')
  })

  it('starts from a predecoded outgoing overlap without another seek', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root?.render(<OutgoingTransitionVideo
        preview={null}
        fit="contain"
        playing
        preloadPath="media://previous.mp4"
        preloadTime={4}
      />)
    })
    const video = container.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('outgoing transition video missing')
    const clock = mediaClock(video, 0)
    const play = vi.fn().mockResolvedValue(undefined)
    video.play = play
    act(() => { video.dispatchEvent(new Event('loadedmetadata')) })
    clock.setTime(4)
    act(() => { video.dispatchEvent(new Event('seeked')) })
    clock.setter.mockClear()

    act(() => {
      root?.render(<OutgoingTransitionVideo preview={preview(4)} fit="contain" playing />)
    })

    expect(clock.setter).not.toHaveBeenCalled()
    expect(video.style.visibility).toBe('visible')
    expect(play).toHaveBeenCalledOnce()
  })

  it('starts playback and does not seek on changing preview times while playing', () => {
    const initial = preview(4)
    const video = mount(initial, true)
    expect(video.getAttribute('crossorigin')).toBe('anonymous')
    const clock = mediaClock(video, 0)
    const play = vi.fn().mockResolvedValue(undefined)
    video.play = play

    act(() => { video.dispatchEvent(new Event('loadedmetadata')) })
    expect(play).toHaveBeenCalledOnce()
    expect(clock.setter).toHaveBeenCalledWith(4)
    expect(video.style.visibility).toBe('hidden')
    act(() => { video.dispatchEvent(new Event('seeked')) })
    expect(video.style.visibility).toBe('visible')

    clock.setter.mockClear()
    clock.setTime(4.2)
    act(() => {
      root?.render(<OutgoingTransitionVideo preview={preview(4.5)} fit="contain" playing />)
    })

    expect(clock.setter).not.toHaveBeenCalled()
    expect(clock.time()).toBe(4.2)
    expect(play).toHaveBeenCalledOnce()
    expect(video.style.visibility).toBe('visible')
  })

  it('seeks to changing preview times while paused', () => {
    const video = mount(preview(4), false)
    const clock = mediaClock(video, 0)
    act(() => { video.dispatchEvent(new Event('loadedmetadata')) })
    expect(clock.setter).toHaveBeenCalledWith(4)

    clock.setter.mockClear()
    act(() => {
      root?.render(<OutgoingTransitionVideo preview={preview(5.25)} fit="contain" />)
    })

    expect(clock.setter).toHaveBeenCalledWith(5.25)
    expect(clock.time()).toBe(5.25)
  })

  it('does not reveal a stale frame from an unfinished seek', () => {
    const video = mount(preview(4), false)
    const clock = mediaClock(video, 0)
    act(() => { video.dispatchEvent(new Event('loadedmetadata')) })
    clock.setTime(0)

    act(() => { video.dispatchEvent(new Event('loadeddata')) })
    expect(video.style.visibility).toBe('hidden')
    act(() => { video.dispatchEvent(new Event('seeked')) })
    expect(video.style.visibility).toBe('hidden')

    clock.setTime(4)
    act(() => { video.dispatchEvent(new Event('seeked')) })
    expect(video.style.visibility).toBe('visible')
  })

  it('keeps a preloaded fallback muted until its pending playback starts', async () => {
    const harness = preparePreloaded()
    const resolvers: (() => void)[] = []
    harness.video.play = vi.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve) }))

    renderPreload(preloadProps(harness.mixer, {
      playing: true,
      preloadRate: 1,
      showFallback: true,
      audibleFallback: true
    }))
    expect(harness.setGain.mock.calls.every((call) => call[1] === 0)).toBe(true)
    const resolveGain = resolvers.at(-1)
    if (!resolveGain) throw new Error('fallback play promise missing')

    resolveGain()
    await flushPlayback()
    expect(harness.setGain).toHaveBeenLastCalledWith(harness.video, 1)
  })

  it('keeps a fallback muted when playback is rejected', async () => {
    const harness = preparePreloaded()
    harness.video.play = vi.fn(() => Promise.reject(new Error('autoplay blocked')))

    renderPreload(preloadProps(harness.mixer, {
      playing: true,
      preloadRate: 1,
      showFallback: true,
      audibleFallback: true
    }))
    await flushPlayback()
    expect(harness.setGain.mock.calls.every((call) => call[1] === 0)).toBe(true)
  })

  it.each(['audible fallback removed', 'paused', 'source path changed'] as const)(
    'does not let a stale play resolution unmute after %s', async (change) => {
      const harness = preparePreloaded()
      const resolvers: (() => void)[] = []
      harness.video.play = vi.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve) }))
      const active = preloadProps(harness.mixer, {
        playing: true,
        preloadRate: 1,
        showFallback: true,
        audibleFallback: true
      })
      renderPreload(active)
      const resolveStaleGain = resolvers.at(-1)
      if (!resolveStaleGain) throw new Error('fallback play promise missing')
      const callsBeforeChange = harness.setGain.mock.calls.length

      renderPreload({
        ...active,
        ...(change === 'audible fallback removed' ? { audibleFallback: false } : {}),
        ...(change === 'paused' ? { playing: false } : {}),
        ...(change === 'source path changed' ? { preloadPath: 'media://changed.mp4' } : {})
      })
      resolveStaleGain()
      await flushPlayback()

      expect(harness.setGain.mock.calls.slice(callsBeforeChange).every((call) => call[1] === 0)).toBe(true)
    }
  )

  it('does not unmute when a pending play resolves after unmount', async () => {
    const harness = preparePreloaded()
    const resolvers: (() => void)[] = []
    harness.video.play = vi.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve) }))
    renderPreload(preloadProps(harness.mixer, {
      playing: true,
      preloadRate: 1,
      showFallback: true,
      audibleFallback: true
    }))
    const resolveGain = resolvers.at(-1)
    if (!resolveGain) throw new Error('fallback play promise missing')

    act(() => { root?.unmount() })
    root = undefined
    resolveGain()
    await flushPlayback()
    expect(harness.setGain.mock.calls.every((call) => call[1] === 0)).toBe(true)
  })

  it('applies a changed fallback gain after playback has started', async () => {
    const harness = preparePreloaded()
    harness.video.play = vi.fn().mockResolvedValue(undefined)
    renderPreload(preloadProps(harness.mixer, {
      playing: true,
      preloadRate: 1,
      showFallback: true,
      audibleFallback: true,
      fallbackGain: 0.25
    }))
    await flushPlayback()
    expect(harness.setGain).toHaveBeenLastCalledWith(harness.video, 0.25)

    const callsBeforeGainChange = harness.setGain.mock.calls.length
    renderPreload(preloadProps(harness.mixer, {
      playing: true,
      preloadRate: 1,
      showFallback: true,
      audibleFallback: true,
      fallbackGain: 0.75
    }))
    await flushPlayback()
    expect(harness.setGain.mock.calls.slice(callsBeforeGainChange).some((call) => call[1] === 0)).toBe(false)
    expect(harness.setGain).toHaveBeenLastCalledWith(harness.video, 0.75)
  })
})
