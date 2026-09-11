import { describe, expect, it, vi } from 'vitest'
import { replaceVideoRangeTransition, videoRangeStyleAtTime } from './video-range-transition'

vi.stubGlobal('crypto', { randomUUID: () => 'test' })

describe('video range transitions', () => {
  it('fits edge durations to half of a short range', () => {
    const effects = replaceVideoRangeTransition([], 2, 3, { effect: 'fade', duration: 5 }, { effect: 'hblur', duration: 5 })
    expect(effects[0]).toMatchObject({ start: 2, duration: 1, into: { duration: 0.5 }, out: { duration: 0.5 } })
  })

  it('uses the whole range for one edge and does not cap range transitions at five seconds', () => {
    const effects = replaceVideoRangeTransition([], 0, 12, { effect: 'fade', duration: 20 }, undefined)
    expect(effects[0]).toMatchObject({ duration: 12, into: { duration: 12 } })
  })

  it('previews fades and blur only near the selected edges', () => {
    const effects = [{
      id: 'effect', start: 2, duration: 4,
      into: { effect: 'fade' as const, duration: 1 },
      out: { effect: 'hblur' as const, duration: 1 }
    }]
    expect(videoRangeStyleAtTime(effects, 2).opacity).toBe(0)
    expect(videoRangeStyleAtTime(effects, 2.25).opacity).toBeCloseTo(0.15625)
    expect(videoRangeStyleAtTime(effects, 4)).toEqual({})
    expect(videoRangeStyleAtTime(effects, 6).filter).toBe('blur(18px)')
  })

  it('replaces only overlapping ranges', () => {
    const existing = [{ id: 'old', start: 0, duration: 1, into: { effect: 'fade' as const, duration: 0.5 } }]
    expect(replaceVideoRangeTransition(existing, 2, 4, { effect: 'hblur', duration: 1 }, undefined)).toHaveLength(2)
    expect(replaceVideoRangeTransition(existing, 0, 1, undefined, undefined)).toEqual([])
  })
})
