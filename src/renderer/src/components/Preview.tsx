import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EditSession, FocusZoomAmount, Overlay } from '@shared/types'
import {
  isFreezeSegment,
  outputTimeForSource,
  positionAtOutputTime,
  segmentPlaybackRate,
  segmentSourceStart,
  sourceForSegment,
  timelineDuration,
  type MarkSide
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
import { FocusZoomCircle } from './FocusZoomCircle'
import { IncomingTransitionVideo, OutgoingTransitionVideo } from './TransitionPreview'
import { mediaSource } from './preview-media'
import type { RenderedFacePreview } from '../model/use-face-preview'
import { videoRangeStyleAtTime } from '../model/video-range-transition'
import { isShortCanvas } from '@shared/short-frame'
import { previewContext, previewHandoff, previewSeekTime, previewSourceFps, shortFrameGuideRect, shortFrameGuideStyle, previewAudioCut, updateIncomingTransitionPlayhead, type AudioTail, type TransitionPreviewSnapshot } from './preview-context'
import { ShortSourceBackdrop } from './ShortSourceBackdrop'

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
  onClearMark: (side: MarkSide) => void
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

function focusCameraStyle(session: EditSession, outputTime: number): React.CSSProperties | undefined {
  const transform = focusCameraTransformAtTime(session.focusZooms, outputTime, shortFrameGuideRect(session, outputTime))
  return transform ? { transform, transformOrigin: 'top left' } : undefined
}

function handleStagePointer(event: React.PointerEvent<HTMLDivElement>, focus: FocusZoomAmount | null, props: PreviewProps, done: () => void): void {
  if (focus) {
    const guide = isShortCanvas(props.session.canvas)
      ? event.currentTarget.querySelector<HTMLElement>('.short-frame-guide')
      : null
    const rect = (guide ?? event.currentTarget).getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return
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
  mediaTimeOffset: number,
  total: number,
  onPlayhead: PreviewProps['onPlayhead'],
  onPlayingChange: PreviewProps['onPlayingChange']
): void {
  const segment = session.segments[activeSegment.current]
  if (!segment || isFreezeSegment(segment)) return
  const sourceTime = video.currentTime - mediaTimeOffset
  // Advancing 25 ms early cuts off the final audio fade before it can run.
  if (!video.ended && sourceTime < segment.sourceEnd - 0.0001) {
    onPlayhead(outputTimeForSource(session.segments, activeSegment.current, sourceTime))
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

function SourcePreview(props: SourcePreviewProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const secondaryVideoRef = useRef<HTMLVideoElement>(null)
  const incomingVideoRef = useRef<HTMLVideoElement>(null)
  const shortFrameRef = useRef<HTMLDivElement>(null)
  const [mediaFailure, setMediaFailure] = useState<{ path: string; message: string } | null>(null)
  const [readyPlaybackKey, setReadyPlaybackKey] = useState('')
  const [audioTail, setAudioTail] = useState<AudioTail | null>(null)
  const [lastTransitionPreview, setLastTransitionPreview] = useState<TransitionPreviewSnapshot | null>(null)
  const activeSegment = useRef(0)
  const seekingFromTimeline = useRef(false)
  const currentPlaybackRef = useRef({ key: '', readyKey: '', sourceKey: '', generation: 0 })
  const [mediaTimeOffsets, setMediaTimeOffsets] = useState(() => new Map<string, number>())
  const playingRef = useRef(props.playing)
  const onPlayheadRef = useRef(props.onPlayhead)
  const onPlayingChangeRef = useRef(props.onPlayingChange)
  useLayoutEffect(() => {
    playingRef.current = props.playing
    onPlayheadRef.current = props.onPlayhead
    onPlayingChangeRef.current = props.onPlayingChange
  }, [props.playing, props.onPlayhead, props.onPlayingChange])

  const { position, playbackPath, freeze: positionIsFreeze } = previewContext(props.session)
  const sourceKey = position ? `${position.segment.id}:${playbackPath}` : ''
  const [playback, setPlayback] = useState({ sourceKey, generation: 0 })
  if (playback.sourceKey !== sourceKey) {
    // Returning A→B→A is a new load, so old readiness and callbacks must not match.
    setPlayback({ sourceKey, generation: playback.generation + 1 })
  }
  const playbackKey = sourceKey ? `${sourceKey}:${playback.generation}` : ''
  const mediaTimeOffset = position ? mediaTimeOffsets.get(position.segment.id) ?? 0 : 0
  const mediaError = mediaFailure?.path === playbackPath ? mediaFailure.message : null
  useLayoutEffect(() => {
    currentPlaybackRef.current = { key: playbackKey, readyKey: readyPlaybackKey, sourceKey, generation: playback.generation }
  }, [playbackKey, readyPlaybackKey, sourceKey, playback.generation])
  const requestedSourceTime = position
    ? previewSeekTime(position, props.playing, previewSourceFps(props.session, position)) + mediaTimeOffset
    : 0
  const visualTime = usePresentedOutputTime(
    videoRef,
    props.session,
    position?.segmentIndex ?? 0,
    props.playing,
    playbackPath,
    mediaTimeOffset
  )
  const transitionPreview = transitionPreviewAtOutputTime(props.session, visualTime)
  const transitionSnapshotChanged = Boolean(transitionPreview && lastTransitionPreview?.key !== playbackKey)
  if (transitionSnapshotChanged && transitionPreview) setLastTransitionPreview({ key: playbackKey, preview: transitionPreview })
  else if (!transitionPreview && lastTransitionPreview && lastTransitionPreview.key !== playbackKey) setLastTransitionPreview(null)
  const handoff = previewHandoff({
    session: props.session, position, playbackKey, readyPlaybackKey, audioTail, lastTransitionPreview,
    playing: props.playing, requestedSourceTime, transitionPreview
  })
  const { waitingForSwitchedFrame, secondary, incomingTransition, incomingRenderPreview, incomingAudioFallback,
    fallbackAudio, audibleFallback, primaryHidden, mainTransition, clockPreview, fallbackClock } = handoff
  const rangeStyle = videoRangeStyleAtTime(props.session.videoTransitions ?? [], visualTime)
  const short = isShortCanvas(props.session.canvas)
  const shortFrameStyle = shortFrameGuideStyle(props.session, visualTime)
  const previewFit = short ? 'contain' : props.session.canvas.fit
  const previewGain = gameAudioGainAtOutputTime(props.session.overlays, visualTime)
  const currentSegment = position?.segment
  const { approachingAudioCut, audioCutTime } = previewAudioCut(props.session, position, visualTime, mediaTimeOffset)
  const circleProps = { effects: props.session.focusZooms, outputTime: visualTime, canvas: props.session.canvas }
  const updateFromIncomingTransition = (mediaTime: number, path: string): void => updateIncomingTransitionPlayhead({
    session: props.session, position, transitionPreview: incomingRenderPreview, clockPreview, mediaTime, path, mediaTimeOffsets,
    rememberOffset: (segmentId, offset) => setMediaTimeOffsets((previous) => new Map(previous).set(segmentId, offset)),
    onPlayhead: onPlayheadRef.current
  })
  const markReadyForKey = (key: string): void => {
    if (currentPlaybackRef.current.key !== key || currentPlaybackRef.current.readyKey === key) return
    // Do not drain the playing secondary fallback immediately before its next transition.
    if (playingRef.current && fallbackAudio && approachingAudioCut) return
    const transitionTail = lastTransitionPreview?.key === key ? lastTransitionPreview.preview : null
    const incoming = incomingVideoRef.current
    if (playingRef.current && transitionTail && incoming && !incoming.paused) {
      setAudioTail({ kind: 'incoming', key, path: transitionTail.currentPath, time: incoming.currentTime, rate: incoming.playbackRate, preview: transitionTail })
    }
    const fallback = secondaryVideoRef.current
    if (!transitionTail && playingRef.current && fallbackAudio && fallback && !fallback.paused) {
      // Keep the audible fallback source alive while its short mixer fade drains.
      setAudioTail({ kind: 'secondary', key, path: playbackPath, time: fallback.currentTime, rate: fallback.playbackRate })
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
  const markIncomingPresented = (video: HTMLVideoElement, allowClockFallback = false): void => {
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
      const fallback = fallbackClock === 'secondary'
        ? secondaryVideoRef.current
        : fallbackClock === 'incoming' ? incomingVideoRef.current : null
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
      // The decoded media clock is advancing here; do not compare it with
      // the handoff's captured seek target, which is already in the past.
      if (playingRef.current) markReadyForKey(handoffKey)
      else markIncomingReady(video)
    }
    if (allowClockFallback) {
      const frameAdvance = baseRate / Math.max(1, props.session.canvas.fps)
      const segmentStart = position ? segmentSourceStart(position.segment) + mediaTimeOffset : mediaTimeOffset
      if (video.currentTime < segmentStart + frameAdvance) return
      synchronize()
    } else video.requestVideoFrameCallback(synchronize)
  }
  const startIncomingWhenReady = (video: HTMLVideoElement): void => {
    markIncomingPresented(video)
    if (playingRef.current && !positionIsFreeze && video.readyState >= 4) {
      void video.play().catch(() => onPlayingChangeRef.current(false))
    }
  }
  useFreezePlayback(videoRef, position, props.session.playhead, props.playing, props.total, props.onPlayhead)
  useEffect(() => {
    const video = videoRef.current
    return video ? props.mixer.register(video) : undefined
  }, [props.mixer])
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // Finish the boundary fade before either decoder changes its source.
    if (!audibleFallback && props.playing && audioCutTime !== undefined && currentSegment && !isFreezeSegment(currentSegment)) {
      // Presented frames can lag the audio clock; schedule against the media clock.
      const delay = (audioCutTime - video.currentTime) / segmentPlaybackRate(currentSegment) - 0.01
      props.mixer.setGain(video, 0, delay, 0.01)
    } else {
      // A new decoder must start muted; its playing event starts the fade-in.
      // Starting the ramp during loading exposes its first sample at high gain.
      props.mixer.setGain(video, audibleFallback || video.readyState < 2 ? 0 : previewGain)
    }
  }, [audioCutTime, currentSegment, audibleFallback, playbackKey, previewGain, props.mixer, props.playing])
  useEffect(() => {
    if (!audioTail) return
    // Allow the 20 ms mixer fade plus audio scheduling slack before pausing or retargeting.
    const timeout = window.setTimeout(() => setAudioTail(null), 40)
    return () => window.clearTimeout(timeout)
  }, [audioTail])
  useEffect(() => { if (props.playing) props.mixer.resume() }, [props.mixer, props.playing])
  useEffect(() => {
    const video = videoRef.current
    const currentPosition = positionAtOutputTime(props.session.segments, props.session.playhead)
    if (!video || !currentPosition) return
    activeSegment.current = currentPosition.segmentIndex
    video.playbackRate = segmentPlaybackRate(currentPosition.segment)
    const sourceFps = previewSourceFps(props.session, currentPosition)
    const seekTime = previewSeekTime(currentPosition, props.playing, sourceFps) + mediaTimeOffset
    const seekTolerance = props.playing ? 0.16 : 0.0005
    if (Math.abs(video.currentTime - seekTime) > seekTolerance) {
      seekingFromTimeline.current = true
      video.currentTime = seekTime
    }
  }, [mediaTimeOffset, playbackPath, props.playing, props.session])
  useEffect(() => {
    const video = videoRef.current
    // timeupdate can arrive 250 ms late. Use the existing frame clock to leave
    // trimmed clips promptly, before the muted tail becomes an audible gap.
    if (!props.playing || !video || video.readyState < 2 || video.seeking || seekingFromTimeline.current ||
      !currentSegment || isFreezeSegment(currentSegment) || activeSegment.current !== position.segmentIndex ||
      video.currentTime - mediaTimeOffset < currentSegment.sourceEnd) return
    updatePlayback(video, props.session, activeSegment, mediaTimeOffset, props.total, onPlayheadRef.current, onPlayingChangeRef.current)
  }, [currentSegment, mediaTimeOffset, position?.segmentIndex, props.playing, props.session, props.total, visualTime])
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (props.playing && !positionIsFreeze && video.readyState >= 4) {
      void video.play().catch(() => onPlayingChangeRef.current(false))
    } else {
      video.pause()
    }
  }, [playbackPath, position?.segmentIndex, positionIsFreeze, props.playing])
  useEffect(() => {
    if (props.session.playhead >= props.total && props.playing) onPlayingChangeRef.current(false)
  }, [props.playing, props.session.playhead, props.total])

  const overlays = <PreviewOverlays
    session={props.session}
    playing={props.playing}
    outputTime={visualTime}
    stageRef={short ? shortFrameRef : props.stageRef}
    onSelect={props.onSelect}
    onChange={props.onOverlayChange}
    onGestureStart={props.onOverlayGestureStart}
    onGestureEnd={props.onOverlayGestureEnd}
    onGestureCancel={props.onOverlayGestureCancel}
    mixer={props.mixer}
  />

  return <>
    <div className="camera-layer" style={focusCameraStyle(props.session, visualTime)}>
      <OutgoingTransitionVideo
        preview={transitionPreview}
        playing={props.playing}
        preloadPath={secondary.path}
        preloadTime={secondary.time}
        preloadRate={secondary.rate}
        showFallback={fallbackAudio}
        audibleFallback={fallbackAudio}
        fallbackGain={previewGain}
        audioCutTime={audioCutTime}
        audioClockRef={videoRef}
        mixer={props.mixer}
        mediaRef={secondaryVideoRef}
        fit={previewFit}
        className="preview-source-video preview-transition-previous"
      />
      <div className="preview-transition-incoming-layer" style={{ opacity: Number(incomingAudioFallback) }}>
        <IncomingTransitionVideo
          preview={incomingRenderPreview}
          playing={props.playing}
          preloadPath={incomingTransition.path}
          preloadTime={incomingTransition.time}
          preloadRate={incomingTransition.rate}
          onPresentedTime={updateFromIncomingTransition}
          mixer={props.mixer} mediaRef={incomingVideoRef}
          audibleFallback={incomingAudioFallback}
          fallbackGain={previewGain}
          fit={previewFit}
          className="preview-transition-incoming"
        />
      </div>
      <video
        ref={videoRef}
        className="preview-source-video"
        crossOrigin="anonymous"
        src={mediaSource(playbackPath)}
        style={{
          objectFit: previewFit,
          ...rangeStyle,
          ...mainTransition?.styles.current,
          visibility: primaryHidden ? 'hidden' : 'visible'
        }}
        data-transition={mainTransition?.active.effect}
        preload="auto"
        playsInline
        onLoadedData={(event) => { setMediaFailure(null); startIncomingWhenReady(event.currentTarget) }}
        onCanPlay={(event) => startIncomingWhenReady(event.currentTarget)}
        onCanPlayThrough={(event) => startIncomingWhenReady(event.currentTarget)}
        onError={() => setMediaFailure({ path: playbackPath, message: 'This video cannot be shown. Try reopening it.' })}
        onSeeked={(event) => { seekingFromTimeline.current = false; startIncomingWhenReady(event.currentTarget) }}
        onPlaying={(event) => {
          if (playingRef.current && !audibleFallback && !approachingAudioCut) props.mixer.setGain(event.currentTarget, previewGain)
        }}
        onEnded={(event) => {
          if (playingRef.current && activeSegment.current === position?.segmentIndex) {
            updatePlayback(event.currentTarget, props.session, activeSegment, mediaTimeOffset, props.total, onPlayheadRef.current, onPlayingChangeRef.current)
          }
        }}
        onTimeUpdate={(event) => {
          if (!playingRef.current || seekingFromTimeline.current) return
          const video = event.currentTarget
          if (waitingForSwitchedFrame && !transitionPreview && !video.paused && video.readyState >= 2 && !video.seeking) {
            markIncomingPresented(video, true)
          }
          updatePlayback(video, props.session, activeSegment, mediaTimeOffset, props.total, onPlayheadRef.current, onPlayingChangeRef.current)
        }}
      />
      {!short && <FocusZoomCircle {...circleProps} />}
      {mediaError && <div className="preview-error" role="alert">{mediaError}</div>}
      {!short && overlays}
    </div>
    {short && shortFrameStyle && <div ref={shortFrameRef} className="short-frame-guide" style={shortFrameStyle}>
      <FocusZoomCircle {...circleProps} />
      {overlays}
    </div>}
  </>
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
  const short = isShortCanvas(props.session.canvas)
  const shortFrameStyle = shortFrameGuideStyle(props.session, props.session.playhead)
  const currentPosition = positionAtOutputTime(props.session.segments, props.session.playhead)
  const currentSource = currentPosition ? sourceForSegment(props.session, currentPosition.segment) : null
  const aspect = short && currentSource
    ? `${currentSource.metadata.width} / ${currentSource.metadata.height}`
    : `${props.session.canvas.width} / ${props.session.canvas.height}`
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
        className={`preview-stage ${short ? 'short-framing' : ''} ${props.focusPicking ? 'focus-picking' : ''}`}
        style={{ aspectRatio: aspect }}
        onPointerDown={(event) => handleStagePointer(event, props.focusPicking, props, props.onCancelFocusPick)}
      >
        {rendered
          ? (short && shortFrameStyle
              ? <div className="short-frame-guide short-frame-rendered" style={shortFrameStyle}><RenderedPreview
                  preview={rendered}
                  playhead={props.session.playhead}
                  playing={props.playing}
                  total={total}
                  fps={props.session.canvas.fps}
                  onPlayhead={props.onPlayhead}
                  onPlayingChange={props.onPlayingChange}
                /></div>
              : <RenderedPreview
                  preview={rendered}
                  playhead={props.session.playhead}
                  playing={props.playing}
                  total={total}
                  fps={props.session.canvas.fps}
                  onPlayhead={props.onPlayhead}
                  onPlayingChange={props.onPlayingChange}
                />)
          : <SourcePreview stageRef={stageRef} mixer={mixer} total={total} {...props} />}
        {rendered && short && <ShortSourceBackdrop session={props.session} playing={props.playing} />}
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
        onClearMark={props.onClearMark}
        onRemoveMarked={props.onRemoveMarked}
        onUndo={props.onUndo}
        onRedo={props.onRedo}
      />
    </section>
  )
}
