import { useEffect, useRef } from 'react'
import type { EditSession, Overlay, ProjectCanvas, VisualOverlayBase } from '@shared/types'
import { overlayFit } from '@shared/overlay-fit'
import { overlayAtTime, overlaySourceTime } from '../model/timeline'
import { isAudioEnabledOverlay, overlayGainAtLocalTime } from '@shared/audio-envelope'
import { overlayNeedsResync } from './preview-media'
import type { PreviewAudioMixer } from './usePreviewAudioMixer'
import { useMediaUrl } from './useMediaUrl'
import { overlayAnimationStyle } from './overlay-animation'

interface PreviewOverlaysProps {
  session: EditSession
  playing: boolean
  outputTime: number
  stageRef: React.RefObject<HTMLDivElement | null>
  onSelect: (id: string | null) => void
  onChange: (id: string, patch: Partial<Overlay>) => void
  onGestureStart: () => void
  onGestureEnd: () => void
  onGestureCancel: () => void
  mixer: PreviewAudioMixer
}

function overlayPath(overlay: Overlay): string | undefined {
  if (overlay.type === 'text') return undefined
  return overlay.type === 'gif' ? overlay.playbackPath ?? overlay.path : overlay.path
}

function textStyle(overlay: Extract<Overlay, { type: 'text' }>): React.CSSProperties {
  return {
    color: overlay.color,
    fontFamily: overlay.fontFamily,
    fontSize: `${overlay.fontSize}cqh`,
    fontWeight: 700,
    textAlign: overlay.align,
    WebkitTextStroke: `${overlay.outlineWidth}px ${overlay.outlineColor}`,
    textShadow: overlay.shadow ? '0 4px 8px #000' : 'none'
  }
}

function syncOverlayMedia(
  media: HTMLMediaElement,
  overlay: Extract<Overlay, { type: 'video' | 'audio' | 'gif' }>,
  outputTime: number,
  playing: boolean
): void {
  const duration = usableMediaDuration(media.duration, overlay.duration)
  const expected = overlaySourceTime(overlay, outputTime)
  if (mediaNeedsSync(media.currentTime, expected, playing, previewMediaKind(overlay))) {
    media.currentTime = Math.min(expected, duration)
  }
  if (playing) void media.play().catch(() => undefined)
  else media.pause()
}

function usableMediaDuration(mediaDuration: number, fallback: number): number {
  if (!Number.isFinite(mediaDuration)) return fallback
  return mediaDuration > 0 ? mediaDuration : fallback
}

function previewMediaKind(overlay: Extract<Overlay, { type: 'video' | 'audio' | 'gif' }>): 'audio' | 'video-audio' | 'visual' {
  if (overlay.type === 'audio') return 'audio'
  if (overlay.type === 'video' && overlay.audioEnabled) return 'video-audio'
  return 'visual'
}

function mediaNeedsSync(current: number, expected: number, playing: boolean, kind: 'audio' | 'video-audio' | 'visual'): boolean {
  if (!playing && Math.abs(current - expected) > 0.0005) return true
  return overlayNeedsResync(current, expected, kind)
}

function TextContent({ overlay, outputTime }: {
  overlay: Extract<Overlay, { type: 'text' }>
  outputTime: number
}): React.JSX.Element {
  return <div className="preview-text-animation" style={overlayAnimationStyle(overlay, outputTime)}>
    <div className="preview-text" style={textStyle(overlay)}>{overlay.text}</div>
  </div>
}

function ImageContent({ overlay, outputTime }: { overlay: Extract<Overlay, { type: 'image' }>; outputTime: number }): React.JSX.Element {
  const url = useMediaUrl(overlayPath(overlay))
  return <img src={url} alt={overlay.name} draggable={false} style={overlayAnimationStyle(overlay, outputTime)} />
}

function MediaContent({ overlay, outputTime, playing, mixer, canvas }: {
  canvas: ProjectCanvas
  overlay: Extract<Overlay, { type: 'video' | 'audio' | 'gif' }>
  outputTime: number
  playing: boolean
  mixer: PreviewAudioMixer
}): React.JSX.Element {
  const url = useMediaUrl(overlayPath(overlay))
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null)
  const audible = isAudioEnabledOverlay(overlay)
  const gain = audible ? overlay.volume * overlayGainAtLocalTime(
    overlay.duration,
    overlay.fadeIn,
    overlay.fadeOut,
    outputTime - overlay.start
  ) : undefined

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    if (!audible) return
    return mixer.register(media)
  }, [audible, mixer, url])

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    syncOverlayMedia(media, overlay, outputTime, playing)
  }, [overlay, outputTime, playing, url])

  useEffect(() => {
    const media = mediaRef.current
    if (!media || gain === undefined) return
    mixer.setGain(media, gain)
  }, [audible, mixer, gain, url])

  const onLoadedMetadata = (event: React.SyntheticEvent<HTMLMediaElement>): void => {
    syncOverlayMedia(event.currentTarget, overlay, outputTime, playing)
  }

  if (overlay.type === 'audio') return <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} crossOrigin="anonymous" src={url} onLoadedMetadata={onLoadedMetadata} />
  return <video ref={mediaRef as React.RefObject<HTMLVideoElement>} crossOrigin="anonymous" src={url} style={{ objectFit: overlayFit(overlay, canvas), ...overlayAnimationStyle(overlay, outputTime) }} muted={overlay.type === 'gif' || !overlay.audioEnabled} loop={overlay.type === 'gif' || overlay.loop} playsInline onLoadedMetadata={onLoadedMetadata} />
}

function OverlayContent(props: {
  canvas: ProjectCanvas
  overlay: Overlay
  outputTime: number
  playing: boolean
  mixer: PreviewAudioMixer
}): React.JSX.Element {
  if (props.overlay.type === 'text') return <TextContent overlay={props.overlay} outputTime={props.outputTime} />
  if (props.overlay.type === 'image') return <ImageContent overlay={props.overlay} outputTime={props.outputTime} />
  return <MediaContent {...props} overlay={props.overlay} />
}

function VisualItem({ overlay, children, selected, props }: {
  overlay: VisualOverlayBase
  children: React.ReactNode
  selected: boolean
  props: PreviewOverlaysProps
}): React.JSX.Element {
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)
  const resize = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const onPointerMove = (event: React.PointerEvent): void => {
    const rectangle = props.stageRef.current?.getBoundingClientRect()
    if (!rectangle) return
    if (drag.current) props.onChange(overlay.id, {
      x: Math.max(0, Math.min(1 - overlay.width, drag.current.x + (event.clientX - drag.current.startX) / rectangle.width)),
      y: Math.max(0, Math.min(1 - overlay.height, drag.current.y + (event.clientY - drag.current.startY) / rectangle.height))
    } as Partial<Overlay>)
    if (resize.current) props.onChange(overlay.id, {
      width: Math.max(0.08, Math.min(1 - overlay.x, resize.current.width + (event.clientX - resize.current.x) / rectangle.width)),
      height: Math.max(0.08, Math.min(1 - overlay.y, resize.current.height + (event.clientY - resize.current.y) / rectangle.height))
    } as Partial<Overlay>)
  }
  return <div
    className={`visual-overlay ${selected ? 'selected' : ''}`}
    style={{ left: `${overlay.x * 100}%`, top: `${overlay.y * 100}%`, width: `${overlay.width * 100}%`, height: `${overlay.height * 100}%`, opacity: overlay.opacity, zIndex: overlay.zIndex }}
    onPointerDown={(event) => {
      props.onSelect(overlay.id)
      props.onGestureStart()
      drag.current = { x: overlay.x, y: overlay.y, startX: event.clientX, startY: event.clientY }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={onPointerMove}
    onPointerUp={(event) => {
      drag.current = null
      resize.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
      props.onGestureEnd()
    }}
    onPointerCancel={() => {
      drag.current = null
      resize.current = null
      props.onGestureCancel()
    }}
  >
    {children}
    {selected && <button className="resize-handle" aria-label="Resize overlay" onPointerDown={(event) => {
      event.stopPropagation()
      props.onGestureStart()
      resize.current = { x: event.clientX, y: event.clientY, width: overlay.width, height: overlay.height }
      event.currentTarget.parentElement?.setPointerCapture(event.pointerId)
    }} />}
  </div>
}

export function PreviewOverlays(props: PreviewOverlaysProps): React.JSX.Element {
  const overlays = props.session.overlays.filter((overlay) => overlayAtTime(overlay, props.outputTime))
  return <>{overlays.map((overlay) => overlay.type === 'audio'
    ? <OverlayContent key={overlay.id} canvas={props.session.canvas} overlay={overlay} outputTime={props.outputTime} playing={props.playing} mixer={props.mixer} />
    : <VisualItem key={overlay.id} overlay={overlay} selected={props.session.selectedOverlayId === overlay.id} props={props}>
        <OverlayContent canvas={props.session.canvas} overlay={overlay} outputTime={props.outputTime} playing={props.playing} mixer={props.mixer} />
      </VisualItem>)}</>
}
