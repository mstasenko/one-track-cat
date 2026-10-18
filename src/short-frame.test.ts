import { describe, expect, it } from 'vitest'
import type { ShortFrameMove, ShortFramePoint } from './types'
import {
  legacyShortFrameMovesToPoints,
  normalizeShortFramePoints,
  shortFramePositionAtTime,
  shortFramePositionExpression,
  shortFrameRect
} from './short-frame'

const points: ShortFramePoint[] = [
  { id: 'initial', time: 0, position: 0.5 },
  { id: 'left', time: 2, position: 0 },
  { id: 'right', time: 6, position: 1 }
]

describe('Short framing', () => {
  it('uses an implicit initial anchor, holds endpoints, and eases between points', () => {
    expect(shortFramePositionAtTime([], 0, 0.45)).toBe(0.45)
    expect(shortFramePositionExpression([], 't', 0.45)).toBe('0.45')
    expect(shortFramePositionAtTime(points, 0)).toBe(0.5)
    expect(shortFramePositionAtTime(points, 1)).toBeCloseTo(0.25)
    expect(shortFramePositionAtTime(points, 2)).toBe(0)
    expect(shortFramePositionAtTime(points, 4)).toBeCloseTo(0.5)
    expect(shortFramePositionAtTime(points, 7)).toBe(1)
    expect(shortFramePositionAtTime([{ id: 'start', time: 0, position: 0.2 }], 0)).toBe(0.2)
  })

  it('builds an FFmpeg expression with the same smoothstep and held destinations', () => {
    const expression = shortFramePositionExpression(points, 't')
    expect(expression).toContain('if(lt(t,2),0.5')
    expect(expression).toContain('(3-2*')
    expect(expression).toContain('if(lt(t,6)')
    expect(expression).toContain(',1))')
  })

  it('maps a landscape source to the visible portrait crop', () => {
    const rectangle = shortFrameRect(
      { width: 1080, height: 1920, fps: 60, fit: 'cover' },
      { width: 1920, height: 1080 },
      0.5
    )
    expect(rectangle.left).toBeCloseTo(0.341796875)
    expect(rectangle.width).toBeCloseTo(0.31640625)
    expect(rectangle.top).toBe(0)
    expect(rectangle.height).toBe(1)
  })

  it('migrates the legacy global and range moves without losing their motion', () => {
    const moves: ShortFrameMove[] = [
      { id: 'legacy-left', start: 2, duration: 2, direction: 'left' },
      { id: 'legacy-right', start: 6, duration: 2, direction: 'right' }
    ]
    const migrated = legacyShortFrameMovesToPoints(moves, 0.4, true)
    expect(migrated).toEqual([
      { id: 'short-frame-initial', time: 0, position: 0.4 },
      { id: 'short-frame-legacy-0-start', time: 2, position: 0.4 },
      { id: 'short-frame-legacy-0-end', time: 4, position: 0 },
      { id: 'short-frame-legacy-1-start', time: 6, position: 0 },
      { id: 'short-frame-legacy-1-end', time: 8, position: 1 }
    ])
    expect(shortFramePositionAtTime(migrated, 3)).toBeCloseTo(0.2)
    expect(shortFramePositionAtTime(migrated, 5)).toBe(0)
    expect(shortFramePositionAtTime(migrated, 9)).toBe(1)
  })

  it('deduplicates same-time remaps deterministically and rejects invalid numeric points', () => {
    expect(normalizeShortFramePoints([
      { id: 'first', time: 2, position: 0.1 },
      { id: 'last', time: 2.00001, position: 0.9 }
    ])).toEqual([{ id: 'last', time: 2.00001, position: 0.9 }])
    expect(() => normalizeShortFramePoints([{ id: 'bad', time: Number.NaN, position: 0.5 }])).toThrow('invalid')
  })
})
