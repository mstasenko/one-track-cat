import type { EditSession, FaceBlurEffect, SourceSegment } from '@shared/types'
import { marksAfterRemoval, deletionRange, insertOutputGap, isFreezeSegment, makeId, normalizedMarks, positionAtOutputTime, removeOutputRange, segmentOutputDuration, segmentPlaybackRate, segmentSourceDuration, timelineDuration, withTransition, clamp } from './timeline'
import { insertSegmentsAtOutputTime, segmentsForOutputRange } from './segment-ranges'
import { timedRangesAfterInsertion, timedRangesAfterRemoval } from './timed-ranges'

const EPSILON = 0.0001

interface ReplayEligibility {
  range: [number, number] | null
  reason: string | null
  removableGroupId: string | null
}

interface ReplayRange {
  groupId: string
  start: number
  duration: number
}

function replayTimeAtSourceOutput(segments: SourceSegment[], rawTime: number): number {
  const sourceTime = clamp(rawTime, 0, timelineDuration(segments))
  let sourceCursor = 0
  let replayCursor = 0
  for (const segment of segments) {
    const outputDuration = segmentOutputDuration(segment)
    const local = Math.max(0, Math.min(outputDuration, sourceTime - sourceCursor))
    const replayDuration = isFreezeSegment(segment) ? segment.duration : segmentSourceDuration(segment) / 0.5
    const replayLocal = isFreezeSegment(segment)
      ? local
      : local * segmentPlaybackRate(segment) / 0.5
    if (sourceTime <= sourceCursor + outputDuration) return replayCursor + replayLocal
    sourceCursor += outputDuration
    replayCursor += replayDuration
  }
  return replayCursor
}

function faceBlursAroundReplayGap(
  effects: FaceBlurEffect[],
  point: number,
  duration: number
): FaceBlurEffect[] {
  return effects.flatMap((effect) => {
    const effectEnd = effect.start + effect.duration
    if (effectEnd <= point + EPSILON) return [effect]
    if (effect.start >= point - EPSILON) return [{ ...effect, start: effect.start + duration }]

    const leftDuration = point - effect.start
    const rightDuration = effectEnd - point
    return [
      ...(leftDuration > EPSILON ? [{ ...effect, duration: leftDuration }] : []),
      ...(rightDuration > EPSILON
        ? [{ ...effect, id: makeId('face-blur'), start: point + duration, duration: rightDuration }]
        : [])
    ]
  })
}

function replayFaceBlurs(
  rippled: FaceBlurEffect[],
  original: FaceBlurEffect[],
  selected: SourceSegment[],
  start: number,
  end: number,
  insertionPoint: number
): FaceBlurEffect[] {
  const copied = original.flatMap((effect) => {
    const effectEnd = effect.start + effect.duration
    const copyStart = Math.max(effect.start, start)
    const copyEnd = Math.min(effectEnd, end)
    if (copyEnd - copyStart <= 0.0001) return []
    const replayStart = insertionPoint + replayTimeAtSourceOutput(selected, copyStart - start)
    const replayEnd = insertionPoint + replayTimeAtSourceOutput(selected, copyEnd - start)
    return replayEnd - replayStart > 0.0001
      ? [{ ...effect, id: makeId('face-blur'), start: replayStart, duration: replayEnd - replayStart }]
      : []
  })
  return [...rippled, ...copied].sort((left, right) => left.start - right.start)
}

function boundaryInsideTransition(segments: SourceSegment[], boundary: number, beginning: boolean): boolean {
  let cursor = 0
  for (const segment of segments) {
    if (!isFreezeSegment(segment) && segment.transition) {
      const end = cursor + segment.transition.duration
      const afterStart = beginning ? boundary >= cursor - EPSILON : boundary > cursor + EPSILON
      if (afterStart && boundary < end - EPSILON) return true
    }
    cursor += segmentOutputDuration(segment)
  }
  return false
}

function replayGroupAtPlayhead(session: EditSession): string | null {
  return positionAtOutputTime(session.segments, session.playhead)?.segment.replayGroupId ?? null
}

export function replayEligibility(session: EditSession): ReplayEligibility {
  const removableGroupId = replayGroupAtPlayhead(session)
  if (removableGroupId) return { range: null, reason: null, removableGroupId }
  const range = deletionRange(session)
  if (!range) return { range: null, reason: 'Add marks around a moment first.', removableGroupId: null }
  const duration = range[1] - range[0]
  if (duration < 2 / session.canvas.fps - EPSILON) return { range: null, reason: 'Choose a moment at least two frames long.', removableGroupId: null }
  if (boundaryInsideTransition(session.segments, range[0], true) || boundaryInsideTransition(session.segments, range[1], false)) {
    return { range: null, reason: null, removableGroupId: null }
  }
  const selected = segmentsForOutputRange(session.segments, range[0], range[1])
  if (selected.some((segment) => segment.replayGroupId)) return { range: null, reason: 'This moment is already a replay.', removableGroupId: null }
  return { range, reason: null, removableGroupId: null }
}

function replaySegments(segments: SourceSegment[], groupId: string): SourceSegment[] {
  return segments.map((segment) => {
    if (isFreezeSegment(segment)) return { ...segment, id: makeId('freeze'), replayGroupId: groupId }
    const replay = {
      ...segment,
      id: makeId('segment'),
      playbackRate: 0.5 as const,
      replayGroupId: groupId
    }
    return withTransition(replay)
  })
}

export function insertReplay(session: EditSession, start: number, end: number): EditSession {
  const selected = segmentsForOutputRange(session.segments, start, end)
  if (selected.length === 0) return session
  const groupId = makeId('replay')
  const copied = replaySegments(selected, groupId)
  const insertedDuration = timelineDuration(copied)
  if (insertedDuration <= EPSILON) return session
  const insertionPoint = Math.max(start, end)
  const rippled = insertOutputGap(session, insertionPoint, insertedDuration)
  const segments = insertSegmentsAtOutputTime(session.segments, insertionPoint, copied, true)
  const faceBlurs = session.faceBlurs === undefined
    ? undefined
    : replayFaceBlurs(
      faceBlursAroundReplayGap(session.faceBlurs, insertionPoint, insertedDuration),
      session.faceBlurs,
      selected,
      start,
      end,
      insertionPoint
    )
  const total = timelineDuration(segments)
  const marks = normalizedMarks([
    ...rippled.marks,
    insertionPoint,
    insertionPoint + insertedDuration
  ], total)
  const firstFrame = 1 / session.canvas.fps
  return {
    ...rippled,
    segments,
    // Existing layers spanning the insertion stay active; only face coverage
    // is additionally copied from the selected footage into the replay.
    overlays: timedRangesAfterInsertion(session.overlays, insertionPoint, insertedDuration),
    ...(faceBlurs === undefined ? {} : { faceBlurs }),
    marks,
    playhead: insertionPoint + Math.min(firstFrame, insertedDuration / 2)
  }
}

export function replayRanges(segments: SourceSegment[]): ReplayRange[] {
  const ranges: ReplayRange[] = []
  let cursor = 0
  for (const segment of segments) {
    const duration = segmentOutputDuration(segment)
    const groupId = segment.replayGroupId
    const previous = ranges.at(-1)
    if (groupId && previous?.groupId === groupId && Math.abs(previous.start + previous.duration - cursor) <= EPSILON) {
      previous.duration += duration
    } else if (groupId) {
      ranges.push({ groupId, start: cursor, duration })
    }
    cursor += duration
  }
  return ranges
}

export function removeReplayAtPlayhead(session: EditSession): EditSession {
  const position = positionAtOutputTime(session.segments, session.playhead)
  const groupId = position?.segment.replayGroupId
  if (!position || !groupId) return session
  let first = position.segmentIndex
  let last = position.segmentIndex
  while (session.segments[first - 1]?.replayGroupId === groupId) first -= 1
  while (session.segments[last + 1]?.replayGroupId === groupId) last += 1
  const start = timelineDuration(session.segments.slice(0, first))
  const end = start + timelineDuration(session.segments.slice(first, last + 1))
  const result = removeOutputRange(session.segments, session.overlays, start, end)
  const duration = timelineDuration(result.segments)
  const faceBlurs = session.faceBlurs === undefined
    ? undefined
    : timedRangesAfterRemoval(session.faceBlurs, start, end)
  return {
    ...session,
    ...result,
    marks: marksAfterRemoval(session.marks, start, end, duration),
    focusZooms: timedRangesAfterRemoval(session.focusZooms, start, end),
    ...(session.videoTransitions === undefined ? {} : {
      videoTransitions: timedRangesAfterRemoval(session.videoTransitions, start, end)
    }),
    ...(faceBlurs === undefined ? {} : { faceBlurs }),
    playhead: Math.min(start, duration),
    selectedOverlayId: result.overlays.some((overlay) => overlay.id === session.selectedOverlayId)
      ? session.selectedOverlayId
      : null
  }
}
