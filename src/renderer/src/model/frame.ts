import type { EditSession } from '@shared/types'
import { clamp, isFreezeSegment, positionAtOutputTime, sourceForSegment, timelineDuration } from './timeline'

interface VisibleFrame {
  sourceId: string
  index: number
}

function visibleFrame(session: EditSession, time: number): VisibleFrame | null {
  const position = positionAtOutputTime(session.segments, time)
  if (!position || isFreezeSegment(position.segment)) return null
  const metadataFps = sourceForSegment(session, position.segment)?.metadata.fps ?? 0
  const sourceFps = metadataFps > 0 ? metadataFps : session.canvas.fps
  return { sourceId: position.segment.sourceId, index: Math.floor((position.sourceTime + 0.0000001) * sourceFps) }
}

function sameFrame(left: VisibleFrame | null, right: VisibleFrame | null): boolean {
  return left !== null && right !== null && left.sourceId === right.sourceId && left.index === right.index
}

/** Move to the next distinct source frame, staying on the output FPS grid. */
export function stepOutputFrame(
  session: EditSession,
  direction: -1 | 1,
  time = session.playhead
): number {
  const frameDuration = 1 / session.canvas.fps
  const total = timelineDuration(session.segments)
  const position = positionAtOutputTime(session.segments, time)
  const gridFrame = direction > 0
    ? Math.floor(time / frameDuration + 0.0000001)
    : Math.ceil(time / frameDuration - 0.0000001)
  const singleStep = (): number => clamp((gridFrame + direction) * frameDuration, 0, total)
  if (!position || isFreezeSegment(position.segment)) return singleStep()

  const current = visibleFrame(session, time)
  const finalFrame = Math.ceil(total / frameDuration)
  for (let frame = gridFrame + direction; frame >= 0 && frame <= finalFrame; frame += direction) {
    const candidate = clamp(frame * frameDuration, 0, total)
    if (!sameFrame(current, visibleFrame(session, candidate))) return candidate
  }
  return direction > 0 ? total : 0
}
