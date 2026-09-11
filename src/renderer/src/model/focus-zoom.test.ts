import { describe, expect, it } from 'vitest'
import { focusZoomAmounts } from '@shared/types'
import { addFocusZoom, focusCameraTransformAtTime, focusCropAtTime, removeFocusZoomFromRange } from './focus-zoom'
import { createSession, timelineDuration } from './timeline'
import { timedRangesAfterRemoval } from './timed-ranges'
import type { MediaMetadata } from '@shared/types'

const source: MediaMetadata = { path: '/video.mp4', name: 'video.mp4', size: 1, modifiedAt: 1, duration: 10, width: 1920, height: 1080, fps: 60, videoCodec: 'h264', hasAudio: false }

describe('focus zoom', () => {
  it('supports every configured zoom preset', () => {
    expect(focusZoomAmounts).toEqual([1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('clamps crop focus and ramps deterministically', () => {
    const effect = { id: 'z', start: 2, duration: 3, zoom: 10 as const, focusX: 0.95, focusY: 0.1 }
    const crop = focusCropAtTime(effect, 3.5)
    expect(crop.zoom).toBe(10)
    expect(crop.width).toBe(0.1)
    expect(crop.left + crop.width).toBeLessThanOrEqual(1.0001)
    expect(crop.top).toBeGreaterThanOrEqual(0)
    expect(focusCropAtTime(effect, 2).zoom).toBe(1)
    expect(focusCropAtTime(effect, 5).zoom).toBe(1)
    expect(focusCameraTransformAtTime([effect], 3.5)).toBe('scale(10) translate(-90%, -5%)')
    expect(focusCameraTransformAtTime([effect], 6)).toBeUndefined()
  })

  it('replaces overlapping effects in the active range', () => {
    const session = createSession(source)
    const first = addFocusZoom(session, 2, 5, 1.5, 0.5, 0.5)
    const second = addFocusZoom({ ...first, playhead: 3 }, 2, 5, 2, 0.2, 0.8)
    expect(second.focusZooms).toHaveLength(1)
    expect(second.focusZooms[0]?.zoom).toBe(2)
    expect(timelineDuration(second.segments)).toBe(10)
    const separate = addFocusZoom(second, 6, 8, 3, -1, 2)
    expect(separate.focusZooms).toHaveLength(2)
    expect(separate.focusZooms[1]).toMatchObject({ focusX: 0, focusY: 1 })
  })

  it('ripples and trims timed zoom ranges after removal', () => {
    const effects = [
      { id: 'before', start: 0, duration: 1, zoom: 3 as const, focusX: 0.5, focusY: 0.5 },
      { id: 'inside', start: 2, duration: 1, zoom: 1.5 as const, focusX: 0.5, focusY: 0.5 },
      { id: 'cross', start: 3, duration: 4, zoom: 2 as const, focusX: 0.5, focusY: 0.5 },
      { id: 'after', start: 8, duration: 1, zoom: 1.5 as const, focusX: 0.5, focusY: 0.5 }
    ]
    const result = timedRangesAfterRemoval(effects, 2, 5)
    expect(result.map(({ id, start, duration }) => ({ id, start, duration }))).toEqual([
      { id: 'before', start: 0, duration: 1 },
      { id: 'cross', start: 2, duration: 2 },
      { id: 'after', start: 5, duration: 1 }
    ])
  })

  it('bounds effect ranges and handles zero-duration input', () => {
    const session = createSession(source)
    const added = addFocusZoom(session, -2, 20, 5, 0.5, 0.5)
    expect(added.focusZooms[0]).toMatchObject({ start: 0, duration: 10 })
    expect(removeFocusZoomFromRange(added, 20, 21).focusZooms).toHaveLength(1)
    expect(removeFocusZoomFromRange(session, 0, 1).focusZooms).toEqual([])
    expect(focusCropAtTime({ id: 'zero', start: 1, duration: 0, zoom: 2, focusX: 0.5, focusY: 0.5 }, 1).zoom).toBe(2)
  })
})
