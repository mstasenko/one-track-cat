import type {
  EditSession,
  MediaMetadata,
  Overlay,
  SourceSegment,
  TimelineSource,
  TextOverlay,
  VideoTransition
} from '@shared/types'
import { timedRangesAfterInsertion } from './timed-ranges'
import { isFreezeSegment, segmentOutputDuration, segmentPlaybackRate, segmentSourceDuration, timelineDuration } from '@shared/segment-time'

export { isFreezeSegment, segmentOutputDuration, segmentPlaybackRate, segmentSourceDuration, timelineDuration } from '@shared/segment-time'

const EPSILON = 0.0001

export function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function segmentSourceStart(segment: SourceSegment): number { return isFreezeSegment(segment) ? segment.sourceTime : segment.sourceStart }
function segmentSourceEnd(segment: SourceSegment): number { return isFreezeSegment(segment) ? segment.sourceTime : segment.sourceEnd }
export function createSession(source: MediaMetadata, short = false): EditSession {
  const sourceId = makeId('source')
  // A fixed Short canvas keeps the centered cover crop identical in preview and export.
  return {
    canvas: {
      width: short ? 1080 : source.width,
      height: short ? 1920 : source.height,
      fps: source.fps > 0 ? source.fps : 30,
      fit: short ? 'cover' : 'contain'
    },
    sources: [{ id: sourceId, metadata: source, playbackPath: source.path, waveform: [] }],
    segments: [{ id: makeId('segment'), sourceId, sourceStart: 0, sourceEnd: source.duration }],
    overlays: [],
    selectedOverlayId: null,
    playhead: 0,
    marks: [],
    focusZooms: [],
    faceBlurs: [],
    videoTransitions: []
  }
}

export function sourceForSegment(session: EditSession, segment: SourceSegment): TimelineSource | null {
  return session.sources.find((source) => source.id === segment.sourceId) ?? null
}

export function primarySource(session: EditSession): TimelineSource {
  const source = session.sources[0]
  if (!source) throw new Error('The project has no video source')
  return source
}

export interface TimelinePosition {
  segmentIndex: number
  segment: SourceSegment
  outputStart: number
  sourceTime: number
}

export function positionAtOutputTime(
  segments: SourceSegment[],
  outputTime: number
): TimelinePosition | null {
  if (segments.length === 0) return null
  const total = timelineDuration(segments)
  const safeTime = clamp(outputTime, 0, total)
  let outputStart = 0

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (!segment) continue
    const segmentDuration = segmentOutputDuration(segment)
    const isLast = index === segments.length - 1
    if (safeTime < outputStart + segmentDuration || isLast) {
      const sourceOffset = isFreezeSegment(segment) ? 0 : (safeTime - outputStart) * segmentPlaybackRate(segment)
      const sourceStart = segmentSourceStart(segment)
      return {
        segmentIndex: index,
        segment,
        outputStart,
        sourceTime: clamp(
          sourceStart + sourceOffset,
          sourceStart,
          segmentSourceEnd(segment)
        )
      }
    }
    outputStart += segmentDuration
  }
  return null
}

export function outputTimeForSource(
  segments: SourceSegment[],
  segmentIndex: number,
  sourceTime: number
): number {
  const before = timelineDuration(segments.slice(0, segmentIndex))
  const segment = segments[segmentIndex]
  if (!segment) return before
  if (isFreezeSegment(segment)) return before
  return before + clamp(sourceTime - segment.sourceStart, 0, segmentSourceDuration(segment)) /
    segmentPlaybackRate(segment)
}

type SourceTimedOverlay = Extract<Overlay, { type: 'audio' | 'video' | 'gif' }>

export function isSourceTimedOverlay(overlay: Overlay): overlay is SourceTimedOverlay {
  return overlay.type === 'audio' || overlay.type === 'video' || overlay.type === 'gif'
}

export function overlaySourceTime(overlay: SourceTimedOverlay, timelineTime: number): number {
  const elapsed = Math.max(0, timelineTime - overlay.start)
  const sourceTime = overlay.sourceIn + elapsed
  return (overlay.type === 'gif' || (overlay.type === 'video' && overlay.loop)) && overlay.sourceDuration > EPSILON
    ? sourceTime % overlay.sourceDuration
    : sourceTime
}

function trimSourceOverlay(overlay: SourceTimedOverlay, start: number, end: number): Overlay[] {
  const overlayEnd = overlay.start + overlay.duration
  const leftDuration = Math.max(0, start - overlay.start)
  const rightDuration = Math.max(0, overlayEnd - end)
  const output: Overlay[] = []
  // A middle ripple cut creates two clips. The right clip advances sourceIn so
  // playback and export skip the removed source interval instead of restarting.
  if (leftDuration > EPSILON) output.push({ ...overlay, duration: leftDuration })
  if (rightDuration > EPSILON) {
    output.push({
      ...overlay,
      id: leftDuration > EPSILON ? makeId(overlay.type) : overlay.id,
      start,
      duration: rightDuration,
      sourceIn: overlay.sourceIn + Math.max(0, end - overlay.start)
    })
  }
  return output
}

function trimOverlaysForRemoval(overlays: Overlay[], start: number, end: number): Overlay[] {
  const removedDuration = end - start
  return overlays.flatMap((overlay) => {
    const overlayEnd = overlay.start + overlay.duration
    if (overlayEnd <= start) return [overlay]
    if (overlay.start >= end) return [{ ...overlay, start: overlay.start - removedDuration }]
    if (isSourceTimedOverlay(overlay)) return trimSourceOverlay(overlay, start, end)
    if (overlay.start < start && overlayEnd > end) {
      return [{ ...overlay, duration: overlay.duration - removedDuration }]
    }
    if (overlay.start < start && overlayEnd > start) {
      const duration = start - overlay.start
      return duration > EPSILON ? [{ ...overlay, duration }] : []
    }
    if (overlay.start < end && overlayEnd > end) {
      const duration = overlayEnd - end
      return duration > EPSILON ? [{ ...overlay, start, duration }] : []
    }
    return []
  })
}

export function removeOutputRange(
  segments: SourceSegment[],
  overlays: Overlay[],
  rawStart: number,
  rawEnd: number
): { segments: SourceSegment[]; overlays: Overlay[] } {
  const duration = timelineDuration(segments)
  const start = clamp(Math.min(rawStart, rawEnd), 0, duration)
  const end = clamp(Math.max(rawStart, rawEnd), 0, duration)
  if (end - start <= EPSILON) return { segments, overlays }

  const output: SourceSegment[] = []
  let outputCursor = 0
  for (const segment of segments) {
    const segmentDuration = segmentOutputDuration(segment)
    const segmentOutputEnd = outputCursor + segmentDuration
    const keepBefore = clamp(start - outputCursor, 0, segmentDuration)
    const keepAfter = clamp(segmentOutputEnd - end, 0, segmentDuration)
    const rate = segmentPlaybackRate(segment)

    if (isFreezeSegment(segment)) {
      const keptDuration = keepBefore + keepAfter
      if (keptDuration > EPSILON) output.push({ ...segment, id: makeId('freeze'), duration: keptDuration })
      outputCursor = segmentOutputEnd
      continue
    }

    if (keepBefore > EPSILON) {
      output.push(withTransition({
        ...segment,
        id: makeId('segment'),
        sourceEnd: segment.sourceStart + keepBefore * rate
      }, segment.transition))
    }
    if (keepAfter > EPSILON) {
      output.push(withTransition({
        ...segment,
        id: makeId('segment'),
        sourceStart: segment.sourceEnd - keepAfter * rate,
        sourceEnd: segment.sourceEnd
      }, keepAfter >= segmentDuration - EPSILON ? segment.transition : undefined))
    }
    outputCursor = segmentOutputEnd
  }

  return {
    // A transition cannot lead into the first remaining clip because there is no
    // outgoing frame. Removing it also keeps restored projects deterministic.
    segments: output.map((segment, index) => index === 0 ? withTransition(segment) : segment),
    overlays: trimOverlaysForRemoval(overlays, start, end)
  }
}

function fittedTransition(
  transition: VideoTransition | undefined,
  segmentDuration: number
): VideoTransition | undefined {
  if (!transition || transition.duration < 0.05 || segmentDuration < 0.05) return undefined
  return { ...transition, duration: Math.min(transition.duration, segmentDuration, 5) }
}

export function withTransition(
  segment: SourceSegment,
  transition?: VideoTransition
): SourceSegment {
  if (isFreezeSegment(segment)) return segment
  const plainSegment = { ...segment }
  delete plainSegment.transition
  const fitted = fittedTransition(transition, segmentOutputDuration(segment))
  return fitted ? { ...plainSegment, transition: fitted } : plainSegment
}

function overlaysAfterInsertion(overlays: Overlay[], point: number, duration: number): Overlay[] {
  return overlays.flatMap((overlay) => {
    const overlayEnd = overlay.start + overlay.duration
    if (overlayEnd <= point + EPSILON) return [overlay]
    if (overlay.start >= point - EPSILON) return [{ ...overlay, start: overlay.start + duration }]

    const leftDuration = point - overlay.start
    const rightDuration = overlayEnd - point
    const right: Overlay = {
      ...overlay,
      id: makeId(overlay.type),
      start: point + duration,
      duration: rightDuration,
      ...(isSourceTimedOverlay(overlay) ? { sourceIn: overlay.sourceIn + leftDuration } : {})
    } as Overlay
    return [{ ...overlay, duration: leftDuration }, right]
  })
}

export function normalizedMarks(marks: number[], total: number): number[] {
  const sorted = marks.filter((mark) => mark > EPSILON && mark < total - EPSILON).sort((left, right) => left - right)
  return sorted.filter((mark, index) => index === 0 || Math.abs(mark - (sorted[index - 1] ?? 0)) > EPSILON)
}

/** Ripple output-timed edits around inserted base media. */
export function insertOutputGap(session: EditSession, point: number, duration: number): EditSession {
  const total = timelineDuration(session.segments) + duration
  const faceBlurs = session.faceBlurs === undefined
    ? undefined
    : timedRangesAfterInsertion(session.faceBlurs, point, duration)
  return {
    ...session,
    overlays: overlaysAfterInsertion(session.overlays, point, duration),
    focusZooms: timedRangesAfterInsertion(session.focusZooms, point, duration),
    ...(faceBlurs === undefined ? {} : { faceBlurs }),
    ...(session.videoTransitions === undefined ? {} : {
      videoTransitions: timedRangesAfterInsertion(session.videoTransitions, point, duration)
    }),
    marks: normalizedMarks(session.marks.map((mark) =>
      mark > point + EPSILON ? mark + duration : mark
    ), total)
  }
}

export function deletionRange(session: EditSession): [number, number] | null {
  const marks = [...session.marks].sort((left, right) => left - right)
  if (marks.length === 0) return null
  const duration = timelineDuration(session.segments)
  // Marks are dividers, not paired selections. Choosing the partition that
  // contains the playhead scales to any number of marks and keeps one Remove Marked action.
  // At an exact divider, select the partition on its left so a newly added mark
  // immediately highlights the video leading up to it.
  const nextIndex = marks.findIndex((mark) => session.playhead <= mark)
  if (nextIndex < 0) return [marks.at(-1) ?? 0, duration]
  return [marks[nextIndex - 1] ?? 0, marks[nextIndex] ?? duration]
}

export function marksAfterRemoval(
  marks: number[],
  start: number,
  end: number,
  duration: number
): number[] {
  // Marks inside a removed partition collapse onto its join. Deduplication leaves
  // one useful divider there while endpoint filtering avoids zero-length ranges.
  const shifted = marks.map((mark) => timeAfterOutputRemoval(mark, start, end))
    .filter((mark) => mark > EPSILON && mark < duration - EPSILON)
  return [...new Set(shifted)].sort((left, right) => left - right)
}

export function timeAfterOutputRemoval(time: number, start: number, end: number): number {
  if (time <= start) return time
  return time <= end ? start : time - (end - start)
}

export function defaultTextOverlay(start: number, zIndex: number): TextOverlay {
  return {
    id: makeId('text'),
    type: 'text',
    name: 'Text',
    start,
    duration: 3,
    zIndex,
    x: 0.15,
    y: 0.72,
    width: 0.7,
    height: 0.2,
    opacity: 1,
    text: 'Your text',
    fontFamily: 'Anton',
    fontSize: 7,
    color: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 3,
    shadow: true,
    align: 'center'
  }
}

export function overlayAtTime(overlay: Overlay, time: number): boolean {
  return time >= overlay.start && time < overlay.start + overlay.duration
}

export function formatTime(seconds: number, framesPerSecond = 30): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const fps = Number.isFinite(framesPerSecond) && framesPerSecond > 0
    ? Math.max(1, Math.round(framesPerSecond))
    : 30
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const remainder = Math.floor(safe % 60)
  const frames = Math.min(fps - 1, Math.floor((safe - Math.floor(safe)) * fps))
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}.${String(frames).padStart(2, '0')}`
}
