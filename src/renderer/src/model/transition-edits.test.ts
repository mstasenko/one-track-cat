import { describe, expect, it } from 'vitest'
import type { MediaMetadata, SourceSegment } from '@shared/types'
import { parseSavedSession } from '../../../main/validation'
import { insertFreezeFrame } from './freeze'
import { createSession, removeOutputRange, timelineDuration } from './timeline'

const source: MediaMetadata = {
  path: '/video.mp4', name: 'video.mp4', size: 1, modifiedAt: 1, duration: 10,
  width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true
}

function saved(segments: SourceSegment[], sourceId = 'source'): Record<string, unknown> {
  return {
    canvas: { width: 320, height: 180, fps: 30, fit: 'contain' },
    sources: [{ id: sourceId, metadata: source }],
    segments,
    overlays: [],
    selectedOverlayId: null,
    playhead: 0,
    marks: [],
    focusZooms: []
  }
}

function transitionSegments(sourceId = 'source'): SourceSegment[] {
  return [
    { id: 'first', sourceId, sourceStart: 0, sourceEnd: 1 },
    { id: 'transition', sourceId, sourceStart: 1, sourceEnd: 3, transition: { effect: 'fade', duration: 1 } },
    { id: 'last', sourceId, sourceStart: 3, sourceEnd: 4 }
  ]
}

describe('transition-preserving edits', () => {
  it('fits a transition when freezing before its incoming clip ends', () => {
    const edited = createSession(source)
    edited.segments = transitionSegments(edited.sources[0]?.id ?? 'source')

    const changed = insertFreezeFrame(edited, 1.5, 1)
    const shortened = changed.segments.find((segment) => segment.id !== 'first' && segment.kind !== 'freeze')

    expect(shortened).toMatchObject({ sourceStart: 1, sourceEnd: 1.5, transition: { effect: 'fade', duration: 0.5 } })
    expect(() => parseSavedSession(saved(changed.segments, edited.sources[0]?.id ?? 'source'))).not.toThrow()
  })

  it('fits a transition when removing through its clip', () => {
    const changed = removeOutputRange(transitionSegments(), [], 1.5, 2.5)
    const shortened = changed.segments.find((segment) => segment.kind !== 'freeze' && 'sourceStart' in segment && segment.sourceStart === 1)

    expect(shortened).toMatchObject({ sourceStart: 1, sourceEnd: 1.5, transition: { effect: 'fade', duration: 0.5 } })
    expect(timelineDuration(changed.segments)).toBe(3)
    expect(() => parseSavedSession(saved(changed.segments))).not.toThrow()
  })
})
