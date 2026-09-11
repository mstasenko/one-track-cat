import { describe, expect, it } from 'vitest'
import type { MediaMetadata, SourceSegment, VideoSegment } from '@shared/types'
import { createSession, isFreezeSegment, timelineDuration } from './timeline'
import { insertReplay, removeReplayAtPlayhead, replayEligibility, replayRanges } from './replay'

const source: MediaMetadata = {
  path: '/game.mp4', name: 'game.mp4', size: 1, modifiedAt: 1, duration: 20,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264',
  hasAudio: true
}

function video(segment: SourceSegment | undefined): VideoSegment {
  if (!segment || isFreezeSegment(segment)) throw new Error('video segment missing')
  return segment
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture value missing')
  return value
}

function selected(start: number, end: number) {
  const session = createSession(source)
  session.marks = [start, end]
  session.playhead = (start + end) / 2
  return session
}

describe('gameplay replay', () => {
  it('requires a marked partition with transition-safe boundaries', () => {
    expect(replayEligibility(createSession(source)).reason).toContain('marks')
    expect(replayEligibility(selected(1, 1.02)).reason).toContain('two frames')

    const transition = selected(2.2, 4)
    transition.segments = [
      { id: 'a', sourceId: required(transition.sources[0]).id, sourceStart: 0, sourceEnd: 2 },
      { id: 'b', sourceId: required(transition.sources[0]).id, sourceStart: 2, sourceEnd: 20, transition: { effect: 'dissolve', duration: 0.5 } }
    ]
    expect(replayEligibility(transition)).toMatchObject({ range: null, reason: null })
  })

  it('accepts a twenty-second selection and inserts its forty-second replay', () => {
    const session = selected(0, 20)
    expect(replayEligibility(session)).toMatchObject({ range: [0, 20], reason: null })

    const replayed = insertReplay(session, 0, 20)
    expect(required(replayRanges(replayed.segments)[0]).duration).toBe(40)
  })

  it('accepts a short accelerated selection whose replay exceeds thirty seconds', () => {
    const session = selected(0, 10)
    video(session.segments[0]).playbackRate = 2
    expect(replayEligibility(session)).toMatchObject({ range: [0, 10], reason: null })

    const replayed = insertReplay(session, 0, 10)
    expect(required(replayRanges(replayed.segments)[0]).duration).toBe(40)
  })

  it('copies a middle source range at absolute half speed without changing sources or the original', () => {
    const session = selected(2, 4)
    video(session.segments[0]).playbackRate = 2
    const originalSources = session.sources
    const replayed = insertReplay(session, 2, 4)
    const range = replayRanges(replayed.segments)[0]
    expect(replayed.sources).toBe(originalSources)
    expect(range).toMatchObject({ start: 4, duration: 8 })
    const copies = replayed.segments.filter((segment) => segment.replayGroupId === range?.groupId)
    expect(copies).toHaveLength(1)
    expect(video(copies[0])).toMatchObject({ sourceStart: 4, sourceEnd: 8, playbackRate: 0.5 })
    expect(video(replayed.segments[0])).toMatchObject({ sourceStart: 0, sourceEnd: 8, playbackRate: 2 })
    expect(replayed.sources).toHaveLength(1)
  })

  it('copies several segments and removes internal transitions from replay footage', () => {
    const session = selected(1, 5)
    const sourceId = required(session.sources[0]).id
    session.segments = [
      { id: 'a', sourceId, sourceStart: 0, sourceEnd: 2 },
      { kind: 'freeze', id: 'f', sourceId, sourceTime: 2, duration: 1 },
      { id: 'b', sourceId, sourceStart: 2, sourceEnd: 5, transition: { effect: 'fade', duration: 0.4 } },
      { id: 'c', sourceId, sourceStart: 5, sourceEnd: 20 }
    ]
    const replayed = insertReplay(session, 1, 5)
    const copies = replayed.segments.filter((segment) => segment.replayGroupId)
    expect(copies.some(isFreezeSegment)).toBe(true)
    const firstCopy = required(copies[0])
    expect(isFreezeSegment(firstCopy) ? undefined : firstCopy.transition).toBeUndefined()
    expect(copies.filter((segment) => !isFreezeSegment(segment)).every((segment) => video(segment).transition === undefined)).toBe(true)
  })

  it('ripples dividers while spanning overlays and focus zoom continue through the replay gap', () => {
    const session = selected(2, 4)
    session.marks.push(8)
    session.overlays = [{
      id: 'sound', type: 'audio', name: 'sound', path: '/sound.wav', start: 3,
      duration: 4, zIndex: 1, volume: 1, sourceIn: 1
    }]
    session.focusZooms = [{ id: 'zoom', start: 3, duration: 4, zoom: 2, focusX: 0.5, focusY: 0.5 }]
    const replayed = insertReplay(session, 2, 4)
    const replay = required(replayRanges(replayed.segments)[0])
    expect(replayed.marks).toEqual([2, 4, 8, 12])
    expect(replayed.overlays.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 3, duration: 8 }
    ])
    expect(replayed.focusZooms.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 3, duration: 8 }
    ])
    expect(replayed.playhead).toBeGreaterThan(replay.start)
    expect(replayed.playhead).toBeLessThan(replay.start + replay.duration)
  })

  it('removes only the contiguous replay run at the playhead', () => {
    const replayed = insertReplay(selected(2, 4), 2, 4)
    const replay = required(replayRanges(replayed.segments)[0])
    const edited = structuredClone(replayed)
    const runIndex = edited.segments.findIndex((segment) => segment.replayGroupId === replay.groupId)
    edited.segments.splice(runIndex + 1, 0, {
      id: 'ordinary', sourceId: required(edited.sources[0]).id, sourceStart: 10, sourceEnd: 11
    })
    edited.playhead = replay.start + 0.1
    const removed = removeReplayAtPlayhead(edited)
    expect(replayRanges(removed.segments).some((range) => range.start === replay.start)).toBe(false)
    expect(timelineDuration(removed.segments)).toBeLessThan(timelineDuration(edited.segments))
  })

  it('reports removal context and creates unique replay groups', () => {
    const first = insertReplay(selected(2, 4), 2, 4)
    const second = insertReplay({ ...first, playhead: 1 }, 0, 1)
    const groups = replayRanges(second.segments).map(({ groupId }) => groupId)
    expect(new Set(groups).size).toBe(2)
    const inside = { ...first, playhead: required(replayRanges(first.segments)[0]).start + 0.1 }
    expect(replayEligibility(inside).removableGroupId).toBeTruthy()

    const spanning = { ...first, playhead: 3.5, marks: [3, 9] }
    expect(replayEligibility(spanning).reason).toContain('already a replay')
  })
})
