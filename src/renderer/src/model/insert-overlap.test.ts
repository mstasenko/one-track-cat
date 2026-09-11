import { describe, expect, it } from 'vitest'
import type { MediaMetadata, SourceSegment, TimelineSource, VideoSegment } from '@shared/types'
import { insertSourceAtOutputTime } from './segment-ranges'
import { transitionPreviewAtOutputTime } from './transitions'
import { createSession, defaultTextOverlay, timelineDuration } from './timeline'

const source: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

function video(segment: SourceSegment | undefined): VideoSegment {
  if (!segment || segment.kind === 'freeze') throw new Error('video segment missing')
  return segment
}

function insertedSource(metadata: MediaMetadata): TimelineSource {
  return { id: 'inserted', metadata, playbackPath: `media:${metadata.path}`, waveform: [] }
}

describe('inserted transition overlaps', () => {
  it('reserves a real handle when appending at physical EOF and advances through it', () => {
    const inserted = { ...source, path: '/inserted.mp4', name: 'inserted.mp4', duration: 2 }
    const result = insertSourceAtOutputTime(
      createSession(source),
      insertedSource(inserted),
      source.duration,
      { into: { effect: 'fade', duration: 0.75 } }
    )
    const previous = video(result.segments[0])
    const current = video(result.segments[1])

    expect(previous.sourceEnd).toBe(9.25)
    expect(current.sourceEnd).toBe(2)
    expect(current.transition).toEqual({ effect: 'fade', duration: 0.75 })
    expect(timelineDuration(result.segments)).toBe(11.25)
    expect(result.playhead).toBe(timelineDuration(result.segments))
    expect(result.sources[0]?.metadata.duration).toBe(source.duration)

    const early = transitionPreviewAtOutputTime(result, 9.35)
    const late = transitionPreviewAtOutputTime(result, 9.85)
    if (!early || !late) throw new Error('transition preview missing')
    expect(early.previousPath).toBe(source.path)
    expect(early.previousSourceTime).toBeCloseTo(9.35)
    expect(late.previousSourceTime).toBeCloseTo(9.85)
    expect(late.previousSourceTime).toBeGreaterThan(early.previousSourceTime)
    expect(late.previousSourceTime).toBeLessThan(source.duration)
  })

  it('subtracts both edge overlaps and ripples downstream timing', () => {
    const session = createSession(source)
    const sourceId = session.sources[0]?.id
    if (!sourceId) throw new Error('source missing')
    session.marks = [2, 8]
    session.overlays = [{ ...defaultTextOverlay(8, 1), id: 'after', duration: 1 }]
    const inserted = { ...source, path: '/inserted.mp4', name: 'inserted.mp4', duration: 4 }

    const result = insertSourceAtOutputTime(session, insertedSource(inserted), 5, {
      into: { effect: 'fade', duration: 0.5 },
      back: { effect: 'hblur', duration: 0.75 }
    })

    expect(result.segments.map((segment) => {
      const item = video(segment)
      return { sourceId: item.sourceId, sourceStart: item.sourceStart, sourceEnd: item.sourceEnd }
    })).toEqual([
      { sourceId, sourceStart: 0, sourceEnd: 4.5 },
      { sourceId: 'inserted', sourceStart: 0, sourceEnd: 3.25 },
      { sourceId, sourceStart: 5, sourceEnd: 10 }
    ])
    expect(video(result.segments[1]).transition).toEqual({ effect: 'fade', duration: 0.5 })
    expect(video(result.segments[2]).transition).toEqual({ effect: 'hblur', duration: 0.75 })
    expect(timelineDuration(result.segments)).toBe(12.75)
    expect(result.playhead).toBe(7.75)
    expect(result.marks).toEqual([2, 10.75])
    expect(result.overlays).toMatchObject([{ id: 'after', start: 10.75, duration: 1 }])
  })
})
