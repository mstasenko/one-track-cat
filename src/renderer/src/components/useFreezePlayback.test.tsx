import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelinePosition } from '../model/timeline'
import { useFreezePlayback } from './useFreezePlayback'

const freezePosition: TimelinePosition = {
  segmentIndex: 0,
  segment: { kind: 'freeze', id: 'freeze', sourceId: 'source', sourceTime: 4, duration: 1 },
  outputStart: 12,
  sourceTime: 4
}

interface HarnessProps {
  video: HTMLVideoElement
  position: TimelinePosition
  playhead: number
  playing: boolean
  onPlayhead: (time: number) => void
}

function Harness({ video, position, playhead, playing, onPlayhead }: HarnessProps): null {
  const videoRef = useRef(video)
  useFreezePlayback(videoRef, position, playhead, playing, 20, onPlayhead)
  return null
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function render(props: HarnessProps): void {
  if (!root) {
    container = document.createElement('div')
    root = createRoot(container)
  }
  act(() => { root?.render(<Harness {...props} />) })
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function controlledClock(): { set: (value: number) => void } {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  return { set: (value: number): void => { now = value } }
}

describe('useFreezePlayback', () => {
  it('finishes a freeze when animation callbacks stop arriving and leaves no timer', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    const clock = controlledClock()
    const video = { pause: vi.fn() } as unknown as HTMLVideoElement
    const onPlayhead = vi.fn<(time: number) => void>()
    render({ video, position: freezePosition, playhead: 12, playing: true, onPlayhead })

    await act(async () => {
      clock.set(1500)
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(onPlayhead).toHaveBeenCalledOnce()
    expect(onPlayhead).toHaveBeenCalledWith(13)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resumes a partial freeze and reaches its end after the remaining duration', async () => {
    const clock = controlledClock()
    const video = { pause: vi.fn() } as unknown as HTMLVideoElement
    const onPlayhead = vi.fn<(time: number) => void>()
    render({ video, position: freezePosition, playhead: 12.4, playing: true, onPlayhead })

    await act(async () => {
      clock.set(300)
      await vi.advanceTimersByTimeAsync(16)
    })

    const partialTime = onPlayhead.mock.calls.at(-1)?.[0]
    if (typeof partialTime !== 'number') throw new Error('partial freeze did not advance')
    expect(partialTime).toBeCloseTo(12.7)
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => {
      clock.set(600)
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(onPlayhead).toHaveBeenLastCalledWith(13)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the freeze clock when paused', async () => {
    const clock = controlledClock()
    const video = { pause: vi.fn() } as unknown as HTMLVideoElement
    const onPlayhead = vi.fn()
    render({ video, position: freezePosition, playhead: 12, playing: true, onPlayhead })

    render({ video, position: freezePosition, playhead: 12, playing: false, onPlayhead })
    await act(async () => {
      clock.set(1500)
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(onPlayhead).not.toHaveBeenCalled()
  })

  it('cancels the freeze clock when unmounted', async () => {
    const clock = controlledClock()
    const video = { pause: vi.fn() } as unknown as HTMLVideoElement
    const onPlayhead = vi.fn()
    render({ video, position: freezePosition, playhead: 12, playing: true, onPlayhead })
    act(() => { root?.unmount() })
    await act(async () => {
      clock.set(1500)
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(onPlayhead).not.toHaveBeenCalled()
  })
})
