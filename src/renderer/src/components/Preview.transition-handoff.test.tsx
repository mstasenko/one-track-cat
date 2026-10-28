import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { EditSession } from '@shared/types'
import { createSession } from '../model/timeline'
import { Preview } from './Preview'
import { incomingTransitionVideo, mediaClock, metadata, mount, props, root, sourceVideo } from './preview-test-support'

const audioMixer = vi.hoisted(() => ({
  register: vi.fn((media: HTMLVideoElement) => () => { if (!media.isConnected) return }),
  setGain: vi.fn(),
  resume: vi.fn()
}))

vi.mock('./usePreviewAudioMixer', () => ({ usePreviewAudioMixer: () => audioMixer }))

function fadeTransitionSession(): EditSession {
  const session = createSession({ ...metadata, path: '/first.mp4', name: 'first.mp4' })
  const firstSource = session.sources[0]
  if (!firstSource) throw new Error('first source missing')
  session.sources.push({
    id: 'second-source', metadata: { ...metadata, path: '/second.mp4', name: 'second.mp4' },
    playbackPath: '/second.mp4', waveform: []
  })
  session.segments = [
    { id: 'first', sourceId: firstSource.id, sourceStart: 0, sourceEnd: 4 },
    { id: 'second', sourceId: 'second-source', sourceStart: 0, sourceEnd: 5, transition: { effect: 'fade', duration: 0.65 } },
    { id: 'third', sourceId: 'second-source', sourceStart: 0, sourceEnd: 5 }
  ]
  session.playhead = 3.75
  return session
}

function delayedBoundarySession(): EditSession {
  const session = fadeTransitionSession()
  session.playhead = 3.9
  return session
}

describe('Preview transition handoff', () => {
  it.each([
    { name: 'native RVFC', useTimeUpdate: false },
    { name: 'advancing timeupdate', useTimeUpdate: true }
  ])('retains the incoming decoder through transition end until the primary presents via $name', async ({ useTimeUpdate }) => {
    vi.useFakeTimers()
    try {
      const callbacks = new Map<HTMLVideoElement, VideoFrameRequestCallback[]>()
      let callbackId = 0
      Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
        configurable: true,
        value: vi.fn(function (this: HTMLVideoElement, callback: VideoFrameRequestCallback) {
          const pending = callbacks.get(this) ?? []
          pending.push(callback)
          callbacks.set(this, pending)
          callbackId += 1
          return callbackId
        })
      })
      Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
        configurable: true, value: vi.fn()
      })

      const unregister = new Map<HTMLVideoElement, ReturnType<typeof vi.fn>>()
      audioMixer.register.mockImplementation((media: HTMLVideoElement) => {
        const cleanup = vi.fn()
        unregister.set(media, cleanup)
        return cleanup
      })

      const session = fadeTransitionSession()
      const app = mount({ session, playing: true })
      const primary = sourceVideo(app)
      const incoming = incomingTransitionVideo(app)
      const outgoing = app.querySelector('.preview-transition-previous')
      if (!(outgoing instanceof HTMLVideoElement)) throw new Error('outgoing transition decoder missing')
      primary.play = vi.fn().mockResolvedValue(undefined)
      incoming.play = vi.fn().mockResolvedValue(undefined)
      const incomingPause = vi.fn()
      incoming.pause = incomingPause
      outgoing.play = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(incoming, 'paused', { configurable: true, value: false })
      mediaClock(primary, 3.75)
      mediaClock(incoming, 0)
      mediaClock(outgoing, 4)
      Object.defineProperty(incoming, 'readyState', { configurable: true, value: 2 })
      Object.defineProperty(outgoing, 'readyState', { configurable: true, value: 2 })
      Object.defineProperty(primary, 'readyState', { configurable: true, value: 4 })
      act(() => { primary.dispatchEvent(new Event('loadeddata')) })

      Object.defineProperty(primary, 'readyState', { configurable: true, value: 1 })
      const entered = { ...session, playhead: 4.25 }
      await act(async () => {
        root?.render(<Preview {...props({ session: entered, playing: true })} />)
        await Promise.resolve()
      })
      mediaClock(primary, 0.25)
      mediaClock(incoming, 0.25)
      act(() => { incoming.dispatchEvent(new Event('seeked')) })
      Object.defineProperty(primary, 'readyState', { configurable: true, value: 2 })
      act(() => { primary.dispatchEvent(new Event('loadeddata')) })
      act(() => { primary.dispatchEvent(new Event('seeked')) })
      expect(incoming.style.visibility).toBe('visible')

      const incomingCleanup = unregister.get(incoming)
      if (!incomingCleanup) throw new Error('incoming cleanup missing')
      const outgoingPlayCalls = (outgoing.play as ReturnType<typeof vi.fn>).mock.calls.length
      const ended = { ...entered, playhead: 4.8 }
      await act(async () => {
        root?.render(<Preview {...props({ session: ended, playing: true })} />)
        await Promise.resolve()
      })
      const incomingLayer = app.querySelector('.preview-transition-incoming-layer')
      if (!(incomingLayer instanceof HTMLElement)) throw new Error('incoming layer missing')
      expect(incoming.isConnected).toBe(true)
      expect(incomingCleanup).not.toHaveBeenCalled()
      expect(incomingLayer.style.opacity).toBe('1')
      expect(incoming.style.visibility).toBe('visible')
      expect(incoming.style.opacity).toBe('')
      expect(incoming.style.clipPath).toBe('')
      expect((outgoing.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(outgoingPlayCalls)
      act(() => { primary.dispatchEvent(new Event('seeked')) })

      const lastGain = (media: HTMLVideoElement): unknown =>
        audioMixer.setGain.mock.calls.filter((call: unknown[]) => call[0] === media).at(-1)?.[1] as unknown
      if (useTimeUpdate) {
        Object.defineProperty(primary, 'paused', { configurable: true, value: false })
        Object.defineProperty(primary, 'seeking', { configurable: true, value: false })
        mediaClock(primary, 0)
        mediaClock(incoming, 0)
        act(() => { primary.dispatchEvent(new Event('timeupdate')) })
        expect(lastGain(primary)).toBe(0)
        expect(lastGain(incoming)).toBe(1)
        mediaClock(primary, 0.8)
        mediaClock(incoming, 0.8)
        act(() => { primary.dispatchEvent(new Event('timeupdate')) })
      } else {
        mediaClock(primary, 0.8)
        mediaClock(incoming, 0.8)
        const releaseCallbacks = [...(callbacks.get(primary) ?? [])]
        if (releaseCallbacks.length === 0) throw new Error('primary RVFC missing')
        act(() => {
          for (const callback of releaseCallbacks) callback(0, { mediaTime: 0.8 } as VideoFrameCallbackMetadata)
        })
      }
      await act(async () => { await Promise.resolve() })
      expect(lastGain(incoming)).toBe(0)
      expect(incomingCleanup).not.toHaveBeenCalled()

      const incomingCallbacks = [...(callbacks.get(incoming) ?? [])]
      const drainingCallback = incomingCallbacks.at(-1)
      if (!drainingCallback) throw new Error('draining incoming RVFC missing')
      act(() => { drainingCallback(0, { mediaTime: 0.9 } as VideoFrameCallbackMetadata) })

      act(() => { vi.advanceTimersByTime(39) })
      expect(incomingCleanup).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(incomingCleanup).toHaveBeenCalledOnce()
      expect(incomingPause).toHaveBeenCalled()
      expect(app.querySelector('.preview-transition-incoming')).toBeNull()

      const third = { ...ended, playhead: 9.1 }
      await act(async () => {
        root?.render(<Preview {...props({ session: third, playing: false })} />)
        await Promise.resolve()
      })
      expect(primary.currentTime).toBeGreaterThan(0.08)
      expect(primary.currentTime).toBeLessThan(0.2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the secondary fallback through the 100 ms pre-transition handoff window', async () => {
    vi.useFakeTimers()
    try {
      const callbacks = new Map<HTMLVideoElement, VideoFrameRequestCallback[]>()
      let callbackId = 0
      Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
        configurable: true,
        value: vi.fn(function (this: HTMLVideoElement, callback: VideoFrameRequestCallback) {
          const pending = callbacks.get(this) ?? []
          pending.push(callback)
          callbacks.set(this, pending)
          callbackId += 1
          return callbackId
        })
      })
      Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', { configurable: true, value: vi.fn() })

      const unregister = new Map<HTMLVideoElement, ReturnType<typeof vi.fn>>()
      audioMixer.register.mockImplementation((media: HTMLVideoElement) => {
        const cleanup = vi.fn()
        unregister.set(media, cleanup)
        return cleanup
      })

      const session = delayedBoundarySession()
      const app = mount({ session, playing: true })
      const primary = sourceVideo(app)
      primary.play = vi.fn().mockResolvedValue(undefined)
      mediaClock(primary, 3.9)
      Object.defineProperty(primary, 'readyState', { configurable: true, value: 2 })
      act(() => { primary.dispatchEvent(new Event('loadeddata')) })

      const fallback = app.querySelector('.preview-transition-previous')
      if (!(fallback instanceof HTMLVideoElement)) throw new Error('secondary fallback missing')
      const reloaded = {
        ...session,
        playhead: 3.9,
        segments: session.segments.map((segment, index) => index === 0 ? { ...segment, id: 'first-reload' } : segment)
      }
      await act(async () => {
        Object.defineProperty(primary, 'readyState', { configurable: true, value: 1 })
        root?.render(<Preview {...props({ session: reloaded, playing: true })} />)
        await Promise.resolve()
      })
      const fallbackTime = 3.9
      const setFallbackTime = vi.fn()
      Object.defineProperty(fallback, 'currentTime', {
        configurable: true,
        get: () => fallbackTime,
        set: setFallbackTime
      })
      Object.defineProperty(fallback, 'readyState', { configurable: true, value: 2 })
      Object.defineProperty(fallback, 'paused', { configurable: true, value: false })
      fallback.play = vi.fn().mockResolvedValue(undefined)
      const pause = vi.fn()
      fallback.pause = pause
      act(() => { fallback.dispatchEvent(new Event('loadedmetadata')) })
      await act(async () => { await Promise.resolve() })
      Object.defineProperty(primary, 'readyState', { configurable: true, value: 2 })
      Object.defineProperty(primary, 'seeking', { configurable: true, value: false })
      Object.defineProperty(primary, 'paused', { configurable: true, value: false })
      mediaClock(primary, 3.9)
      act(() => { primary.dispatchEvent(new Event('loadeddata')) })
      const lastGain = (media: HTMLVideoElement): unknown =>
        audioMixer.setGain.mock.calls.filter((call: unknown[]) => call[0] === media).at(-1)?.[1] as unknown
      expect(lastGain(primary)).toBe(0)
      expect(fallback.paused).toBe(false)
      audioMixer.setGain.mockClear()
      const presented = [...(callbacks.get(primary) ?? [])]
      if (presented.length === 0) throw new Error('secondary handoff callback missing')
      act(() => {
        for (const callback of presented) callback(0, { mediaTime: 3.9 } as VideoFrameCallbackMetadata)
      })
      expect(audioMixer.setGain).not.toHaveBeenCalled()
      expect(pause).not.toHaveBeenCalled()
      expect(setFallbackTime).not.toHaveBeenCalled()
      expect(primary.style.visibility).toBe('hidden')
      expect(fallback.style.visibility).toBe('visible')
      const entered = { ...reloaded, playhead: 4.1 }
      await act(async () => {
        root?.render(<Preview {...props({ session: entered, playing: true })} />)
        await Promise.resolve()
      })
      const incomingLayer = app.querySelector('.preview-transition-incoming-layer')
      if (!(incomingLayer instanceof HTMLElement)) throw new Error('incoming layer missing')
      expect(incomingLayer.style.opacity).toBe('1')
    } finally {
      vi.useRealTimers()
    }
  })
})
