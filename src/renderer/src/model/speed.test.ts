import { describe, expect, it } from 'vitest'
import type { EditSession, MediaMetadata, Overlay, SourceSegment, VideoSegment } from '@shared/types'
import { parseSavedSession } from '../../../main/validation'
import { positionAtOutputTime, timelineDuration } from './timeline'
import { applySpeedToOutputRange } from './speed'
import { savedSession } from './store-session'

const source: MediaMetadata = {
  path: '/video.mp4', name: 'video.mp4', size: 100, modifiedAt: 1, duration: 20,
  width: 1920, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: true
}

function session(segments: SourceSegment[]): EditSession {
  return {
    canvas: { width: 1920, height: 1080, fps: 30, fit: 'contain' },
    sources: [{ id: 'source', metadata: source, playbackPath: source.path, waveform: [] }],
    segments,
    overlays: [],
    selectedOverlayId: null,
    playhead: 0,
    marks: [],
    focusZooms: []
  }
}

function textOverlay(id: string, start: number): Overlay {
  return {
    id, type: 'text', name: id, start, duration: 0.25, zIndex: 1,
    x: 0, y: 0, width: 1, height: 1, opacity: 1, text: id,
    fontFamily: 'sans', fontSize: 4, color: '#fff', outlineColor: '#000',
    outlineWidth: 0, shadow: false, align: 'center'
  }
}

function video(segment: SourceSegment | undefined): VideoSegment {
  if (!segment || segment.kind === 'freeze') throw new Error('video segment missing')
  return segment
}

describe('speed edits', () => {
  it('keeps the playhead in the same repeated source occurrence', () => {
    const edited = session([
      { id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 4 },
      { id: 'second', sourceId: 'source', sourceStart: 0, sourceEnd: 4 }
    ])
    edited.playhead = 5

    const changed = applySpeedToOutputRange(edited, 0, 8, 2)

    expect(changed.playhead).toBe(2.5)
    expect(positionAtOutputTime(changed.segments, changed.playhead)?.segment.id).toBe('second')
  })

  it('keeps freeze timing unchanged inside a selected range', () => {
    const edited = session([
      { id: 'before', sourceId: 'source', sourceStart: 0, sourceEnd: 4 },
      { kind: 'freeze', id: 'freeze', sourceId: 'source', sourceTime: 4, duration: 2 },
      { id: 'after', sourceId: 'source', sourceStart: 4, sourceEnd: 8 }
    ])
    edited.playhead = 5

    const changed = applySpeedToOutputRange(edited, 2, 6, 2)
    const freeze = changed.segments.find((segment) => segment.id === 'freeze')

    expect(freeze).toEqual({ kind: 'freeze', id: 'freeze', sourceId: 'source', sourceTime: 4, duration: 2 })
    expect(changed.playhead).toBe(4)
    expect(positionAtOutputTime(changed.segments, changed.playhead)?.segment.id).toBe('freeze')
  })

  it('maps attached timing at each mixed-rate segment boundary', () => {
    const edited = session([
      { id: 'fast', sourceId: 'source', sourceStart: 0, sourceEnd: 4, playbackRate: 2 },
      { id: 'slow', sourceId: 'source', sourceStart: 4, sourceEnd: 8, playbackRate: 0.5 },
      { id: 'normal', sourceId: 'source', sourceStart: 8, sourceEnd: 12 }
    ])
    edited.overlays = [1.5, 2.5, 6, 7.5].map((start, index) => textOverlay(`overlay-${index}`, start))
    edited.marks = [1.5, 2.5, 6, 7.5]
    edited.focusZooms = [
      { id: 'first', start: 1.25, duration: 0.5, zoom: 1.5, focusX: 0.5, focusY: 0.5 },
      { id: 'second', start: 2.25, duration: 1, zoom: 2, focusX: 0.5, focusY: 0.5 },
      { id: 'third', start: 6, duration: 0.5, zoom: 3, focusX: 0.5, focusY: 0.5 }
    ]

    const changed = applySpeedToOutputRange(edited, 1, 7, 1)

    expect(changed.overlays.map(({ start }) => start)).toEqual([2, 3.25, 5, 6])
    expect(changed.marks).toEqual([2, 3.25, 5, 6])
    expect(changed.focusZooms.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 1.5, duration: 1 },
      { start: 3.125, duration: 0.5 },
      { start: 5, duration: 0.25 }
    ])
    expect(timelineDuration(changed.segments)).toBe(12.5)
  })

  it('fits transitions when a sped segment becomes shorter', () => {
    const edited = session([
      { id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 1 },
      { id: 'second', sourceId: 'source', sourceStart: 1, sourceEnd: 2, transition: { effect: 'fade', duration: 0.75 } }
    ])

    const changed = applySpeedToOutputRange(edited, 1, 2, 4)

    expect(video(changed.segments[1]).transition).toEqual({ effect: 'fade', duration: 0.25 })
    expect(() => parseSavedSession(savedSession(changed))).not.toThrow()
  })

  it('removes transitions from sped segments shorter than the fitting threshold', () => {
    const edited = session([
      { id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 1 },
      { id: 'tiny', sourceId: 'source', sourceStart: 1, sourceEnd: 1.1, transition: { effect: 'fade', duration: 0.05 } }
    ])

    const changed = applySpeedToOutputRange(edited, 1, 1.1, 4)

    expect(video(changed.segments[1]).transition).toBeUndefined()
    expect(() => parseSavedSession(savedSession(changed))).not.toThrow()
  })
})
