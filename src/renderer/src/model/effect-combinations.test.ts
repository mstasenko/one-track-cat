import { describe, expect, it } from 'vitest'
import type {
  EditSession,
  FaceBlurEffect,
  MediaMetadata,
  Overlay,
  VideoRangeTransition
} from '@shared/types'
import { parseSavedSession } from '../../../main/validation'
import { replaceFaceBlurRange } from './face-blur'
import { insertFreezeFrame, removeFreezeFrame } from './freeze'
import { insertReplay, removeReplayAtPlayhead, replayRanges } from './replay'
import { savedSession } from './store-session'
import { applySpeedToOutputRange } from './speed'
import { createSession, isFreezeSegment, timelineDuration } from './timeline'

const EPSILON = 0.0001

const source: MediaMetadata = {
  path: '/synthetic.mp4', name: 'synthetic.mp4', size: 1, modifiedAt: 1, duration: 20,
  width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true
}

const shortSource: MediaMetadata = { ...source, duration: 10 }

const blurSettings = {
  sensitivity: 0.7 as const,
  detail: 'standard' as const,
  holdSeconds: 0.25,
  strength: 0.8,
  style: 'blur' as const
}

function blur(id: string, start: number, duration: number): FaceBlurEffect {
  return { ...blurSettings, id, start, duration }
}

function fade(id: string, start: number, duration: number): VideoRangeTransition {
  return {
    id,
    start,
    duration,
    into: { effect: 'fade', duration: 1 },
    out: { effect: 'dissolve', duration: 1 }
  }
}

function textOverlay(id: string, start: number, duration: number): Overlay {
  return {
    id,
    type: 'text',
    name: id,
    start,
    duration,
    zIndex: 1,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    opacity: 1,
    text: id,
    fontFamily: 'sans',
    fontSize: 4,
    color: '#fff',
    outlineColor: '#000',
    outlineWidth: 0,
    shadow: false,
    align: 'center'
  }
}

function imageOverlay(id: string, start: number, duration: number): Overlay {
  return {
    id,
    type: 'image',
    name: id,
    path: `/${id}.png`,
    start,
    duration,
    zIndex: 1,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    opacity: 1
  }
}

function audioOverlay(id: string, start: number, duration: number): Overlay {
  return {
    id,
    type: 'audio',
    name: id,
    path: `/${id}.wav`,
    start,
    duration,
    zIndex: 1,
    volume: 1,
    sourceIn: 2
  }
}

type RangeSession = Pick<EditSession, 'segments' | 'faceBlurs' | 'videoTransitions'> &
  Partial<Pick<EditSession, 'focusZooms'>>

function assertRangesAreBounded(session: RangeSession): void {
  const duration = timelineDuration(session.segments)
  const check = (ranges: readonly { id: string; start: number; duration: number }[]): void => {
    const ids = ranges.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)
    const sorted = [...ranges].sort((left, right) => left.start - right.start)
    for (const [index, range] of sorted.entries()) {
      expect(range.start).toBeGreaterThanOrEqual(-EPSILON)
      expect(range.duration).toBeGreaterThan(0)
      expect(range.start + range.duration).toBeLessThanOrEqual(duration + EPSILON)
      const previous = sorted[index - 1]
      if (previous) expect(range.start).toBeGreaterThanOrEqual(previous.start + previous.duration - EPSILON)
    }
  }

  check(session.faceBlurs ?? [])
  check(session.videoTransitions ?? [])
  check(session.focusZooms ?? [])
}

function assertOverlaysAreBounded(session: EditSession): void {
  const duration = timelineDuration(session.segments)
  const ids = session.overlays.map(({ id }) => id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const overlay of session.overlays) {
    expect(overlay.start).toBeGreaterThanOrEqual(-EPSILON)
    expect(overlay.duration).toBeGreaterThan(0)
    expect(overlay.start + overlay.duration).toBeLessThanOrEqual(duration + EPSILON)
  }
}

function assertSegmentIdsAreUnique(session: EditSession): void {
  const ids = session.segments.map(({ id }) => id)
  expect(new Set(ids).size).toBe(ids.length)
}

describe('combined effect edits', () => {
  it('retimes face blur and timeline fade through speed/freeze and save validation', () => {
    const session = createSession(shortSource)
    session.faceBlurs = [blur('face', 2, 3)]
    session.videoTransitions = [fade('fade', 2, 3)]
    const original = structuredClone(session)

    const sped = applySpeedToOutputRange(session, 0, 5, 2)
    expect(sped.faceBlurs).toMatchObject([{ id: 'face', start: 1, duration: 1.5 }])
    expect(sped.videoTransitions).toMatchObject([{ id: 'fade', start: 1, duration: 1.5 }])
    expect(sped.sources).toBe(session.sources)
    expect(session).toEqual(original)
    assertRangesAreBounded(sped)

    const frozen = insertFreezeFrame(sped, 1.5, 0.5)
    const freeze = frozen.segments.find(isFreezeSegment)
    if (!freeze) throw new Error('freeze segment missing')
    expect(timelineDuration(frozen.segments)).toBeCloseTo(8)
    expect(frozen.faceBlurs).toMatchObject([{ id: 'face', start: 1, duration: 2 }])
    expect(frozen.videoTransitions).toMatchObject([{ id: 'fade', start: 1, duration: 2 }])
    expect(frozen.sources).toBe(session.sources)
    assertRangesAreBounded(frozen)
    assertSegmentIdsAreUnique(frozen)

    const thawed = removeFreezeFrame(frozen, freeze.id)
    expect(timelineDuration(thawed.segments)).toBeCloseTo(7.5)
    expect(thawed.faceBlurs).toMatchObject([{ id: 'face', start: 1, duration: 1.5 }])
    expect(thawed.videoTransitions).toMatchObject([{ id: 'fade', start: 1, duration: 1.5 }])
    expect(thawed.sources).toBe(session.sources)
    assertRangesAreBounded(thawed)
    assertSegmentIdsAreUnique(thawed)

    const saved = savedSession(thawed, [sped], [frozen])
    expect(saved.faceBlurs).toEqual(thawed.faceBlurs)
    expect(saved.videoTransitions?.[0]).toMatchObject({
      id: 'fade', start: 1, duration: 1.5,
      into: { effect: 'fade', duration: 0.75 },
      out: { effect: 'dissolve', duration: 0.75 }
    })
    const parsed = parseSavedSession(saved)
    for (const snapshot of [parsed, ...(parsed.history ?? []), ...(parsed.future ?? [])]) {
      assertRangesAreBounded(snapshot)
    }
    expect(parsed.faceBlurs).toEqual(thawed.faceBlurs)
    expect(parsed.videoTransitions?.[0]).toMatchObject({
      id: 'fade', start: 1, duration: 1.5,
      into: { effect: 'fade', duration: 0.75 },
      out: { effect: 'dissolve', duration: 0.75 }
    })
    expect(session).toEqual(original)
  })

  it('maps blur coverage across mixed playback rates and a freeze, then removes the replay cleanly', () => {
    const session = createSession(source)
    const sourceId = session.sources[0]?.id
    if (!sourceId) throw new Error('source missing')
    session.segments = [
      { id: 'fast', sourceId, sourceStart: 0, sourceEnd: 4, playbackRate: 2 },
      { kind: 'freeze', id: 'hold', sourceId, sourceTime: 4, duration: 1 },
      { id: 'slow', sourceId, sourceStart: 4, sourceEnd: 8, playbackRate: 0.5 }
    ]
    session.faceBlurs = [blur('mix', 1, 9)]
    const original = structuredClone(session)

    const replayed = insertReplay(session, 0, 11)
    expect(timelineDuration(replayed.segments)).toBeCloseTo(28)
    expect(replayRanges(replayed.segments)).toMatchObject([{ start: 11, duration: 17 }])
    expect(replayed.faceBlurs?.map(({ id, start, duration }) => ({ id, start, duration }))).toEqual([
      { id: 'mix', start: 1, duration: 9 },
      expect.objectContaining({ start: 15, duration: 12 })
    ])
    expect(replayed.faceBlurs).toHaveLength(2)
    expect(replayed.sources).toBe(session.sources)
    expect(session).toEqual(original)
    assertRangesAreBounded(replayed)
    assertSegmentIdsAreUnique(replayed)

    const removable = { ...replayed, playhead: 11.5 }
    const restored = removeReplayAtPlayhead(removable)
    expect(timelineDuration(restored.segments)).toBeCloseTo(11)
    expect(restored.faceBlurs?.map(({ id, start, duration }) => ({ id, start, duration }))).toEqual([
      { id: 'mix', start: 1, duration: 9 }
    ])
    expect(restored.sources).toBe(session.sources)
    assertRangesAreBounded(restored)
    assertSegmentIdsAreUnique(restored)
  })

  it('applies a later face blur only inside the replay and keeps the result saveable', () => {
    const session = createSession(shortSource)
    session.faceBlurs = [blur('original', 2, 2)]
    const original = structuredClone(session)
    const replayed = insertReplay(session, 2, 4)
    const replacement = { ...blurSettings, style: 'pixelate' as const }
    const updated = replaceFaceBlurRange(replayed.faceBlurs ?? [], 5, 7, replacement)
    const edited = { ...replayed, faceBlurs: updated }

    expect(updated.map(({ start, duration, style }) => ({ start, duration, style }))).toEqual([
      { start: 2, duration: 2, style: 'blur' },
      { start: 4, duration: 1, style: 'blur' },
      { start: 5, duration: 2, style: 'pixelate' },
      { start: 7, duration: 1, style: 'blur' }
    ])
    expect(updated.find(({ id }) => id === 'original')).toMatchObject({ start: 2, duration: 2, style: 'blur' })
    expect(edited.sources).toBe(session.sources)
    expect(session).toEqual(original)
    assertRangesAreBounded(edited)
    assertSegmentIdsAreUnique(edited)

    const parsed = parseSavedSession(savedSession(edited))
    expect(parsed.faceBlurs?.map(({ start, duration, style }) => ({ start, duration, style }))).toEqual([
      { start: 2, duration: 2, style: 'blur' },
      { start: 4, duration: 1, style: 'blur' },
      { start: 5, duration: 2, style: 'pixelate' },
      { start: 7, duration: 1, style: 'blur' }
    ])
    assertRangesAreBounded(parsed)
  })

  it('preserves non-face effects around a replay gap while duplicating only face blur', () => {
    const session = createSession(shortSource)
    session.faceBlurs = [blur('face', 2, 2)]
    session.videoTransitions = [fade('span-fade', 3, 4), fade('later-fade', 7, 1)]
    session.focusZooms = [
      { id: 'span-zoom', start: 3, duration: 4, zoom: 2, focusX: 0.5, focusY: 0.5 },
      { id: 'later-zoom', start: 7, duration: 1, zoom: 3, focusX: 0.5, focusY: 0.5 }
    ]
    session.overlays = [
      textOverlay('span-text', 3, 4),
      imageOverlay('span-image', 3, 4),
      audioOverlay('span-audio', 3, 4),
      textOverlay('later-text', 7, 1)
    ]
    const original = structuredClone(session)

    const replayed = insertReplay(session, 2, 4)
    expect(replayed.videoTransitions).toEqual([
      expect.objectContaining({ id: 'span-fade', start: 3, duration: 8 }),
      expect.objectContaining({ id: 'later-fade', start: 11, duration: 1 })
    ])
    expect(replayed.focusZooms).toEqual([
      expect.objectContaining({ id: 'span-zoom', start: 3, duration: 8 }),
      expect.objectContaining({ id: 'later-zoom', start: 11, duration: 1 })
    ])
    expect(replayed.overlays).toEqual([
      expect.objectContaining({ id: 'span-text', start: 3, duration: 8 }),
      expect.objectContaining({ id: 'span-image', start: 3, duration: 8 }),
      expect.objectContaining({ id: 'span-audio', start: 3, duration: 8, sourceIn: 2 }),
      expect.objectContaining({ id: 'later-text', start: 11, duration: 1 })
    ])
    expect(replayed.faceBlurs?.map(({ id, start, duration }) => ({ id, start, duration }))).toEqual([
      { id: 'face', start: 2, duration: 2 },
      expect.objectContaining({ start: 4, duration: 4 })
    ])
    expect(replayed.faceBlurs).toHaveLength(2)
    expect(replayed.sources).toBe(session.sources)
    expect(session).toEqual(original)
    assertRangesAreBounded(replayed)
    assertOverlaysAreBounded(replayed)

    const restored = removeReplayAtPlayhead({ ...replayed, playhead: 4.5 })
    expect(timelineDuration(restored.segments)).toBeCloseTo(10)
    expect(restored.videoTransitions).toEqual([
      expect.objectContaining({ id: 'span-fade', start: 3, duration: 4 }),
      expect.objectContaining({ id: 'later-fade', start: 7, duration: 1 })
    ])
    expect(restored.focusZooms).toEqual([
      expect.objectContaining({ id: 'span-zoom', start: 3, duration: 4 }),
      expect.objectContaining({ id: 'later-zoom', start: 7, duration: 1 })
    ])
    expect(restored.faceBlurs?.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 2, duration: 2 }
    ])
    expect(restored.sources).toBe(session.sources)
    assertRangesAreBounded(restored)
    assertOverlaysAreBounded(restored)
    expect(() => parseSavedSession(savedSession(restored))).not.toThrow()

    const boundary = createSession(shortSource)
    boundary.videoTransitions = [fade('end-fade', 2, 2)]
    boundary.focusZooms = [{ id: 'end-zoom', start: 2, duration: 2, zoom: 1.5, focusX: 0.5, focusY: 0.5 }]
    boundary.overlays = [
      textOverlay('end-text', 2, 2),
      imageOverlay('end-image', 2, 2),
      audioOverlay('end-audio', 2, 2)
    ]
    const boundaryReplay = insertReplay(boundary, 2, 4)
    expect(boundaryReplay.videoTransitions).toEqual([expect.objectContaining({ id: 'end-fade', start: 2, duration: 2 })])
    expect(boundaryReplay.focusZooms).toEqual([expect.objectContaining({ id: 'end-zoom', start: 2, duration: 2 })])
    expect(boundaryReplay.overlays).toEqual([
      expect.objectContaining({ id: 'end-text', start: 2, duration: 2 }),
      expect.objectContaining({ id: 'end-image', start: 2, duration: 2 }),
      expect.objectContaining({ id: 'end-audio', start: 2, duration: 2 })
    ])
    assertRangesAreBounded(boundaryReplay)
    assertOverlaysAreBounded(boundaryReplay)
  })
})
