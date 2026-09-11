import type { EditSession } from '@shared/types'
import { marksAfterRemoval, isFreezeSegment, removeOutputRange, segmentOutputDuration, segmentPlaybackRate, sourceForSegment, timeAfterOutputRemoval, timelineDuration, withTransition } from './timeline'
import { timedRangesAfterRemoval } from './timed-ranges'

/** Repair older transitions which asked for moving footage beyond source EOF. */
export function restoreTransitionHandles(session: EditSession): EditSession {
  let result = session
  let boundary = 0
  for (let index = 1; index < result.segments.length; index++) {
    const previous = result.segments[index - 1]
    const current = result.segments[index]
    if (!previous || !current) continue
    boundary += segmentOutputDuration(previous)
    if (isFreezeSegment(previous) || isFreezeSegment(current) || !current.transition) continue
    const source = sourceForSegment(result, previous)
    if (!source) continue
    const rate = segmentPlaybackRate(previous)
    const available = Math.max(0, (source.metadata.duration - previous.sourceEnd) / rate)
    const missing = current.transition.duration - available
    if (missing <= 0.0001) continue
    const overlap = Math.min(missing, segmentOutputDuration(previous) / 2)
    const start = boundary - overlap
    const segments = [...result.segments]
    segments[index - 1] = withTransition({ ...previous, sourceEnd: previous.sourceEnd - overlap * rate }, previous.transition)
    segments[index] = withTransition(current, { ...current.transition, duration: available + overlap })
    result = {
      ...result,
      segments,
      overlays: removeOutputRange(result.segments, result.overlays, start, boundary).overlays,
      marks: marksAfterRemoval(result.marks, start, boundary, timelineDuration(segments)),
      playhead: timeAfterOutputRemoval(result.playhead, start, boundary),
      focusZooms: timedRangesAfterRemoval(result.focusZooms, start, boundary),
      ...(result.faceBlurs ? { faceBlurs: timedRangesAfterRemoval(result.faceBlurs, start, boundary) } : {}),
      ...(result.videoTransitions ? { videoTransitions: timedRangesAfterRemoval(result.videoTransitions, start, boundary) } : {})
    }
    boundary = start
  }
  return result
}
