import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditSession, Overlay, ProjectCanvas } from '@shared/types'
import { overlayFit } from '@shared/overlay-fit'
import {
  clamp,
  deletionRange,
  formatTime,
  isSourceTimedOverlay,
  isFreezeSegment,
  overlayAtTime,
  overlaySourceTime,
  positionAtOutputTime,
  sourceForSegment,
  segmentOutputDuration,
  timelineDuration
} from '../model/timeline'
import { transitionPreviewAtOutputTime } from '../model/transitions'
import { focusCameraTransformAtTime } from '../model/focus-zoom'
import { waveformPath } from '../model/waveform'
import { OutgoingTransitionVideo } from './TransitionPreview'
import { replayRanges } from '../model/replay'
import { effectiveFadeDurations, isAudioEnabledOverlay } from '@shared/audio-envelope'
import { useMediaUrl } from './useMediaUrl'
import { overlayAnimationStyle } from './overlay-animation'
import { videoRangeStyleAtTime } from '../model/video-range-transition'

interface TimelineProps {
  session: EditSession
  zoom: number
  onZoom: (zoom: number) => void
  onSeek: (time: number) => void
  onSelectOverlay: (id: string) => void
  selectedFaceBlurId: string | null
  onSelectFaceBlur: (id: string) => void
  onOverlayChange: (id: string, patch: Partial<Overlay>) => void
  onOverlayGestureStart: () => void
  onOverlayGestureEnd: () => void
  onOverlayGestureCancel: () => void
}

// Roughly one waveform point per two pixels, apportioned across cut segments.
const WAVEFORM_POINTS_PER_TIMELINE = 500

const colors: Record<Overlay['type'], string> = {
  text: '#a477ff', image: '#47c6ff', gif: '#ff66c4', video: '#ff9c46', audio: '#57d987'
}

function textOverlayTitle(overlay: Extract<Overlay, { type: 'text' }>): string {
  const animation = overlay.animation ?? 'none'
  return animation === 'none'
    ? overlay.name
    : `${overlay.name} · ${animation[0]?.toUpperCase()}${animation.slice(1)}`
}

function fadeTitle(overlay: Extract<Overlay, { type: 'audio' | 'video' }>): string | null {
  const fadeIn = overlay.fadeIn ?? 0
  const fadeOut = overlay.fadeOut ?? 0
  return fadeIn > 0 || fadeOut > 0 ? `Fade ${fadeIn}s / ${fadeOut}s` : null
}

function duckTitle(overlay: Extract<Overlay, { type: 'audio' | 'video' }>): string | null {
  if (!overlay.duckGameAudio) return null
  return `lowers game sound to ${Math.round((overlay.gameAudioLevel ?? 0.3) * 100)}%`
}

function overlayTitle(overlay: Overlay): string {
  if (overlay.type === 'text') return textOverlayTitle(overlay)
  if (!isAudioEnabledOverlay(overlay)) return overlay.name
  const details = [fadeTitle(overlay), duckTitle(overlay)].filter((detail): detail is string => detail !== null)
  return details.length > 0 ? `${overlay.name} · ${details.join(' · ')}` : overlay.name
}

function AudioTimelineFeedback({ overlay }: { overlay: Overlay }): React.JSX.Element | null {
  if (!isAudioEnabledOverlay(overlay)) return null
  const fades = effectiveFadeDurations(overlay.duration, overlay.fadeIn, overlay.fadeOut)
  const width = (fade: number): string => `${Math.min(35, fade / overlay.duration * 100)}%`
  return <>
    {fades.fadeIn > 0 && <span className="overlay-fade overlay-fade-in" style={{ width: width(fades.fadeIn) }} />}
    {fades.fadeOut > 0 && <span className="overlay-fade overlay-fade-out" style={{ width: width(fades.fadeOut) }} />}
    {overlay.duckGameAudio && <span className="game-sound-badge" aria-hidden="true">↓</span>}
  </>
}

function percentage(value: number, duration: number): number {
  return duration > 0 ? value / duration * 100 : 0
}

interface HoverPreview {
  outputTime: number
  sourceTime: number
  path: string
  name: string
  frameWidth: number
  frameHeight: number
  popupWidth: number
  popupHeight: number
  left: number
  top: number
}

function previewFrameSize(canvas: EditSession['canvas']): Pick<HoverPreview, 'frameWidth' | 'frameHeight' | 'popupWidth' | 'popupHeight'> {
  const scale = Math.min(186 / Math.max(1, canvas.width), 186 / Math.max(1, canvas.height))
  const frameWidth = Math.max(1, Math.round(canvas.width * scale))
  const frameHeight = Math.max(1, Math.round(canvas.height * scale))
  return { frameWidth, frameHeight, popupWidth: frameWidth + 12, popupHeight: frameHeight + 30 }
}

function previewPosition(event: React.PointerEvent, width: number, height: number): { left: number; top: number } {
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX + 14))
  const preferredTop = event.clientY > height + 8 ? event.clientY - height - 8 : event.clientY + 18
  const top = Math.max(8, Math.min(window.innerHeight - height - 8, preferredTop))
  return { left, top }
}

function isHoverPointer(event: React.PointerEvent): boolean {
  return event.pointerType === 'mouse' && event.buttons === 0
}

function previewSourceAtTime(session: EditSession, outputTime: number): {
  position: NonNullable<ReturnType<typeof positionAtOutputTime>>
  source: NonNullable<ReturnType<typeof sourceForSegment>>
} | null {
  const position = positionAtOutputTime(session.segments, outputTime)
  if (!position) return null
  const source = sourceForSegment(session, position.segment)
  return source?.playbackPath ? { position, source } : null
}

function overlayPath(overlay: Exclude<Overlay, { type: 'audio' }>): string {
  if (overlay.type === 'text') return ''
  return overlay.type === 'gif' ? overlay.playbackPath ?? overlay.path : overlay.path
}

function imageSource(overlay: Extract<Overlay, { type: 'image' }>, url: string): string {
  return overlay.renderedImageDataUrl ?? url
}

function overlayStyle(overlay: Exclude<Overlay, { type: 'audio' }>, frameHeight: number): React.CSSProperties {
  return {
    left: `${overlay.x * 100}%`,
    top: `${overlay.y * 100}%`,
    width: `${overlay.width * 100}%`,
    height: `${overlay.height * 100}%`,
    opacity: overlay.opacity,
    zIndex: overlay.zIndex,
    ...(overlay.type === 'text'
      ? {
          color: overlay.color,
          fontFamily: overlay.fontFamily,
          fontSize: `${Math.max(1, frameHeight * overlay.fontSize / 100)}px`,
          fontWeight: 700,
          lineHeight: 1.05,
          textAlign: overlay.align,
          WebkitTextStroke: `${overlay.outlineWidth * Math.max(1, frameHeight / 720)}px ${overlay.outlineColor}`,
          textShadow: overlay.shadow ? '0 2px 4px #000' : 'none'
        }
      : {})
  }
}

function useVideoSeek(
  mediaRef: React.RefObject<HTMLVideoElement | null>,
  sourceTime: number,
  sourceKey: string,
  enabled = true
): void {
  useEffect(() => {
    const media = mediaRef.current
    if (!media || !sourceKey || !enabled) return
    const seek = (): void => { media.currentTime = sourceTime }
    if (media.readyState >= 1) seek()
    else {
      media.addEventListener('loadedmetadata', seek, { once: true })
      return () => media.removeEventListener('loadedmetadata', seek)
    }
  }, [enabled, mediaRef, sourceKey, sourceTime])
}

function TimelineOverlay({ overlay, outputTime, frameHeight, canvas }: {
  canvas: ProjectCanvas
  overlay: Exclude<Overlay, { type: 'audio' }>
  outputTime: number
  frameHeight: number
}): React.JSX.Element {
  const mediaRef = useRef<HTMLVideoElement>(null)
  const url = useMediaUrl(overlayPath(overlay))
  const sourceTime = isSourceTimedOverlay(overlay) ? overlaySourceTime(overlay, outputTime) : 0
  useVideoSeek(mediaRef, sourceTime, url, isSourceTimedOverlay(overlay))

  const style = overlayStyle(overlay, frameHeight)
  if (overlay.type === 'text') {
    return <div className="timeline-hover-overlay" style={style} aria-label={overlay.name}>
      <div className="timeline-hover-text timeline-hover-text-animation" style={overlayAnimationStyle(overlay, outputTime)}>{overlay.text}</div>
    </div>
  }
  if (overlay.type === 'image') {
    return <div className="timeline-hover-overlay" style={style} aria-label={overlay.name}><img src={imageSource(overlay, url)} alt="" style={overlayAnimationStyle(overlay, outputTime)} /></div>
  }
  return (
    <div className="timeline-hover-overlay" style={style} aria-label={overlay.name}>
      <video ref={mediaRef} src={url} style={{ objectFit: overlayFit(overlay, canvas), ...overlayAnimationStyle(overlay, outputTime) }} muted playsInline preload="auto" />
    </div>
  )
}

function TimelineHoverFrame({ session, preview }: { session: EditSession; preview: HoverPreview }): React.JSX.Element {
  const previewVideo = useRef<HTMLVideoElement>(null)
  const transitionPreview = transitionPreviewAtOutputTime(session, preview.outputTime)
  const overlays = session.overlays
    .filter((overlay): overlay is Exclude<Overlay, { type: 'audio' }> => overlay.type !== 'audio' && overlayAtTime(overlay, preview.outputTime))
    .sort((left, right) => left.zIndex - right.zIndex)
  const focusTransform = focusCameraTransformAtTime(session.focusZooms, preview.outputTime)
  const rangeStyle = videoRangeStyleAtTime(session.videoTransitions ?? [], preview.outputTime)

  useVideoSeek(previewVideo, preview.sourceTime, preview.path)

  return (
    <div
      className="timeline-hover-frame"
      style={{ width: preview.frameWidth, height: preview.frameHeight }}
      aria-label={`Frame at ${formatTime(preview.outputTime, session.canvas.fps)}`}
    >
      <div className="timeline-hover-camera" style={{ transform: focusTransform }}>
        <OutgoingTransitionVideo preview={transitionPreview} fit={session.canvas.fit} />
        <video
          ref={previewVideo}
          src={preview.path}
          muted
          preload="auto"
          playsInline
          style={{ objectFit: session.canvas.fit, ...rangeStyle, ...transitionPreview?.styles.current }}
          data-transition={transitionPreview?.active.effect}
        />
      </div>
      {overlays.map((overlay) => <TimelineOverlay key={overlay.id} canvas={session.canvas} overlay={overlay} outputTime={preview.outputTime} frameHeight={preview.frameHeight} />)}
    </div>
  )
}

function segmentTitle(segment: EditSession['segments'][number], name: string): string {
  const replay = segment.replayGroupId ? ' · Replay ½×' : ''
  if (isFreezeSegment(segment) || !segment.transition) return `${name}${replay}`
  return `${name}${replay} · ${segment.transition.effect} ${segment.transition.duration}s`
}

function speedLabel(speed: import('@shared/types').VideoSpeed | undefined): string | null {
  if (!speed || speed === 1) return null
  return speed === 0.25 ? '¼×' : speed === 0.5 ? '½×' : `${speed}×`
}

function TimelineSegmentVisual({ session, segment, sampleCount }: { session: EditSession; segment: EditSession['segments'][number]; sampleCount: number }): React.JSX.Element {
  const source = sourceForSegment(session, segment)
  const path = useMemo(() => isFreezeSegment(segment) ? '' : waveformPath(
    source?.waveform ?? [], segment.sourceStart, segment.sourceEnd, source?.metadata.duration ?? 0, sampleCount
  ), [sampleCount, segment, source])
  return isFreezeSegment(segment)
    ? <span className="freeze-badge">❄ {segment.duration}s</span>
    : <svg className="waveform" viewBox="0 0 100 40" preserveAspectRatio="none" aria-label="Audio waveform"><path d={path} /></svg>
}

function SpeedBadge({ segment }: { segment: EditSession['segments'][number] }): React.JSX.Element | null {
  const speed = speedLabel(isFreezeSegment(segment) ? undefined : segment.playbackRate)
  return speed ? <span className="speed-badge">{speed}</span> : null
}

function TimelineSegmentContent({ session, segment, sampleCount }: { session: EditSession; segment: EditSession['segments'][number]; sampleCount: number }): React.JSX.Element {
  return <><TimelineSegmentVisual session={session} segment={segment} sampleCount={sampleCount} /><SpeedBadge segment={segment} /></>
}

function TimelineVideoSegment({ session, segment, duration, zoom }: { session: EditSession; segment: EditSession['segments'][number]; duration: number; zoom: number }): React.JSX.Element {
  const source = sourceForSegment(session, segment)
  const sampleCount = Math.max(2, Math.ceil(WAVEFORM_POINTS_PER_TIMELINE * zoom * segmentOutputDuration(segment) / duration))
  return <div
    className={`source-segment ${isFreezeSegment(segment) ? 'freeze-segment' : ''}`}
    data-transition={isFreezeSegment(segment) ? undefined : segment.transition?.effect}
    style={{ width: `${(segmentOutputDuration(segment) / duration) * 100}%` }}
    title={segmentTitle(segment, source?.metadata.name ?? 'Video')}
  >
    <TimelineSegmentContent session={session} segment={segment} sampleCount={sampleCount} />
  </div>
}

export function Timeline({
  session, zoom, onZoom, onSeek, onSelectOverlay, selectedFaceBlurId, onSelectFaceBlur, onOverlayChange,
  onOverlayGestureStart, onOverlayGestureEnd, onOverlayGestureCancel
}: TimelineProps): React.JSX.Element {
  const duration = timelineDuration(session.segments)
  const width = Math.max(100, zoom * 100)
  const selection = deletionRange(session)
  const marks = session.marks
  const replays = replayRanges(session.segments)
  const [hoverPreview, setHoverPreview] = useState<HoverPreview | null>(null)

  const pointerToTime = (event: React.PointerEvent<HTMLDivElement>): number => {
    const rectangle = event.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(duration, ((event.clientX - rectangle.left) / rectangle.width) * duration))
  }

  const updateHoverPreview = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!isHoverPointer(event)) {
      setHoverPreview(null)
      return
    }
    const outputTime = pointerToTime(event)
    const target = previewSourceAtTime(session, outputTime)
    if (!target) {
      setHoverPreview(null)
      return
    }
    const { position, source } = target
    const size = previewFrameSize(session.canvas)
    setHoverPreview({
      outputTime,
      sourceTime: position.sourceTime,
      path: source.playbackPath,
      name: source.metadata.name,
      ...size,
      ...previewPosition(event, size.popupWidth, size.popupHeight)
    })
  }

  return (
    <section className="timeline-shell" aria-label="Timeline">
      <div
        className="timeline-scroll"
        onWheel={(event) => {
          event.preventDefault()
          onZoom(clamp(zoom + (event.deltaY < 0 ? 0.25 : -0.25), 1, 8))
        }}
      >
        <div
          className="timeline"
          style={{ width: `${width}%` }}
          onPointerDown={(event) => onSeek(pointerToTime(event))}
          onPointerMove={updateHoverPreview}
          onPointerLeave={() => setHoverPreview(null)}
        >
          <div className="video-track">
            {session.segments.map((segment) => <TimelineVideoSegment key={segment.id} session={session} segment={segment} duration={duration} zoom={zoom} />)}
            {session.focusZooms.map((effect) => <div key={effect.id} className="focus-zoom-range" style={{ left: `${percentage(effect.start, duration)}%`, width: `${percentage(effect.duration, duration)}%` }}><span>{effect.zoom}×</span></div>)}
            {(session.videoTransitions ?? []).map((effect) => <div key={effect.id} className="video-transition-range" style={{ left: `${percentage(effect.start, duration)}%`, width: `${percentage(effect.duration, duration)}%` }}><span>Transition</span></div>)}
            {(session.faceBlurs ?? []).map((effect) => (
              <button
                type="button"
                key={effect.id}
                className={`face-blur-range ${selectedFaceBlurId === effect.id ? 'selected' : ''}`}
                style={{ left: `${percentage(effect.start, duration)}%`, width: `${percentage(effect.duration, duration)}%` }}
                title={`Face blur ${formatTime(effect.start, session.canvas.fps)} – ${formatTime(effect.start + effect.duration, session.canvas.fps)}`}
                aria-label={`Face blur from ${formatTime(effect.start, session.canvas.fps)} to ${formatTime(effect.start + effect.duration, session.canvas.fps)}`}
                aria-pressed={selectedFaceBlurId === effect.id}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onSelectFaceBlur(effect.id)}
              >
                <span>Face blur</span>
              </button>
            ))}
            {replays.map((replay) => <div key={`${replay.groupId}-${replay.start}`} className="replay-range" style={{ left: `${percentage(replay.start, duration)}%`, width: `${percentage(replay.duration, duration)}%` }}><span>Replay</span></div>)}
          </div>
          <div className="overlay-track">
            {session.overlays.map((overlay) => (
              <button
                key={overlay.id}
                className={`timeline-overlay ${session.selectedOverlayId === overlay.id ? 'selected' : ''}`}
                style={{
                  left: `${(overlay.start / duration) * 100}%`,
                  width: `${Math.max(0.5, (overlay.duration / duration) * 100)}%`,
                  backgroundColor: colors[overlay.type]
                }}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  onSelectOverlay(overlay.id)
                  const startX = event.clientX
                  const originalStart = overlay.start
                  const track = event.currentTarget.parentElement?.parentElement
                  if (!track) return
                  onOverlayGestureStart()
                  const rectangle = track.getBoundingClientRect()
                  const move = (moveEvent: PointerEvent): void => {
                    const delta = (moveEvent.clientX - startX) / rectangle.width * duration
                    onOverlayChange(overlay.id, { start: Math.max(0, Math.min(duration - overlay.duration, originalStart + delta)) })
                  }
                  const cleanup = (): void => {
                    window.removeEventListener('pointermove', move)
                    window.removeEventListener('pointerup', up)
                    window.removeEventListener('pointercancel', cancel)
                  }
                  const up = (): void => {
                    cleanup()
                    onOverlayGestureEnd()
                  }
                  const cancel = (): void => {
                    cleanup()
                    onOverlayGestureCancel()
                  }
                  window.addEventListener('pointermove', move)
                  window.addEventListener('pointerup', up)
                  window.addEventListener('pointercancel', cancel)
                }}
                title={overlayTitle(overlay)}
              >
                <AudioTimelineFeedback overlay={overlay} />
                {overlay.name}
              </button>
            ))}
          </div>
          {selection && (
            <div
              className="timeline-selection"
              style={{ left: `${percentage(selection[0], duration)}%`, width: `${percentage(selection[1] - selection[0], duration)}%` }}
            />
          )}
          {marks.map((mark, index) => (
            <div key={`${mark}-${index}`} className="timeline-mark" style={{ left: `${percentage(mark, duration)}%` }} />
          ))}
          <div className="playhead" style={{ left: `${percentage(session.playhead, duration)}%` }} />
        </div>
      </div>
      {hoverPreview && (
        <div
          className="timeline-hover-preview"
          style={{ left: hoverPreview.left, top: hoverPreview.top, width: hoverPreview.popupWidth, height: hoverPreview.popupHeight }}
          aria-label={`Preview of ${hoverPreview.name} at ${formatTime(hoverPreview.outputTime, session.canvas.fps)}`}
        >
          <TimelineHoverFrame session={session} preview={hoverPreview} />
          <span>{formatTime(hoverPreview.outputTime, session.canvas.fps)} · {hoverPreview.name}</span>
        </div>
      )}
    </section>
  )
}
