import { describe, expect, it } from 'vitest'
import type { MediaMetadata, Overlay, SourceSegment, VideoSegment } from '@shared/types'
import {
  clamp,
  createSession,
  marksAfterRemoval,
  deletionRange,
  defaultTextOverlay,
  formatTime,
  isSourceTimedOverlay,
  overlaySourceTime,
  outputTimeForSource,
  overlayAtTime,
  positionAtOutputTime,
  removeOutputRange,
  segmentPlaybackRate,
  segmentSourceDuration,
  segmentOutputDuration,
  timelineDuration
} from './timeline'
import { insertSourceAtOutputTime } from './segment-ranges'
import { applySpeedToOutputRange } from './speed'

const source: MediaMetadata = {
  path: '/video.mp4', name: 'video.mp4', size: 100, modifiedAt: 1, duration: 20,
  width: 1920, height: 1080, fps: 30, videoCodec: 'h264',
  hasAudio: true
}

function video(segment: SourceSegment | undefined): VideoSegment {
  if (!segment || segment.kind === 'freeze') throw new Error('video segment missing')
  return segment
}

describe('timeline model', () => {
  it('creates a path-backed initial session', () => {
    const session = createSession(source)
    expect(session.sources[0]?.metadata).toBe(source)
    expect(session.segments).toHaveLength(1)
    expect(timelineDuration(session.segments)).toBe(20)
  })

  it('creates a centered 9:16 Short project', () => {
    expect(createSession(source, true).canvas).toEqual({ width: 1080, height: 1920, fps: 30, fit: 'cover' })
  })

  it('ripple-inserts a source by splitting the active segment and overlays', () => {
    const session = createSession(source)
    const originalSourceId = session.sources[0]?.id
    session.marks = [2, 8]
    session.focusZooms = [
      { id: 'spans', start: 4, duration: 3, zoom: 1.5, focusX: 0.5, focusY: 0.5 },
      { id: 'after', start: 9, duration: 1, zoom: 2, focusX: 0.5, focusY: 0.5 }
    ]
    session.overlays = [
      { ...defaultTextOverlay(3, 1), id: 'text', duration: 4 },
      {
        id: 'audio', type: 'audio', name: 'Audio', path: '/audio.wav', start: 3,
        duration: 4, zIndex: 2, volume: 1, sourceIn: 2
      }
    ]
    const insertedMetadata = { ...source, path: '/inserted.mp4', name: 'inserted.mp4', duration: 4 }
    const result = insertSourceAtOutputTime(session, {
      id: 'inserted', metadata: insertedMetadata, playbackPath: 'media:/inserted.mp4', waveform: []
    }, 5, {
      into: { effect: 'wipeleft', duration: 0.5 },
      back: { effect: 'circleopen', duration: 0.75 }
    })

    expect(result.segments.map((segment) => { const item = video(segment); return { sourceId: item.sourceId, sourceStart: item.sourceStart, sourceEnd: item.sourceEnd } })).toEqual([
      { sourceId: originalSourceId, sourceStart: 0, sourceEnd: 4.5 },
      { sourceId: 'inserted', sourceStart: 0, sourceEnd: 3.25 },
      { sourceId: originalSourceId, sourceStart: 5, sourceEnd: 20 }
    ])
    expect(result.marks).toEqual([2, 10.75])
    expect(result.overlays.map(({ type, start, duration }) => ({ type, start, duration }))).toEqual([
      { type: 'text', start: 3, duration: 2 },
      { type: 'text', start: 7.75, duration: 2 },
      { type: 'audio', start: 3, duration: 2 },
      { type: 'audio', start: 7.75, duration: 2 }
    ])
    expect(result.overlays[3]).toMatchObject({ sourceIn: 4 })
    expect(result.focusZooms.map(({ id, start, duration }) => ({ id, start, duration }))).toEqual([
      { id: 'spans', start: 4, duration: 5.75 }, { id: 'after', start: 11.75, duration: 1 }
    ])
    expect(video(result.segments[1]).transition).toEqual({ effect: 'wipeleft', duration: 0.5 })
    expect(video(result.segments[2]).transition).toEqual({ effect: 'circleopen', duration: 0.75 })
    expect(result.playhead).toBe(7.75)
  })

  it('fits transitions at either timeline boundary without empty segments', () => {
    const inserted = {
      id: 'inserted', metadata: { ...source, duration: 2 }, playbackPath: '/inserted', waveform: []
    }
    const transitions = {
      into: { effect: 'fade' as const, duration: 4 },
      back: { effect: 'hblur' as const, duration: 1 }
    }
    const atStart = insertSourceAtOutputTime(createSession(source), inserted, -1, transitions)
    expect(atStart.segments.map((segment) => segment.sourceId)).toEqual(['inserted', atStart.sources[0]?.id])
    expect(video(atStart.segments[0]).transition).toBeUndefined()
    expect(video(atStart.segments[1]).transition).toEqual({ effect: 'hblur', duration: 1 })
    const atEnd = insertSourceAtOutputTime(createSession(source), inserted, 999, transitions)
    expect(atEnd.segments.map((segment) => segment.sourceId)).toEqual([atEnd.sources[0]?.id, 'inserted'])
    expect(video(atEnd.segments[0]).sourceEnd).toBe(19)
    expect(video(atEnd.segments[1]).transition).toEqual({ effect: 'fade', duration: 1 })
    expect(atEnd.playhead).toBe(21)

    const tiny = {
      ...inserted,
      id: 'tiny',
      metadata: { ...inserted.metadata, duration: 0.02 }
    }
    const withTinyClip = insertSourceAtOutputTime(createSession(source), tiny, 10, transitions)
    expect(video(withTinyClip.segments[1]).transition).toBeUndefined()
  })

  it('maps output positions across retained source segments', () => {
    const segments: SourceSegment[] = [
      { id: 'a', sourceId: 'source', sourceStart: 2, sourceEnd: 5 },
      { id: 'b', sourceId: 'source', sourceStart: 10, sourceEnd: 14 }
    ]
    expect(timelineDuration(segments)).toBe(7)
    expect(positionAtOutputTime(segments, 1)?.sourceTime).toBe(3)
    expect(positionAtOutputTime(segments, 4)).toMatchObject({ segmentIndex: 1, sourceTime: 11 })
    expect(positionAtOutputTime(segments, 99)?.sourceTime).toBe(14)
    expect(positionAtOutputTime([], 0)).toBeNull()
    expect(outputTimeForSource(segments, 1, 12)).toBe(5)
    expect(outputTimeForSource(segments, 9, 2)).toBe(7)
  })

  it('uses playback rate for source and output durations and mappings', () => {
    const segments: SourceSegment[] = [
      { id: 'fast', sourceId: 'source', sourceStart: 0, sourceEnd: 8, playbackRate: 2 },
      { id: 'slow', sourceId: 'source', sourceStart: 8, sourceEnd: 12, playbackRate: 0.5 }
    ]
    const fast = segments[0]
    const slow = segments[1]
    if (!fast || !slow) throw new Error('test segments missing')
    expect(segmentSourceDuration(fast)).toBe(8)
    expect(segmentPlaybackRate(fast)).toBe(2)
    expect(segmentOutputDuration(fast)).toBe(4)
    expect(segmentOutputDuration(slow)).toBe(8)
    expect(timelineDuration(segments)).toBe(12)
    expect(positionAtOutputTime(segments, 2)).toMatchObject({ segmentIndex: 0, sourceTime: 4 })
    expect(positionAtOutputTime(segments, 4)).toMatchObject({ segmentIndex: 1, sourceTime: 8 })
    expect(positionAtOutputTime(segments, 8)).toMatchObject({ segmentIndex: 1, sourceTime: 10 })
    expect(outputTimeForSource(segments, 1, 10)).toBe(8)
  })

  it('applies speed to a selected output range without mutating segments', () => {
    const session = createSession(source)
    session.segments = [{
      id: 'source', sourceId: 'source', sourceStart: 0, sourceEnd: 10,
      transition: { effect: 'fade', duration: 0.5 }
    }]
    const result = applySpeedToOutputRange(session, 2, 6, 2)
    expect(session.segments[0]).not.toHaveProperty('playbackRate')
    expect(result.segments.map((segment) => { const item = video(segment); return {
      sourceStart: item.sourceStart, sourceEnd: item.sourceEnd, playbackRate: item.playbackRate
    } })).toEqual([
      { sourceStart: 0, sourceEnd: 2, playbackRate: undefined },
      { sourceStart: 2, sourceEnd: 6, playbackRate: 2 },
      { sourceStart: 6, sourceEnd: 10, playbackRate: undefined }
    ])
    expect(video(result.segments[0]).transition).toEqual({ effect: 'fade', duration: 0.5 })
    expect(video(result.segments[1]).transition).toBeUndefined()
    expect(video(result.segments[2]).transition).toBeUndefined()
    expect(timelineDuration(result.segments)).toBe(8)
    expect(applySpeedToOutputRange(session, 0, 10, 1)).toEqual(session)
  })

  it('ripples speed changes through a session while keeping attached timing', () => {
    const session = createSession(source)
    session.segments[0] = { id: 'source', sourceId: session.segments[0]?.sourceId ?? 'source', sourceStart: 0, sourceEnd: 10 }
    session.playhead = 3
    session.marks = [2, 8]
    session.focusZooms = [{ id: 'zoom', start: 3, duration: 2, zoom: 1.5, focusX: 0.5, focusY: 0.5 }]
    session.overlays = [{ id: 'text', type: 'text', name: 't', start: 9, duration: 1, zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1, text: 'x', fontFamily: 'sans', fontSize: 4, color: '#fff', outlineColor: '#000', outlineWidth: 0, shadow: false, align: 'center' }]
    const changed = applySpeedToOutputRange(session, 2, 6, 0.5)
    expect(timelineDuration(changed.segments)).toBe(14)
    expect(changed.marks).toEqual([2, 12])
    expect(changed.overlays[0]?.start).toBe(13)
    expect(changed.playhead).toBe(4)
    expect(changed.focusZooms[0]).toMatchObject({ start: 4, duration: 4 })
    expect(applySpeedToOutputRange(session, 4, 4, 2)).toBe(session)
  })

  it('resets whole slowed sections while leaving freezes unchanged', () => {
    const session = createSession(source)
    const original = session.segments[0]
    if (!original || original.kind === 'freeze') throw new Error('video segment missing')
    session.segments = [
      { ...original, playbackRate: 0.5 },
      { kind: 'freeze', id: 'freeze', sourceId: original.sourceId, sourceTime: 20, duration: 1 }
    ]
    const reset = applySpeedToOutputRange(session, 0, 41, 1)
    expect(video(reset.segments[0]).playbackRate).toBeUndefined()
    expect(reset.segments[1]).toEqual(session.segments[1])
    expect(reset.focusZooms).toEqual([])
  })

  it('cuts and inserts at speed-adjusted output positions', () => {
    const session = createSession(source)
    const original = session.segments[0]
    if (!original || original.kind === 'freeze') throw new Error('test segment missing')
    session.segments[0] = { ...original, playbackRate: 2 }
    const insertedMetadata = { ...source, path: '/inserted-speed.mp4', name: 'inserted-speed.mp4', duration: 4 }
    const inserted = insertSourceAtOutputTime(session, {
      id: 'inserted', metadata: insertedMetadata, playbackPath: '/inserted-speed.mp4', waveform: []
    }, 1)
    expect(inserted.segments.map((segment) => { const item = video(segment); return { sourceId: item.sourceId, sourceStart: item.sourceStart, sourceEnd: item.sourceEnd } })).toEqual([
      { sourceId: original.sourceId, sourceStart: 0, sourceEnd: 2 },
      { sourceId: 'inserted', sourceStart: 0, sourceEnd: 4 },
      { sourceId: original.sourceId, sourceStart: 2, sourceEnd: 20 }
    ])
    expect(timelineDuration(inserted.segments)).toBe(14)

    const removed = removeOutputRange(session.segments, [], 1, 2)
    expect(removed.segments.map((segment) => [video(segment).sourceStart, video(segment).sourceEnd])).toEqual([[0, 2], [4, 20]])
    expect(timelineDuration(removed.segments)).toBe(9)
  })

  it('derives the partition containing the playhead from any number of marks', () => {
    const session = createSession(source)
    session.marks = [4]
    session.playhead = 4
    expect(deletionRange(session)).toEqual([0, 4])
    session.playhead = 2
    expect(deletionRange(session)).toEqual([0, 4])
    session.playhead = 8
    expect(deletionRange(session)).toEqual([4, 20])
    session.marks = [16, 4, 12]
    session.playhead = 8
    expect(deletionRange(session)).toEqual([4, 12])
    session.playhead = 2
    expect(deletionRange(session)).toEqual([0, 4])
    session.playhead = 14
    expect(deletionRange(session)).toEqual([12, 16])
    session.playhead = 18
    expect(deletionRange(session)).toEqual([16, 20])
    expect(marksAfterRemoval([4, 12, 16], 12, 16, 16)).toEqual([4, 12])
  })

  it('removes a range spanning segments and collapses output time', () => {
    const segments: SourceSegment[] = [
      { id: 'a', sourceId: 'source', sourceStart: 0, sourceEnd: 5, transition: { effect: 'fade', duration: 1 } },
      { id: 'b', sourceId: 'source', sourceStart: 10, sourceEnd: 15, transition: { effect: 'wipeleft', duration: 1 } }
    ]
    const result = removeOutputRange(segments, [], 3, 7)
    expect(result.segments.map((segment) => [video(segment).sourceStart, video(segment).sourceEnd])).toEqual([[0, 3], [12, 15]])
    expect(result.segments.every((segment) => video(segment).transition === undefined)).toBe(true)
    expect(timelineDuration(result.segments)).toBe(6)
  })

  it('keeps transitions between untouched clips after a ripple removal', () => {
    const segments: SourceSegment[] = [
      { id: 'a', sourceId: 'source', sourceStart: 0, sourceEnd: 2 },
      { id: 'b', sourceId: 'source', sourceStart: 2, sourceEnd: 4, transition: { effect: 'fade', duration: 0.5 } },
      { id: 'c', sourceId: 'source', sourceStart: 4, sourceEnd: 6, transition: { effect: 'hblur', duration: 0.5 } }
    ]
    const result = removeOutputRange(segments, [], 0, 1)
    expect(video(result.segments[0]).transition).toBeUndefined()
    expect(video(result.segments[1]).transition).toEqual({ effect: 'fade', duration: 0.5 })
    expect(video(result.segments[2]).transition).toEqual({ effect: 'hblur', duration: 0.5 })
  })

  it('trims, removes, and shifts overlays with deleted video', () => {
    const base = (id: string, start: number, duration: number): Overlay => ({
      ...defaultTextOverlay(start, 1), id, duration
    })
    const overlays = [
      base('before', 0, 1),
      base('left', 1, 3),
      base('inside', 3, 1),
      base('span', 1, 7),
      base('right', 5, 3),
      base('after', 8, 1)
    ]
    const result = removeOutputRange([{ id: 's', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }], overlays, 2, 6)
    expect(result.overlays.map(({ id, start, duration }) => ({ id, start, duration }))).toEqual([
      { id: 'before', start: 0, duration: 1 },
      { id: 'left', start: 1, duration: 1 },
      { id: 'span', start: 1, duration: 3 },
      { id: 'right', start: 2, duration: 2 },
      { id: 'after', start: 4, duration: 1 }
    ])
  })

  it('splits timed media and preserves its source position across a ripple cut', () => {
    const audio: Overlay = {
      id: 'audio', type: 'audio', name: 'Music', path: '/music.wav',
      start: 1, duration: 7, zIndex: 1, volume: 1, sourceIn: 10
    }
    const result = removeOutputRange(
      [{ id: 'source', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
      [audio],
      2,
      6
    )
    expect(result.overlays).toHaveLength(2)
    expect(result.overlays[0]).toMatchObject({ id: 'audio', start: 1, duration: 1, sourceIn: 10 })
    expect(result.overlays[1]).toMatchObject({ start: 2, duration: 2, sourceIn: 15 })
    expect(result.overlays[1]?.id).not.toBe('audio')
  })

  it('trims either edge of timed source media without restarting it', () => {
    const audio = (id: string, start: number, duration: number): Overlay => ({
      id, type: 'audio', name: id, path: `/${id}.wav`, start, duration,
      zIndex: 1, volume: 1, sourceIn: 4
    })
    const result = removeOutputRange(
      [{ id: 'source', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
      [audio('left', 1, 3), audio('right', 3, 5), audio('removed', 3, 1)],
      2,
      6
    )
    expect(result.overlays).toHaveLength(2)
    expect(result.overlays[0]).toMatchObject({ id: 'left', start: 1, duration: 1, sourceIn: 4 })
    expect(result.overlays[1]).toMatchObject({ id: 'right', start: 2, duration: 2, sourceIn: 7 })
  })

  it('uses the same source-aware ripple behavior for video and GIF clips', () => {
    const visual = {
      name: 'Clip', path: '/clip', start: 1, duration: 7, zIndex: 1,
      x: 0, y: 0, width: 1, height: 1, opacity: 1,
      sourceIn: 2, sourceDuration: 20
    }
    const overlays: Overlay[] = [
      { ...visual, id: 'video', type: 'video', loop: true, audioEnabled: false, hasAudio: false, volume: 1 },
      { ...visual, id: 'gif', type: 'gif' }
    ]
    const result = removeOutputRange(
      [{ id: 'source', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
      overlays,
      2,
      6
    )
    expect(result.overlays.filter((overlay) => overlay.type === 'video')).toHaveLength(2)
    expect(result.overlays.filter((overlay) => overlay.type === 'gif')).toHaveLength(2)
    expect(result.overlays.filter(isSourceTimedOverlay).filter((overlay) => overlay.sourceIn === 7)).toHaveLength(2)
  })

  it('handles reversed, empty, and bounded removals', () => {
    const segments = [{ id: 'a', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }]
    expect(removeOutputRange(segments, [], 5, 5).segments).toBe(segments)
    expect(timelineDuration(removeOutputRange(segments, [], 9, 2).segments)).toBe(3)
    expect(removeOutputRange(segments, [], -10, 20).segments).toEqual([])
  })

  it('provides overlay, formatting, and clamp helpers', () => {
    const overlay = defaultTextOverlay(2, 3)
    expect(overlay.fontFamily).toBe('Anton')
    expect(overlayAtTime(overlay, 2)).toBe(true)
    expect(overlayAtTime(overlay, 5)).toBe(false)
    expect(clamp(-1, 0, 2)).toBe(0)
    expect(clamp(5, 0, 2)).toBe(2)
    expect(formatTime(65.5)).toBe('01:05.15')
    expect(formatTime(3661)).toBe('1:01:01.00')
    expect(formatTime(Number.NaN)).toBe('00:00.00')
    expect(formatTime(1.5, 24)).toBe('00:01.12')
    expect(formatTime(1.5, 0)).toBe('00:01.15')
    const audio: Overlay = {
      id: 'audio', type: 'audio', name: 'audio', path: '/audio.wav', start: 2,
      duration: 3, zIndex: 1, volume: 1, sourceIn: 4
    }
    const gif: Overlay = {
      id: 'gif', type: 'gif', name: 'gif', path: '/gif.gif', start: 2,
      duration: 3, zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1,
      sourceIn: 9, sourceDuration: 10
    }
    expect(isSourceTimedOverlay(audio)).toBe(true)
    expect(isSourceTimedOverlay(overlay)).toBe(false)
    expect(overlaySourceTime(audio, 3)).toBe(5)
    expect(overlaySourceTime(gif, 4)).toBe(1)
  })
})
