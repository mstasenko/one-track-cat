import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RenderedPreview } from './RenderedPreview'
import type { RenderedFacePreview } from '../model/use-face-preview'

let root: Root | undefined
let container: HTMLDivElement | undefined

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

describe('RenderedPreview', () => {
  it('maps local playback time to the global range and ignores paused updates', () => {
    const onPlayhead = vi.fn()
    const video = mount({ playing: true, onPlayhead })
    setMediaClock(video, 0.4)
    act(() => { video.dispatchEvent(new Event('timeupdate')) })
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
    act(() => { video.dispatchEvent(new Event('timeupdate')) })
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
    act(() => { video.dispatchEvent(new Event('timeupdate')) })
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
