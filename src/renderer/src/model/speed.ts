import type { EditSession, SourceSegment, VideoSegment, VideoSpeed } from '@shared/types'
import {
  clamp,
  isFreezeSegment,
  segmentOutputDuration,
  segmentPlaybackRate,
  timelineDuration,
  withTransition
} from './timeline'
import { splitSegmentForOutputRange } from './segment-ranges'

const EPSILON = 0.0001

function withRate(segment: VideoSegment, rate: VideoSpeed): VideoSegment {
  const result = { ...segment }
  delete result.playbackRate
  return rate === 1 ? result : { ...result, playbackRate: rate }
}

function splitSegments(segments: SourceSegment[], start: number, end: number, rate: VideoSpeed): SourceSegment[] {
  const result: SourceSegment[] = []
  let cursor = 0
  for (const segment of segments) {
    const duration = segmentOutputDuration(segment)
    const parts = splitSegmentForOutputRange(segment, cursor, start, end)
    const inside = parts.inside
    if (!inside || isFreezeSegment(inside) || segmentPlaybackRate(segment) === rate) {
      result.push(segment)
      cursor += duration
      continue
    }
    if (parts.before) result.push(parts.before)
    result.push(withTransition(withRate(inside, rate), inside.transition))
    if (parts.after) result.push(parts.after)
    cursor += duration
  }
  return result
}

export function applySpeedToOutputRange(session: EditSession, rawStart: number, rawEnd: number, rate: VideoSpeed): EditSession {
  const oldDuration = timelineDuration(session.segments)
  const start = clamp(Math.min(rawStart, rawEnd), 0, oldDuration)
  const end = clamp(Math.max(rawStart, rawEnd), 0, oldDuration)
  if (end - start <= EPSILON) return session
  const segments = splitSegments(session.segments, start, end, rate)
  if (segments.length === session.segments.length && segments.every((segment, index) => segment === session.segments[index])) return session
  const finalDuration = timelineDuration(segments)
  const map = (time: number): number => {
    let mapped = time
    let cursor = 0
    // Apply each original occurrence's local rate delta so replay copies and freezes stay distinct.
    for (const segment of session.segments) {
      const segmentDuration = segmentOutputDuration(segment)
      const overlapStart = Math.max(cursor, start)
      const overlapEnd = Math.min(cursor + segmentDuration, end, time)
      if (!isFreezeSegment(segment) && overlapEnd > overlapStart) {
        mapped += (overlapEnd - overlapStart) * (segmentPlaybackRate(segment) / rate - 1)
      }
      cursor += segmentDuration
    }
    return mapped
  }
  const overlays = session.overlays.map((overlay) => ({ ...overlay, start: map(overlay.start) }))
  const marks = [...new Set(session.marks.map(map))].filter((mark) => mark > EPSILON && mark < finalDuration - EPSILON)
  const focusZooms = session.focusZooms.map((effect) => {
    const mappedStart = map(effect.start)
    return { ...effect, start: mappedStart, duration: Math.max(EPSILON, map(effect.start + effect.duration) - mappedStart) }
  })
  const faceBlurs = session.faceBlurs?.map((effect) => {
    const mappedStart = map(effect.start)
    return { ...effect, start: mappedStart, duration: Math.max(EPSILON, map(effect.start + effect.duration) - mappedStart) }
  })
  const videoTransitions = session.videoTransitions?.map((effect) => {
    const mappedStart = map(effect.start)
    return { ...effect, start: mappedStart, duration: Math.max(EPSILON, map(effect.start + effect.duration) - mappedStart) }
  })
  const playhead = clamp(map(session.playhead), 0, finalDuration)
  return {
    ...session,
    segments,
    overlays,
    marks,
    playhead,
    focusZooms,
    ...(faceBlurs === undefined ? {} : { faceBlurs }),
    ...(videoTransitions === undefined ? {} : { videoTransitions })
  }
}
