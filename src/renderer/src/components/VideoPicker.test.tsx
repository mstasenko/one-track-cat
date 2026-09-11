import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoDirectory } from '@shared/video-picker'
import { chooseVideo, finishVideoChoice } from '../model/video-picker'
import { VideoPicker } from './VideoPicker'

const directory: VideoDirectory = {
  path: '/videos',
  parent: '/',
  truncated: false,
  entries: [
    { path: '/videos/Clips', name: 'Clips', kind: 'directory' },
    { path: '/videos/clip.mp4', name: 'clip.mp4', kind: 'video' },
    { path: '/videos/second.webm', name: 'second.webm', kind: 'video' }
  ]
}

let root: Root | undefined
let container: HTMLDivElement | undefined
let originalShowModal: PropertyDescriptor | undefined
let originalClose: PropertyDescriptor | undefined
let originalLoad: PropertyDescriptor | undefined
let api: {
  listVideoDirectory: ReturnType<typeof vi.fn>
  authorizeVideo: ReturnType<typeof vi.fn>
  getPathUrl: ReturnType<typeof vi.fn>
  openVideo: ReturnType<typeof vi.fn>
}

function mount(): { app: HTMLDivElement; choice: Promise<string | null> } {
  const choice = chooseVideo()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<VideoPicker />) })
  return { app: container, choice }
}

function videoButton(app: HTMLDivElement, name = 'clip.mp4'): HTMLButtonElement {
  const button = app.querySelector(`[data-video-path="/videos/${name}"]`)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Video button ${name} missing`)
  return button
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function pointerEnter(target: HTMLElement, relatedTarget: EventTarget | null = null): void {
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget }))
}

function pointerLeave(target: HTMLElement, relatedTarget: EventTarget | null = null): void {
  target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget }))
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  api = {
    listVideoDirectory: vi.fn().mockResolvedValue(directory),
    authorizeVideo: vi.fn().mockImplementation((path: string) => Promise.resolve(path)),
    getPathUrl: vi.fn().mockImplementation((path: string) => Promise.resolve(`media:${path}`)),
    openVideo: vi.fn().mockResolvedValue(null)
  }
  Object.defineProperty(window, 'otc', { configurable: true, value: api })
  originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
  originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
  originalLoad = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'load')
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function close(this: HTMLDialogElement) {
      this.open = false
      this.dispatchEvent(new Event('close'))
    })
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'load', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  finishVideoChoice(null)
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close
  if (originalLoad) Object.defineProperty(HTMLMediaElement.prototype, 'load', originalLoad)
  else delete (HTMLMediaElement.prototype as Partial<HTMLMediaElement>).load
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('VideoPicker', () => {
  it('debounces hover and stops a preview when the pointer leaves', async () => {
    const { app } = mount()
    await flush()
    const button = videoButton(app)
    const video = app.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('preview video missing')
    const play = vi.spyOn(video, 'play').mockClear()
    const pause = vi.spyOn(video, 'pause').mockClear()

    act(() => { pointerEnter(button) })
    await act(async () => { await vi.advanceTimersByTimeAsync(149) })
    expect(api.authorizeVideo).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await flush()
    expect(api.authorizeVideo).toHaveBeenCalledWith('/videos/clip.mp4')
    expect(play).toHaveBeenCalledOnce()
    expect(video.muted).toBe(true)
    expect(video.loop).toBe(true)

    act(() => { pointerLeave(button) })
    expect(pause).toHaveBeenCalled()
    expect(video.getAttribute('src')).toBeNull()
  })

  it('ignores a stale authorization and does not start playback after leave', async () => {
    let resolveAuthorization!: (path: string) => void
    api.authorizeVideo.mockReturnValueOnce(new Promise<string>((resolve) => { resolveAuthorization = resolve }))
    const { app } = mount()
    await flush()
    const button = videoButton(app)
    const video = app.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('preview video missing')
    const play = vi.spyOn(video, 'play').mockClear()

    act(() => { pointerEnter(button) })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(api.authorizeVideo).toHaveBeenCalledOnce()
    act(() => { pointerLeave(button) })
    resolveAuthorization('/videos/clip.mp4')
    await flush()

    expect(api.getPathUrl).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
  })

  it('does not let a late play completion from A stop a newer B preview', async () => {
    let resolveA!: () => void
    const { app } = mount()
    await flush()
    const first = videoButton(app, 'clip.mp4')
    const second = videoButton(app, 'second.webm')
    const video = app.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('preview video missing')
    const play = vi.spyOn(video, 'play').mockClear()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveA = resolve }))
      .mockImplementation(() => Promise.resolve())
    const pause = vi.spyOn(video, 'pause').mockClear()

    act(() => { pointerEnter(first) })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    await flush()
    expect(play).toHaveBeenCalledOnce()

    act(() => {
      pointerLeave(first, second)
      pointerEnter(second, first)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    await flush()
    expect(play).toHaveBeenCalledTimes(2)
    expect(video.getAttribute('src')).toBe('media:/videos/second.webm')
    const pauseCountAfterB = pause.mock.calls.length

    resolveA()
    await flush()
    expect(video.getAttribute('src')).toBe('media:/videos/second.webm')
    expect(pause).toHaveBeenCalledTimes(pauseCountAfterB)
  })

  it('releases a failed current preview and keeps Cancel usable', async () => {
    const { app, choice } = mount()
    await flush()
    const button = videoButton(app)
    const video = app.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('preview video missing')
    const pause = vi.spyOn(video, 'pause').mockClear()
    vi.spyOn(video, 'play').mockClear().mockRejectedValueOnce(new Error('autoplay blocked'))

    act(() => { pointerEnter(button) })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    await flush()

    expect(video.getAttribute('src')).toBeNull()
    expect(pause).toHaveBeenCalled()
    expect(app.querySelector('[role="alert"]')?.textContent).toContain('autoplay blocked')
    const cancel = [...app.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Cancel')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('Cancel button missing')
    act(() => { cancel.click() })
    await expect(choice).resolves.toBeNull()
  })

  it('clears a failed A preview when a successful B preview is hovered', async () => {
    const { app } = mount()
    await flush()
    const first = videoButton(app, 'clip.mp4')
    const second = videoButton(app, 'second.webm')
    const video = app.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('preview video missing')
    vi.spyOn(video, 'play')
      .mockClear()
      .mockRejectedValueOnce(new Error('A preview failed'))
      .mockImplementation(() => Promise.resolve())

    act(() => { pointerEnter(first) })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    await flush()
    expect(app.querySelector('[role="alert"]')?.textContent).toContain('A preview failed')

    act(() => {
      pointerLeave(first, second)
      pointerEnter(second, first)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    await flush()
    expect(video.getAttribute('src')).toBe('media:/videos/second.webm')
    expect(app.querySelector('[role="alert"]')).toBeNull()
  })

  it('starts the same preview for keyboard focus and handles native Browse fallback', async () => {
    const { app, choice } = mount()
    await flush()
    const button = videoButton(app)
    const video = app.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('preview video missing')
    const play = vi.spyOn(video, 'play').mockClear()
    const pause = vi.spyOn(video, 'pause').mockClear()
    act(() => { button.focus() })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    await flush()
    expect(api.getPathUrl).toHaveBeenCalledWith('/videos/clip.mp4')
    expect(play).toHaveBeenCalledOnce()

    api.openVideo.mockResolvedValue('/native/native.mp4')
    const browse = [...app.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Browse…')
    if (!(browse instanceof HTMLButtonElement)) throw new Error('Browse button missing')
    act(() => { browse.click() })
    await flush()
    await expect(choice).resolves.toBe('/native/native.mp4')
    expect(api.openVideo).toHaveBeenCalledOnce()
    expect(api.authorizeVideo).toHaveBeenCalledTimes(1)
    expect(pause).toHaveBeenCalled()
  })

  it('does not reveal a directory response that arrives after cancellation', async () => {
    let resolveDirectory!: (value: VideoDirectory) => void
    api.listVideoDirectory.mockReturnValueOnce(new Promise<VideoDirectory>((resolve) => { resolveDirectory = resolve }))
    const { app, choice } = mount()
    await flush()
    const cancel = [...app.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Cancel')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('Cancel button missing')
    act(() => { cancel.click() })
    await expect(choice).resolves.toBeNull()
    resolveDirectory(directory)
    await flush()
    expect(app.querySelector('[data-video-path]')).toBeNull()
  })

  it('authorizes a selected file and leaves preview playback unused', async () => {
    api.authorizeVideo.mockResolvedValue('/canonical/clip.mp4')
    const { app, choice } = mount()
    await flush()
    act(() => { videoButton(app).click() })
    await flush()
    await expect(choice).resolves.toBe('/canonical/clip.mp4')
    expect(api.getPathUrl).not.toHaveBeenCalled()
    const video = app.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('preview video missing')
    const play = vi.spyOn(video, 'play').mockClear()
    expect(play).not.toHaveBeenCalled()
  })
})
