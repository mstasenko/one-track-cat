import { useEffect, useRef, useState } from 'react'
import type { EditSession, FocusZoomAmount, Overlay } from '@shared/types'
import {
  isFreezeSegment,
  outputTimeForSource,
  positionAtOutputTime,
  segmentOutputDuration,
  segmentPlaybackRate,
  segmentSourceStart,
  sourceForSegment,
  timelineDuration
} from '../model/timeline'
import { transitionPreviewAtOutputTime } from '../model/transitions'
import { focusCameraTransformAtTime } from '../model/focus-zoom'
import { Transport } from './Transport'
import { useFreezePlayback } from './useFreezePlayback'
import { PreviewOverlays } from './PreviewOverlays'
import { usePresentedOutputTime } from './usePresentedOutputTime'
import { gameAudioGainAtOutputTime } from '@shared/audio-envelope'
import { usePreviewAudioMixer, type PreviewAudioMixer } from './usePreviewAudioMixer'
import { RenderedPreview } from './RenderedPreview'
import { OutgoingTransitionVideo } from './TransitionPreview'
import { secondaryPreviewMedia } from './preview-media'
import type { RenderedFacePreview } from '../model/use-face-preview'
import { videoRangeStyleAtTime } from '../model/video-range-transition'

export interface PreviewProps {
  session: EditSession
  playing: boolean
  zoom: number
  canUndo: boolean
  canRedo: boolean
  onPlayingChange: (playing: boolean) => void
  onZoom: (zoom: number) => void
  onPlayhead: (time: number) => void
  onSelect: (id: string | null) => void
  onOverlayChange: (id: string, patch: Partial<Overlay>) => void
  onOverlayGestureStart: () => void
  onOverlayGestureEnd: () => void
  onOverlayGestureCancel: () => void
  onAddMark: () => void
  onClearMarks: () => void
  onRemoveMarked: () => void
  onUndo: () => void
  onRedo: () => void
  onStep: (direction: -1 | 1) => void
  focusPicking: FocusZoomAmount | null
  onFocusZoom: (zoom: FocusZoomAmount, x: number, y: number) => void
  onCancelFocusPick: () => void
  renderedPreview?: RenderedFacePreview | null
  renderedPreviews?: RenderedFacePreview[]
}

function previewContext(session: EditSession): { position: ReturnType<typeof positionAtOutputTime>; playbackPath: string; freeze: boolean } {
  const position = positionAtOutputTime(session.segments, session.playhead)
  if (!position) return { position, playbackPath: '', freeze: false }
  const source = sourceForSegment(session, position.segment)
  return { position, playbackPath: source?.playbackPath ?? '', freeze: isFreezeSegment(position.segment) }
}

function previewSeekTime(position: NonNullable<ReturnType<typeof positionAtOutputTime>>, playing: boolean, sourceFps: number): number {
  if (playing || isFreezeSegment(position.segment)) return position.sourceTime
  // Seek into the middle of the chosen source frame. Seeking exactly to its
  // timestamp can leave Chromium displaying the preceding decoded frame.
  const frameInset = sourceFps > 0 ? 0.5 / sourceFps : 0.0001
  return Math.min(position.sourceTime + frameInset, position.segment.sourceEnd)
}

function previewSourceFps(session: EditSession, position: NonNullable<ReturnType<typeof positionAtOutputTime>>): number {
  const source = sourceForSegment(session, position.segment)
  return source ? source.metadata.fps : 0
}

function focusCameraStyle(session: EditSession, outputTime: number): React.CSSProperties | undefined {
  const transform = focusCameraTransformAtTime(session.focusZooms, outputTime)
  return transform ? { transform, transformOrigin: 'top left' } : undefined
}

function handleStagePointer(event: React.PointerEvent<HTMLDivElement>, focus: FocusZoomAmount | null, props: PreviewProps, done: () => void): void {
  if (focus) {
    const rect = event.currentTarget.getBoundingClientRect()
    props.onFocusZoom(focus, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
    done()
    return
  }
  if (event.target === event.currentTarget) props.onSelect(null)
}

function updatePlayback(
  video: HTMLVideoElement,
  session: EditSession,
  activeSegment: React.RefObject<number>,
  total: number,
  onPlayhead: PreviewProps['onPlayhead'],
  onPlayingChange: PreviewProps['onPlayingChange']
): void {
  const segment = session.segments[activeSegment.current]
  if (!segment || isFreezeSegment(segment)) return
  // Advancing 25 ms early cuts off the final audio fade before it can run.
  if (!video.ended && video.currentTime < segment.sourceEnd - 0.0001) {
    onPlayhead(outputTimeForSource(session.segments, activeSegment.current, video.currentTime))
    return
  }
  const nextIndex = activeSegment.current + 1
  const next = session.segments[nextIndex]
  if (next) {
    activeSegment.current = nextIndex
    onPlayhead(outputTimeForSource(session.segments, nextIndex, segmentSourceStart(next)))
    return
  }
  onPlayhead(total)
  onPlayingChange(false)
}

interface SourcePreviewProps extends PreviewProps {
  stageRef: React.RefObject<HTMLDivElement | null>
  mixer: PreviewAudioMixer
  total: number
}

interface AudioTail {
  key: string
  path: string
  time: number
  rate: number
}

function SourcePreview(props: SourcePreviewProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const secondaryVideoRef = useRef<HTMLVideoElement>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [readyPlaybackKey, setReadyPlaybackKey] = useState('')
  const [audioTail, setAudioTail] = useState<AudioTail | null>(null)
  const activeSegment = useRef(0)
  const seekingFromTimeline = useRef(false)
  const currentPlaybackRef = useRef({ key: '', readyKey: '', sourceKey: '', generation: 0 })
  const playingRef = useRef(props.playing)
  const onPlayheadRef = useRef(props.onPlayhead)
  const onPlayingChangeRef = useRef(props.onPlayingChange)
  playingRef.current = props.playing
  onPlayheadRef.current = props.onPlayhead
  onPlayingChangeRef.current = props.onPlayingChange

  const { position, playbackPath, freeze: positionIsFreeze } = previewContext(props.session)
  const sourceKey = position ? `${position.segment.id}:${playbackPath}` : ''
  if (currentPlaybackRef.current.sourceKey !== sourceKey) {
    // Returning A→B→A is a new load, so old readiness and callbacks must not match.
    currentPlaybackRef.current.sourceKey = sourceKey
    currentPlaybackRef.current.generation += 1
    currentPlaybackRef.current.key = sourceKey
      ? `${sourceKey}:${currentPlaybackRef.current.generation}`
      : ''
  }
  const playbackKey = currentPlaybackRef.current.key
  currentPlaybackRef.current.readyKey = readyPlaybackKey
  const requestedSourceTime = position
    ? previewSeekTime(position, props.playing, previewSourceFps(props.session, position))
    : 0
  const visualTime = usePresentedOutputTime(
    videoRef,
    props.session,
    position?.segmentIndex ?? 0,
    props.playing,
    playbackPath
  )
  const transitionPreview = transitionPreviewAtOutputTime(props.session, visualTime)
  const nextSegment = position ? props.session.segments[position.segmentIndex + 1] : undefined
  const waitingForSwitchedFrame = readyPlaybackKey !== '' && readyPlaybackKey !== playbackKey
  const activeAudioTail = props.playing && audioTail?.key === playbackKey ? audioTail : null
  const secondary = activeAudioTail ?? secondaryPreviewMedia(props.session, position, waitingForSwitchedFrame, requestedSourceTime)
  const rangeStyle = videoRangeStyleAtTime(props.session.videoTransitions ?? [], visualTime)
  const fallbackAudio = waitingForSwitchedFrame && !transitionPreview
  const previewGain = gameAudioGainAtOutputTime(props.session.overlays, visualTime)
  const audioCutDelay = position && nextSegment
    ? position.outputStart + segmentOutputDuration(position.segment) - visualTime - 0.01
    : Number.POSITIVE_INFINITY
  const approachingAudioCut = audioCutDelay <= 0.1
  const currentSegment = position?.segment
  const audioCutTime = approachingAudioCut && currentSegment && !isFreezeSegment(currentSegment)
    ? currentSegment.sourceEnd : undefined
  const markReadyForKey = (key: string): void => {
    if (currentPlaybackRef.current.key !== key || currentPlaybackRef.current.readyKey === key) return
    const fallback = secondaryVideoRef.current
    if (playingRef.current && fallbackAudio && fallback && !fallback.paused) {
      // Keep the audible fallback source alive while its short mixer fade drains.
      setAudioTail({ key, path: playbackPath, time: fallback.currentTime, rate: fallback.playbackRate })
    }
    currentPlaybackRef.current.readyKey = key
    setReadyPlaybackKey(key)
  }
  const markIncomingReady = (video: HTMLVideoElement): void => {
    const tolerance = props.playing ? 0.16 : 0.0005
    if (!video.seeking && Math.abs(video.currentTime - requestedSourceTime) <= tolerance) {
      markReadyForKey(playbackKey)
    }
  }
  const markIncomingPresented = (video: HTMLVideoElement): void => {
    if (!waitingForSwitchedFrame || !props.playing) {
      // A paused seek may have presented its only frame before `seeked`; don't await RVFC.
      markIncomingReady(video)
      return
    }
    const baseRate = position && !isFreezeSegment(position.segment) ? segmentPlaybackRate(position.segment) : 1
    const frameTolerance = 1 / Math.max(1, props.session.canvas.fps)
    const handoffKey = playbackKey
    const synchronize = (): void => {
      const currentPlayback = currentPlaybackRef.current
      if (currentPlayback.key !== handoffKey || currentPlayback.readyKey === handoffKey ||
        video !== videoRef.current || !video.isConnected || video.seeking || video.readyState < 2) return
      const fallback = fallbackAudio ? secondaryVideoRef.current : null
      // Compare media clocks; RVFC mediaTime is a presented-frame timestamp, not the audio clock.
      const difference = fallback ? fallback.currentTime - video.currentTime : 0
      if (difference > frameTolerance) {
        video.playbackRate = Math.min(8, baseRate * 2)
        video.requestVideoFrameCallback(synchronize)
        return
      }
      if (difference < -frameTolerance && fallback) {
        seekingFromTimeline.current = true
        video.currentTime = fallback.currentTime
        return
      }
      video.playbackRate = baseRate
      // While playing, this callback already reports the current presented frame;
      // do not compare it with the handoff's captured seek time.
      if (playingRef.current) markReadyForKey(handoffKey)
      else markIncomingReady(video)
    }
    video.requestVideoFrameCallback(synchronize)
  }
  useFreezePlayback(videoRef, position, props.session.playhead, props.playing, props.total, props.onPlayhead)

  useEffect(() => {
    const video = videoRef.current
    return video ? props.mixer.register(video) : undefined
  }, [props.mixer])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // Silence the final 10 ms at a clip boundary so arbitrary source samples cannot click.
    if (!fallbackAudio && props.playing && approachingAudioCut && currentSegment && !isFreezeSegment(currentSegment)) {
      // Presented frames can lag the audio clock; schedule against the media clock.
      const delay = (currentSegment.sourceEnd - video.currentTime) / segmentPlaybackRate(currentSegment) - 0.01
      props.mixer.setGain(video, 0, delay, 0.01)
    } else {
      // A new decoder must start muted; its playing event starts the fade-in.
      // Starting the ramp during loading exposes its first sample at high gain.
      props.mixer.setGain(video, fallbackAudio || video.readyState < 2 ? 0 : previewGain)
    }
  }, [approachingAudioCut, currentSegment, fallbackAudio, playbackKey, previewGain, props.mixer, props.playing])

  useEffect(() => {
    if (!audioTail) return
    // Allow the 20 ms mixer fade plus audio scheduling slack before pausing or retargeting.
    const timeout = window.setTimeout(() => setAudioTail(null), 40)
    return () => window.clearTimeout(timeout)
  }, [audioTail])

  useEffect(() => { if (props.playing) props.mixer.resume() }, [props.mixer, props.playing])

  useEffect(() => setMediaError(null), [playbackPath])

  useEffect(() => {
    const video = videoRef.current
    const currentPosition = positionAtOutputTime(props.session.segments, props.session.playhead)
    if (!video || !currentPosition) return
    activeSegment.current = currentPosition.segmentIndex
    video.playbackRate = segmentPlaybackRate(currentPosition.segment)
    const sourceFps = previewSourceFps(props.session, currentPosition)
    const seekTime = previewSeekTime(currentPosition, props.playing, sourceFps)
    const seekTolerance = props.playing ? 0.16 : 0.0005
    if (Math.abs(video.currentTime - seekTime) > seekTolerance) {
      seekingFromTimeline.current = true
      video.currentTime = seekTime
    }
  }, [playbackPath, props.playing, props.session])

  useEffect(() => {
    const video = videoRef.current
    // timeupdate can arrive 250 ms late. Use the existing frame clock to leave
    // trimmed clips promptly, before the muted tail becomes an audible gap.
    if (!props.playing || !video || video.readyState < 2 || video.seeking || seekingFromTimeline.current ||
      !currentSegment || isFreezeSegment(currentSegment) || activeSegment.current !== position.segmentIndex ||
      video.currentTime < currentSegment.sourceEnd) return
    updatePlayback(video, props.session, activeSegment, props.total, onPlayheadRef.current, onPlayingChangeRef.current)
  }, [currentSegment, position?.segmentIndex, props.playing, props.session, props.total, visualTime])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (props.playing && !positionIsFreeze) {
      void video.play().catch(() => onPlayingChangeRef.current(false))
    } else {
      video.pause()
    }
  }, [playbackPath, position?.segmentIndex, positionIsFreeze, props.playing])

  useEffect(() => {
    if (props.session.playhead >= props.total && props.playing) onPlayingChangeRef.current(false)
  }, [props.playing, props.session.playhead, props.total])

  return (
    <div className="camera-layer" style={focusCameraStyle(props.session, visualTime)}>
      <OutgoingTransitionVideo
        preview={transitionPreview}
        playing={props.playing}
        preloadPath={secondary.path}
        preloadTime={secondary.time}
        preloadRate={secondary.rate}
        showFallback={waitingForSwitchedFrame}
        audibleFallback={fallbackAudio}
        fallbackGain={previewGain}
        audioCutTime={audioCutTime}
        mixer={props.mixer}
        mediaRef={secondaryVideoRef}
        fit={props.session.canvas.fit}
        className="preview-source-video preview-transition-previous"
      />
      <video
        ref={videoRef}
        className="preview-source-video"
        crossOrigin="anonymous"
        src={playbackPath}
        style={{
          objectFit: props.session.canvas.fit,
          ...rangeStyle,
          ...transitionPreview?.styles.current,
          visibility: (transitionPreview && readyPlaybackKey !== playbackKey) || waitingForSwitchedFrame ? 'hidden' : 'visible'
        }}
        data-transition={transitionPreview?.active.effect}
        preload="auto"
        playsInline
        onLoadedData={(event) => { setMediaError(null); markIncomingPresented(event.currentTarget) }}
        onError={() => setMediaError('This video cannot be shown. Try reopening it.')}
        onSeeked={(event) => { seekingFromTimeline.current = false; markIncomingPresented(event.currentTarget) }}
        onPlaying={(event) => {
          if (playingRef.current && !fallbackAudio && !approachingAudioCut) props.mixer.setGain(event.currentTarget, previewGain)
        }}
        onEnded={(event) => {
          if (playingRef.current && activeSegment.current === position?.segmentIndex) {
            updatePlayback(event.currentTarget, props.session, activeSegment, props.total, onPlayheadRef.current, onPlayingChangeRef.current)
          }
        }}
        onTimeUpdate={(event) => {
          if (!playingRef.current || seekingFromTimeline.current) return
          updatePlayback(event.currentTarget, props.session, activeSegment, props.total, onPlayheadRef.current, onPlayingChangeRef.current)
        }}
      />
      {mediaError && <div className="preview-error" role="alert">{mediaError}</div>}
      <PreviewOverlays
        session={props.session}
        playing={props.playing}
        outputTime={visualTime}
        stageRef={props.stageRef}
        onSelect={props.onSelect}
        onChange={props.onOverlayChange}
        onGestureStart={props.onOverlayGestureStart}
        onGestureEnd={props.onOverlayGestureEnd}
        onGestureCancel={props.onOverlayGestureCancel}
        mixer={props.mixer}
      />
    </div>
  )
}

function previewAtPlayhead(previews: RenderedFacePreview[], playhead: number, total: number): RenderedFacePreview | null {
  for (let index = previews.length - 1; index >= 0; index -= 1) {
    const preview = previews[index]
    if (!preview) continue
    const finalFrame = preview.end >= total - 0.001 && playhead >= total
    if (preview.end > preview.start && playhead >= preview.start && (playhead < preview.end || finalFrame)) return preview
  }
  return null
}

export function Preview(props: PreviewProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const mixer = usePreviewAudioMixer()
  const total = timelineDuration(props.session.segments)
  const previews = props.renderedPreviews ?? (props.renderedPreview ? [props.renderedPreview] : [])
  const rendered = previewAtPlayhead(previews, props.session.playhead, total)
  const focusPicking = props.focusPicking
  const onCancelFocusPick = props.onCancelFocusPick

  useEffect(() => {
    if (!focusPicking) return
    const cancel = (event: KeyboardEvent): void => { if (event.key === 'Escape') onCancelFocusPick() }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [focusPicking, onCancelFocusPick])

  return (
    <section className="preview-shell" aria-label="Video preview">
      <div
        ref={stageRef}
        className={`preview-stage ${props.focusPicking ? 'focus-picking' : ''}`}
        style={{ aspectRatio: `${props.session.canvas.width} / ${props.session.canvas.height}` }}
        onPointerDown={(event) => handleStagePointer(event, props.focusPicking, props, props.onCancelFocusPick)}
      >
        {rendered
          ? <RenderedPreview
              preview={rendered}
              playhead={props.session.playhead}
              playing={props.playing}
              total={total}
              fps={props.session.canvas.fps}
              onPlayhead={props.onPlayhead}
              onPlayingChange={props.onPlayingChange}
            />
          : <SourcePreview stageRef={stageRef} mixer={mixer} total={total} {...props} />}
        {props.focusPicking && <div className="focus-prompt">Click what to focus on<br /><small>Esc to cancel</small></div>}
      </div>
      <Transport
        session={props.session}
        total={total}
        playing={props.playing}
        zoom={props.zoom}
        canUndo={props.canUndo}
        canRedo={props.canRedo}
        onPlayingChange={props.onPlayingChange}
        onZoom={props.onZoom}
        onStep={props.onStep}
        onAddMark={props.onAddMark}
        onClearMarks={props.onClearMarks}
        onRemoveMarked={props.onRemoveMarked}
        onUndo={props.onUndo}
        onRedo={props.onRedo}
      />
    </section>
  )
}
