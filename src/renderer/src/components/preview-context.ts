import type { EditSession } from '@shared/types'
import { isFreezeSegment, outputTimeForSource, positionAtOutputTime, segmentOutputDuration, segmentPlaybackRate, segmentSourceStart, sourceForSegment } from '../model/timeline'
import type { TransitionPreview } from '../model/transitions'
import { isShortCanvas, shortFramePositionAtTime, shortFrameRect } from '@shared/short-frame'
import { incomingTransitionMedia, secondaryPreviewMedia, type SecondaryPreviewMedia } from './preview-media'

export interface AudioTail {
  key: string
  kind: 'secondary' | 'incoming'
  path: string
  time: number
  rate: number
  preview?: TransitionPreview
}

export interface TransitionPreviewSnapshot {
  key: string
  preview: TransitionPreview
}

interface PreviewHandoffInputs {
  session: EditSession
  position: ReturnType<typeof positionAtOutputTime>
  playbackKey: string
  readyPlaybackKey: string
  audioTail: AudioTail | null
  lastTransitionPreview: TransitionPreviewSnapshot | null
  playing: boolean
  requestedSourceTime: number
  transitionPreview: TransitionPreview | null
}

interface IncomingTransitionPlayheadInput {
  session: EditSession
  position: ReturnType<typeof positionAtOutputTime>
  transitionPreview: TransitionPreview | null
  clockPreview: TransitionPreview | null
  mediaTime: number
  path: string
  mediaTimeOffsets: ReadonlyMap<string, number>
  rememberOffset: (segmentId: string, offset: number) => void
  onPlayhead: (time: number) => void
}

interface PreviewHandoffState {
  waitingForSwitchedFrame: boolean
  secondary: SecondaryPreviewMedia
  incomingTransition: SecondaryPreviewMedia
  incomingRenderPreview: TransitionPreview | null
  incomingAudioFallback: boolean
  fallbackAudio: boolean
  audibleFallback: boolean
  primaryHidden: boolean
  mainTransition: TransitionPreview | null
  clockPreview: TransitionPreview | null
  fallbackClock: 'secondary' | 'incoming' | null
}

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

export function shortFrameGuideRect(session: EditSession, time: number): ReturnType<typeof shortFrameRect> | undefined {
  if (!isShortCanvas(session.canvas)) return undefined
  const position = positionAtOutputTime(session.segments, time)
  const source = position ? sourceForSegment(session, position.segment) : null
  if (!source) return undefined
  return shortFrameRect(
    session.canvas,
    source.metadata,
    shortFramePositionAtTime(session.shortFramePoints ?? [], time, session.canvas.shortFramePosition)
  )
}

export function shortFrameGuideStyle(session: EditSession, time: number): React.CSSProperties | undefined {
  const rectangle = shortFrameGuideRect(session, time)
  if (!rectangle) return undefined
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
  // Media and Web Audio clocks can differ by several milliseconds. Finish the
  // fade before the decoder is stopped or retargeted, rather than at that instant.
  const audioCutTime = approachingAudioCut && currentSegment && !isFreezeSegment(currentSegment)
    ? currentSegment.sourceEnd + mediaTimeOffset - 0.01 * segmentPlaybackRate(currentSegment) : undefined
  return { approachingAudioCut, audioCutTime }
}

/** The visual transition may finish before primary decoding does. Keep the
 * audible incoming decoder alive until primary takes over and its fade drains. */
export function previewHandoff({
  session,
  position,
  playbackKey,
  readyPlaybackKey,
  audioTail,
  lastTransitionPreview,
  playing,
  requestedSourceTime,
  transitionPreview
}: PreviewHandoffInputs): PreviewHandoffState {
  const mainShowsTransition = Boolean(transitionPreview &&
    position?.segmentIndex === transitionPreview.active.previousSegmentIndex + 1)
  const waitingForSwitchedFrame = readyPlaybackKey !== '' && readyPlaybackKey !== playbackKey
  const incomingAudioTail = audioTail?.kind === 'incoming' && audioTail.key === playbackKey ? audioTail : null
  const pendingIncomingPreview = !transitionPreview && waitingForSwitchedFrame &&
    lastTransitionPreview?.key === playbackKey
    ? { ...lastTransitionPreview.preview, currentSourceTime: requestedSourceTime }
    : null
  const incomingAudioPreview = transitionPreview ?? pendingIncomingPreview ?? incomingAudioTail?.preview ?? null
  const incomingRenderPreview = pendingIncomingPreview
    ? { ...pendingIncomingPreview, styles: { current: {}, previous: {} } }
    : incomingAudioPreview
  const secondaryWaiting = waitingForSwitchedFrame && !pendingIncomingPreview
  const activeAudioTail = playing && audioTail?.kind === 'secondary' && audioTail.key === playbackKey ? audioTail : null
  const secondary = activeAudioTail ?? secondaryPreviewMedia(session, position, secondaryWaiting, requestedSourceTime)
  const incomingTransition = incomingTransitionMedia(session, position)
  const incomingTransitionFallback = transitionPreview && (!mainShowsTransition || readyPlaybackKey !== playbackKey)
    ? transitionPreview
    : null
  const mainTransition = mainShowsTransition ? transitionPreview : null
  const incomingAudioFallback = Boolean(incomingTransitionFallback ?? pendingIncomingPreview)
  const fallbackAudio = secondaryWaiting && !transitionPreview && !pendingIncomingPreview
  const fallbackClock = fallbackAudio ? 'secondary' : incomingAudioFallback ? 'incoming' : null
  return {
    waitingForSwitchedFrame,
    secondary,
    incomingTransition,
    incomingRenderPreview,
    incomingAudioFallback,
    fallbackAudio,
    audibleFallback: fallbackAudio || incomingAudioFallback,
    primaryHidden: Boolean(incomingTransitionFallback ?? waitingForSwitchedFrame),
    mainTransition,
    clockPreview: incomingTransitionFallback ?? pendingIncomingPreview,
    fallbackClock
  }
}

export function updateIncomingTransitionPlayhead({
  session,
  position,
  transitionPreview,
  clockPreview,
  mediaTime,
  path,
  mediaTimeOffsets,
  rememberOffset,
  onPlayhead
}: IncomingTransitionPlayheadInput): void {
  // A rendered incoming preview may be a draining tail; without the active clock handoff it cannot own a next-segment offset.
  if (transitionPreview && !clockPreview) return
  const segmentIndex = clockPreview
    ? clockPreview.active.previousSegmentIndex + 1
    : (position?.segmentIndex ?? -1) + 1
  const segment = session.segments[segmentIndex]
  const source = segment ? sourceForSegment(session, segment) : null
  if (!segment || source?.playbackPath !== path) return
  let offset = mediaTimeOffsets.get(segment.id)
  if (offset === undefined) {
    const requestedTime = clockPreview?.currentSourceTime ?? segmentSourceStart(segment)
    offset = Math.max(0, mediaTime - requestedTime)
    rememberOffset(segment.id, offset)
  }
  if (!clockPreview) return
  onPlayhead(outputTimeForSource(session.segments, segmentIndex, mediaTime - offset))
}
