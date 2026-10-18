import type { EditSession } from '@shared/types'
import { isFreezeSegment, positionAtOutputTime, segmentOutputDuration, sourceForSegment } from '../model/timeline'
import { isShortCanvas, shortFramePositionAtTime, shortFrameRect } from '@shared/short-frame'

export function previewContext(session: EditSession): { position: ReturnType<typeof positionAtOutputTime>; playbackPath: string; freeze: boolean } {
  const position = positionAtOutputTime(session.segments, session.playhead)
  if (!position) return { position, playbackPath: '', freeze: false }
  const source = sourceForSegment(session, position.segment)
  return { position, playbackPath: source?.playbackPath ?? '', freeze: isFreezeSegment(position.segment) }
}

export function previewSeekTime(position: NonNullable<ReturnType<typeof positionAtOutputTime>>, playing: boolean, sourceFps: number): number {
  if (playing || isFreezeSegment(position.segment)) return position.sourceTime
  // Seek into the middle of the chosen source frame. Seeking exactly to its
  // timestamp can leave Chromium displaying the preceding decoded frame.
  const frameInset = sourceFps > 0 ? 0.5 / sourceFps : 0.0001
  return Math.min(position.sourceTime + frameInset, position.segment.sourceEnd)
}

export function previewSourceFps(session: EditSession, position: NonNullable<ReturnType<typeof positionAtOutputTime>>): number {
  const source = sourceForSegment(session, position.segment)
  return source ? source.metadata.fps : 0
}

export function shortFrameGuideStyle(session: EditSession, time: number): React.CSSProperties | undefined {
  if (!isShortCanvas(session.canvas)) return undefined
  const position = positionAtOutputTime(session.segments, time)
  const source = position ? sourceForSegment(session, position.segment) : null
  if (!source) return undefined
  const rectangle = shortFrameRect(
    session.canvas,
    source.metadata,
    shortFramePositionAtTime(session.shortFramePoints ?? [], time, session.canvas.shortFramePosition)
  )
  return {
    left: `${rectangle.left * 100}%`,
    top: `${rectangle.top * 100}%`,
    width: `${rectangle.width * 100}%`,
    height: `${rectangle.height * 100}%`
  }
}

export function previewAudioCut(
  session: EditSession,
  position: ReturnType<typeof positionAtOutputTime>,
  visualTime: number,
  mediaTimeOffset: number
): { approachingAudioCut: boolean; audioCutTime: number | undefined } {
  const nextSegment = position ? session.segments[position.segmentIndex + 1] : undefined
  const audioCutDelay = position && nextSegment
    ? position.outputStart + segmentOutputDuration(position.segment) - visualTime - 0.01
    : Number.POSITIVE_INFINITY
  const approachingAudioCut = audioCutDelay <= 0.1
  const currentSegment = position?.segment
  const audioCutTime = approachingAudioCut && currentSegment && !isFreezeSegment(currentSegment)
    ? currentSegment.sourceEnd + mediaTimeOffset : undefined
  return { approachingAudioCut, audioCutTime }
}
