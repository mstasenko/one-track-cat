import type { EditSession } from '@shared/types'
import type { TimelinePosition } from '../model/timeline'
import { isFreezeSegment, segmentPlaybackRate, segmentSourceStart, sourceForSegment } from '../model/timeline'

export const overlaySyncTolerances = {
  audio: 0.04,
  'video-audio': 0.06,
  visual: 0.18
} as const

export function previewMediaVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1
  return Math.max(0, Math.min(1, volume))
}

export function overlayNeedsResync(
  currentTime: number,
  expectedTime: number,
  kind: keyof typeof overlaySyncTolerances
): boolean {
  return Math.abs(currentTime - expectedTime) > overlaySyncTolerances[kind]
}

export interface SecondaryPreviewMedia {
  path: string
  time: number
  rate: number
}

export function secondaryPreviewMedia(
  session: EditSession,
  position: TimelinePosition | null,
  waiting: boolean,
  requestedTime: number
): SecondaryPreviewMedia {
  if (!position) return { path: '', time: 0, rate: 0 }
  const currentSource = sourceForSegment(session, position.segment)
  const currentPath = currentSource?.playbackPath ?? ''
  if (waiting) {
    return {
      path: currentPath,
      time: requestedTime,
      rate: isFreezeSegment(position.segment) ? 0 : segmentPlaybackRate(position.segment)
    }
  }

  const nextSegment = session.segments[position.segmentIndex + 1]
  const nextTransition = nextSegment?.kind !== 'freeze' ? nextSegment?.transition : undefined
  const nextSource = nextSegment && !nextTransition ? sourceForSegment(session, nextSegment) : null
  if (nextSegment && nextSource) {
    return { path: nextSource.playbackPath, time: segmentSourceStart(nextSegment), rate: 0 }
  }

  const rate = !isFreezeSegment(position.segment) && nextTransition &&
    position.segment.sourceEnd - position.sourceTime <= segmentPlaybackRate(position.segment)
    ? segmentPlaybackRate(position.segment)
    : 0
  return { path: currentPath, time: position.sourceTime, rate }
}
