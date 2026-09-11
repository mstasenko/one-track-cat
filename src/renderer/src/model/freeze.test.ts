import { describe, expect, it } from 'vitest'
import type { MediaMetadata } from '@shared/types'
import { insertFreezeFrame, removeFreezeFrame } from './freeze'
import { createSession, isFreezeSegment, positionAtOutputTime, removeOutputRange, timelineDuration } from './timeline'

const source: MediaMetadata = { path: '/video.mp4', name: 'video.mp4', size: 1, modifiedAt: 1, duration: 10, width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true }

describe('freeze frame', () => {
  it('splits at the exact source moment and ripples timed content', () => {
    const session = createSession(source)
    session.playhead = 4
    session.marks = [6]
    session.overlays = [{ id: 'text', type: 'text', name: 'text', start: 5, duration: 1, zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1, text: 'x', fontFamily: 'sans', fontSize: 4, color: '#fff', outlineColor: '#000', outlineWidth: 0, shadow: false, align: 'center' }]
    const frozen = insertFreezeFrame(session, 4, 1)
    expect(timelineDuration(frozen.segments)).toBe(11)
    expect(frozen.segments).toHaveLength(3)
    const freeze = frozen.segments[1]
    if (!freeze) throw new Error('freeze segment missing')
    expect(isFreezeSegment(freeze)).toBe(true)
    expect(frozen.marks).toEqual([7])
    expect(frozen.overlays[0]?.start).toBe(6)
    expect(positionAtOutputTime(frozen.segments, 4.5)?.sourceTime).toBe(4)
    const restored = removeFreezeFrame(frozen, freeze.id)
    expect(timelineDuration(restored.segments)).toBe(10)
  })

  it('uses source mapping inside slowed video and ignores nested freezes', () => {
    const session = createSession(source)
    const original = session.segments[0]
    if (!original || original.kind === 'freeze') throw new Error('video segment missing')
    session.segments[0] = { ...original, playbackRate: 0.5 }
    const frozen = insertFreezeFrame(session, 4, 0.5)
    const freeze = frozen.segments.find((segment) => segment.kind === 'freeze')
    expect(freeze?.sourceTime).toBe(2)
    expect(freeze ? insertFreezeFrame(frozen, 4.25, 1) : null).toBe(frozen)
    expect(removeFreezeFrame(session, 'missing')).toBe(session)
  })

  it('handles boundary freezes and maps timed starts when removing one', () => {
    const session = createSession(source)
    session.marks = [0, 0.5, 2]
    session.overlays = [
      { id: 'inside', type: 'text', name: 'inside', start: 0.5, duration: 1, zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1, text: 'x', fontFamily: 'sans', fontSize: 4, color: '#fff', outlineColor: '#000', outlineWidth: 0, shadow: false, align: 'center' },
      { id: 'after', type: 'text', name: 'after', start: 2, duration: 1, zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1, text: 'x', fontFamily: 'sans', fontSize: 4, color: '#fff', outlineColor: '#000', outlineWidth: 0, shadow: false, align: 'center' }
    ]
    session.focusZooms = [{ id: 'zoom', start: 0.25, duration: 2, zoom: 1.5, focusX: 0.5, focusY: 0.5 }]
    const frozen = insertFreezeFrame(session, 0, 1)
    expect(frozen.segments[0]?.kind).toBe('freeze')
    const removed = removeFreezeFrame(frozen, frozen.segments[0]?.id ?? '')
    expect(removed.marks).toEqual([0, 0.5, 2])
    expect(removed.overlays.map((overlay) => overlay.start)).toEqual([0.5, 2])
    expect(removed.focusZooms[0]).toMatchObject({ start: 0.25, duration: 2 })

    const atEnd = insertFreezeFrame(session, 10, 2)
    expect(atEnd.segments.at(-1)?.kind).toBe('freeze')
    expect(insertFreezeFrame(createSession(source), 3, 0.5).focusZooms).toEqual([])
  })

  it('keeps the freeze frame before the source EOF', () => {
    const atEnd = insertFreezeFrame(createSession(source), source.duration, 1)
    const endFreeze = atEnd.segments.at(-1)
    expect(endFreeze && isFreezeSegment(endFreeze) ? endFreeze.sourceTime : null).toBeCloseTo(source.duration - 1 / source.fps)

    const trimmed = createSession(source)
    const original = trimmed.segments[0]
    if (!original || original.kind === 'freeze') throw new Error('video segment missing')
    trimmed.segments = [{ ...original, sourceEnd: 8 }]
    const trimmedFreeze = insertFreezeFrame(trimmed, 8, 1).segments.at(-1)
    expect(trimmedFreeze && isFreezeSegment(trimmedFreeze) ? trimmedFreeze.sourceTime : null).toBe(8)
  })

  it('shortens or removes freezes when a cut crosses them', () => {
    const frozen = insertFreezeFrame(createSession(source), 4, 1)
    const shortened = removeOutputRange(frozen.segments, [], 4.25, 4.75).segments
    expect(shortened.find(isFreezeSegment)?.duration).toBe(0.5)
    const crossed = removeOutputRange(frozen.segments, [], 3.5, 5.5).segments
    expect(crossed.some(isFreezeSegment)).toBe(false)
    expect(timelineDuration(crossed)).toBe(9)
    expect(positionAtOutputTime(crossed, 3.75)?.sourceTime).toBeCloseTo(4.75)
  })
})
