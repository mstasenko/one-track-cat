import type { EditSession, InsertTransitions, SourceSegment, TimelineSource } from '@shared/types'
import { clamp, insertOutputGap, isFreezeSegment, makeId, segmentPlaybackRate, segmentOutputDuration, timelineDuration, withTransition } from './timeline'

const EPSILON = 0.0001

interface SegmentRangeParts {
  before?: SourceSegment
  inside?: SourceSegment
  after?: SourceSegment
}

function segmentOutputSlice(segment: SourceSegment, rawStart: number, rawEnd: number): SourceSegment | undefined {
  const duration = segmentOutputDuration(segment)
  const start = clamp(Math.min(rawStart, rawEnd), 0, duration)
  const end = clamp(Math.max(rawStart, rawEnd), 0, duration)
  if (end - start <= EPSILON) return undefined
  if (start <= EPSILON && end >= duration - EPSILON) return segment
  if (isFreezeSegment(segment)) {
    return { ...segment, id: makeId('freeze'), duration: end - start }
  }
  const rate = segmentPlaybackRate(segment)
  const piece = {
    ...segment,
    id: makeId('segment'),
    sourceStart: segment.sourceStart + start * rate,
    sourceEnd: segment.sourceStart + end * rate
  }
  return withTransition(piece, start <= EPSILON ? segment.transition : undefined)
}

export function splitSegmentForOutputRange(
  segment: SourceSegment,
  segmentStart: number,
  rangeStart: number,
  rangeEnd: number
): SegmentRangeParts {
  const duration = segmentOutputDuration(segment)
  const localStart = clamp(rangeStart - segmentStart, 0, duration)
  const localEnd = clamp(rangeEnd - segmentStart, 0, duration)
  return {
    before: segmentOutputSlice(segment, 0, localStart),
    inside: segmentOutputSlice(segment, localStart, localEnd),
    after: segmentOutputSlice(segment, localEnd, duration)
  }
}

export function segmentsForOutputRange(segments: SourceSegment[], rawStart: number, rawEnd: number): SourceSegment[] {
  const start = Math.min(rawStart, rawEnd)
  const end = Math.max(rawStart, rawEnd)
  const output: SourceSegment[] = []
  let cursor = 0
  for (const segment of segments) {
    const duration = segmentOutputDuration(segment)
    const piece = segmentOutputSlice(segment, start - cursor, end - cursor)
    if (piece) output.push(piece)
    cursor += duration
  }
  return output
}

export function insertSegmentsAtOutputTime(
  segments: SourceSegment[],
  rawPoint: number,
  inserted: SourceSegment[],
  clearFollowingTransition = false
): SourceSegment[] {
  const total = segments.reduce((sum, segment) => sum + segmentOutputDuration(segment), 0)
  const point = clamp(rawPoint, 0, total)
  let cursor = 0
  for (const [index, segment] of segments.entries()) {
    const duration = segmentOutputDuration(segment)
    const offset = point - cursor
    if (offset <= EPSILON) {
      const following = clearFollowingTransition ? withTransition(segment) : segment
      return [...segments.slice(0, index), ...inserted, following, ...segments.slice(index + 1)]
    }
    if (offset < duration - EPSILON) {
      const before = segmentOutputSlice(segment, 0, offset)
      const after = segmentOutputSlice(segment, offset, duration)
      return [
        ...segments.slice(0, index),
        ...(before ? [before] : []),
        ...inserted,
        ...(after ? [withTransition(after)] : []),
        ...segments.slice(index + 1)
      ]
    }
    cursor += duration
  }
  return [...segments, ...inserted]
}

function overlapTransition(segments: SourceSegment[], index: number): number {
  const previous = segments[index - 1]
  const current = segments[index]
  if (!previous || !current || isFreezeSegment(previous) || isFreezeSegment(current) || !current.transition) return 0
  // Reserve real outgoing frames for the blend instead of asking the decoder
  // for footage after EOF. Each edge uses at most half of either clip.
  const duration = Math.min(current.transition.duration, segmentOutputDuration(previous) / 2, segmentOutputDuration(current) / 2)
  if (duration < 0.05) {
    segments[index] = withTransition(current)
    return 0
  }
  segments[index - 1] = withTransition({
    ...previous,
    sourceEnd: previous.sourceEnd - duration * segmentPlaybackRate(previous)
  }, previous.transition)
  segments[index] = withTransition(current, { ...current.transition, duration })
  return duration
}

export function insertSourceAtOutputTime(
  session: EditSession,
  source: TimelineSource,
  rawPoint: number,
  transitions: InsertTransitions = {}
): EditSession {
  const point = clamp(rawPoint, 0, timelineDuration(session.segments))
  const inserted = withTransition({
    id: makeId('segment'),
    sourceId: source.id,
    sourceStart: 0,
    sourceEnd: source.metadata.duration
  }, point > EPSILON ? transitions.into : undefined)
  const segments = insertSegmentsAtOutputTime(session.segments, point, [inserted])
  const insertedIndex = segments.findIndex((segment) => segment.id === inserted.id)
  const following = segments[insertedIndex + 1]
  if (following) segments[insertedIndex + 1] = withTransition(following, transitions.back)
  const intoOverlap = overlapTransition(segments, insertedIndex)
  const backOverlap = overlapTransition(segments, insertedIndex + 1)
  const addedDuration = source.metadata.duration - intoOverlap - backOverlap
  return {
    ...insertOutputGap(session, point, addedDuration),
    sources: [...session.sources, source],
    segments,
    selectedOverlayId: null,
    playhead: point + addedDuration
  }
}
