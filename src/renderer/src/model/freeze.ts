import type { EditSession, FreezeDuration, SourceSegment } from '@shared/types'
import { isFreezeSegment, makeId, positionAtOutputTime, sourceForSegment, timeAfterOutputRemoval, timelineDuration, withTransition } from './timeline'
import { timedRangesAfterInsertion, timedRangesAfterRemoval } from './timed-ranges'

const EPSILON = 0.0001

function shiftPoint(time: number, point: number, duration: number): number {
  return time >= point - EPSILON ? time + duration : time
}

function faceBlursAfterFreezeInsertion<T extends { start: number; duration: number }>(
  ranges: T[],
  point: number,
  duration: number
): T[] {
  // Prefer the range covering the frame at the boundary; use an ending range only as a
  // conservative fallback when the insertion is exactly at an existing effect's end.
  const coveringIndex = ranges.findIndex((range) => range.start <= point && point < range.start + range.duration)
  const selectedIndex = coveringIndex >= 0
    ? coveringIndex
    : ranges.findIndex((range) => Math.abs(range.start + range.duration - point) <= EPSILON)
  return ranges.map((range, index) => {
    if (index === selectedIndex) return { ...range, duration: range.duration + duration }
    if (range.start >= point) return { ...range, start: range.start + duration }
    return range
  })
}

export function insertFreezeFrame(session: EditSession, outputTime: number, duration: FreezeDuration): EditSession {
  const position = positionAtOutputTime(session.segments, outputTime)
  if (!position || isFreezeSegment(position.segment)) return session
  const source = sourceForSegment(session, position.segment)
  const fps = source?.metadata.fps && source.metadata.fps > 0 ? source.metadata.fps : session.canvas.fps
  // EOF is a boundary, not a decodable frame; the clip split still uses the original position.
  const sourceTime = source
    ? Math.min(position.sourceTime, Math.max(0, source.metadata.duration - 1 / fps))
    : position.sourceTime
  const freeze: SourceSegment = { kind: 'freeze', id: makeId('freeze'), sourceId: position.segment.sourceId, sourceTime, duration }
  const before = position.sourceTime > position.segment.sourceStart + EPSILON
    ? withTransition({ ...position.segment, id: makeId('segment'), sourceEnd: position.sourceTime }, position.segment.transition)
    : null
  const after = position.sourceTime < position.segment.sourceEnd - EPSILON
    ? { ...position.segment, id: makeId('segment'), sourceStart: position.sourceTime, transition: undefined }
    : null
  const segments = [...session.segments.slice(0, position.segmentIndex), ...(before ? [before] : []), freeze, ...(after ? [after] : []), ...session.segments.slice(position.segmentIndex + 1)]
  const focusZooms = timedRangesAfterInsertion(session.focusZooms, outputTime, duration)
  const faceBlurs = session.faceBlurs === undefined
    ? undefined
    : faceBlursAfterFreezeInsertion(session.faceBlurs, outputTime, duration)
  return {
    ...session,
    segments,
    overlays: session.overlays.map((overlay) => ({ ...overlay, start: shiftPoint(overlay.start, outputTime, duration) })),
    marks: session.marks.map((mark) => shiftPoint(mark, outputTime, duration)),
    focusZooms,
    ...(faceBlurs === undefined ? {} : { faceBlurs }),
    ...(session.videoTransitions === undefined ? {} : {
      videoTransitions: timedRangesAfterInsertion(session.videoTransitions, outputTime, duration)
    }),
    playhead: outputTime
  }
}

export function removeFreezeFrame(session: EditSession, segmentId: string): EditSession {
  const index = session.segments.findIndex((segment) => segment.id === segmentId && isFreezeSegment(segment))
  const freeze = session.segments[index]
  if (index < 0 || !freeze || !isFreezeSegment(freeze)) return session
  const start = timelineDuration(session.segments.slice(0, index))
  const duration = freeze.duration
  const end = start + duration
  const segments = session.segments.filter((segment) => segment.id !== segmentId)
  const faceBlurs = session.faceBlurs === undefined
    ? undefined
    : timedRangesAfterRemoval(session.faceBlurs, start, end)
  return {
    ...session,
    segments,
    overlays: session.overlays.map((overlay) => ({ ...overlay, start: timeAfterOutputRemoval(overlay.start, start, end) })),
    marks: session.marks.map((mark) => timeAfterOutputRemoval(mark, start, end)),
    focusZooms: timedRangesAfterRemoval(session.focusZooms, start, end),
    ...(faceBlurs === undefined ? {} : { faceBlurs }),
    ...(session.videoTransitions === undefined ? {} : {
      videoTransitions: timedRangesAfterRemoval(session.videoTransitions, start, end)
    }),
    playhead: Math.min(start, timelineDuration(segments))
  }
}
