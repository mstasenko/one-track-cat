import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, vi } from 'vitest'
import type { EditSession, MediaMetadata, SourceSegment } from '@shared/types'
import { createSession } from '../model/timeline'
import type { PreviewProps } from './Preview'
import { Preview } from './Preview'

export let root: Root | undefined
let container: HTMLDivElement | undefined
let requestVideoFrameCallback: PropertyDescriptor | undefined
let cancelVideoFrameCallback: PropertyDescriptor | undefined

export const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
  width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true
}

export function props(overrides: Partial<PreviewProps> = {}): PreviewProps {
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
    onClearMark: vi.fn(),
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

export function mount(input: Partial<PreviewProps> = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<Preview {...props(input)} />) })
  return container
}

export function mediaClock(video: HTMLVideoElement, currentTime: number, duration = 10): void {
  let time = currentTime
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => { time = value }
  })
  Object.defineProperty(video, 'duration', { configurable: true, value: duration })
}

export function sourceVideo(app: HTMLDivElement): HTMLVideoElement {
  const video = app.querySelector('.preview-source-video:not(.preview-rendered-video, .preview-transition-previous)')
  if (!(video instanceof HTMLVideoElement)) throw new Error('source video missing')
  return video
}

export function incomingTransitionVideo(app: HTMLDivElement): HTMLVideoElement {
  const video = app.querySelector('.preview-transition-incoming')
  if (!(video instanceof HTMLVideoElement)) throw new Error('incoming transition fallback missing')
  return video
}

export function sessionWithSegments(segments: SourceSegment[], playhead = 0): EditSession {
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
