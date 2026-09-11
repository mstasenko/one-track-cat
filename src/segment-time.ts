import type { SourceSegment, VideoSpeed } from './types'

export function isFreezeSegment(segment: SourceSegment): segment is Extract<SourceSegment, { kind: 'freeze' }> {
  return segment.kind === 'freeze'
}

export function segmentPlaybackRate(segment: SourceSegment): VideoSpeed {
  return isFreezeSegment(segment) ? 1 : segment.playbackRate ?? 1
}

export function segmentSourceDuration(segment: SourceSegment): number {
  return isFreezeSegment(segment) ? 0 : Math.max(0, segment.sourceEnd - segment.sourceStart)
}

export function segmentOutputDuration(segment: SourceSegment): number {
  return isFreezeSegment(segment)
    ? segment.duration
    : segmentSourceDuration(segment) / segmentPlaybackRate(segment)
}

export function timelineDuration(segments: readonly SourceSegment[]): number {
  return segments.reduce((total, segment) => total + segmentOutputDuration(segment), 0)
}
