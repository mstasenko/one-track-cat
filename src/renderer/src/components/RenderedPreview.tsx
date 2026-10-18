import { useCallback, useEffect, useRef, useState } from 'react'
import type { RenderedFacePreview } from '../model/use-face-preview'

interface RenderedPreviewProps {
  preview: RenderedFacePreview
  playhead: number
  playing: boolean
  total: number
  fps?: number
  onPlayhead: (time: number) => void
  onPlayingChange: (playing: boolean) => void
}

const SEEK_TOLERANCE_PLAYING = 0.16
const SEEK_TOLERANCE_PAUSED = 0.0005
const RANGE_END_EPSILON = 0.001

function localTime(preview: RenderedFacePreview, playhead: number, playing: boolean, fps: number, total: number): number {
  const duration = Math.max(0, Math.min(preview.end, total) - preview.start)
  const target = Math.max(0, Math.min(duration, playhead - preview.start))
  if (playing || fps <= 0) return target
  return Math.min(duration, target + 0.5 / fps)
}

function isAtTimelineEnd(end: number, total: number): boolean {
  return end >= total - RANGE_END_EPSILON
}

function syncRenderedTime(
  video: HTMLVideoElement,
  preview: RenderedFacePreview,
  playhead: number,
  playing: boolean,
  fps: number,
  total: number,
  seeking: { current: boolean }
): void {
  const target = localTime(preview, playhead, playing, fps, total)
  const tolerance = playing ? SEEK_TOLERANCE_PLAYING : SEEK_TOLERANCE_PAUSED
  if (Math.abs(video.currentTime - target) <= tolerance) return
  seeking.current = true
  video.currentTime = target
}

export function RenderedPreview({
  preview,
  playhead,
  playing,
  total,
  fps = 30,
  onPlayhead,
  onPlayingChange
}: RenderedPreviewProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const seekingFromTimeline = useRef(false)
  const handedOff = useRef(false)
  const playingRef = useRef(playing)
  const onPlayheadRef = useRef(onPlayhead)
  const onPlayingChangeRef = useRef(onPlayingChange)
  const [mediaError, setMediaError] = useState<string | null>(null)
  playingRef.current = playing
  onPlayheadRef.current = onPlayhead
  onPlayingChangeRef.current = onPlayingChange

  useEffect(() => {
    handedOff.current = false
    seekingFromTimeline.current = false
    setMediaError(null)
  }, [preview.url, preview.start, preview.end])

  useEffect(() => {
    if (playhead < Math.min(preview.end, total) - RANGE_END_EPSILON) handedOff.current = false
  }, [playhead, preview.end, total])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = 1
    syncRenderedTime(video, preview, playhead, playing, fps, total, seekingFromTimeline)
  }, [fps, playhead, playing, preview, total])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (playing) {
      void video.play().catch(() => onPlayingChangeRef.current(false))
    } else {
      video.pause()
    }
  }, [playing, preview.url])

  const handoff = useCallback((): void => {
    if (handedOff.current) return
    handedOff.current = true
    onPlayheadRef.current(Math.min(preview.end, total))
    if (isAtTimelineEnd(preview.end, total)) onPlayingChangeRef.current(false)
    // Leave the media running for a range handoff. The parent switches to the
    // source preview after the playhead update, avoiding an audible pause.
  }, [preview.end, total])

  const publishTime = useCallback((video: HTMLVideoElement, mediaTime: number): void => {
    if (!playingRef.current || seekingFromTimeline.current || handedOff.current) return
    const rangeDuration = Math.max(0, Math.min(preview.end, total) - preview.start)
    const mediaDuration = Number.isFinite(video.duration) && video.duration > 0
      ? Math.min(rangeDuration, video.duration)
      : rangeDuration
    if (mediaTime >= mediaDuration - RANGE_END_EPSILON) {
      handoff()
      return
    }
    onPlayheadRef.current(Math.min(total, preview.end, preview.start + mediaTime))
  }, [handoff, preview.end, preview.start, total])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playing) return
    let active = true
    let callbackId: number | undefined
    let fallbackTimer: number | undefined
    const frameInterval = 1000 / Math.max(1, fps)
    const watchdogDelay = Math.max(100, frameInterval * 2)
    const clearFallback = (): void => {
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
      fallbackTimer = undefined
    }
    const scheduleFallback = (delay: number): void => {
      clearFallback()
      fallbackTimer = window.setTimeout(() => {
        if (!active) return
        publishTime(video, video.currentTime)
        scheduleFallback(frameInterval)
      }, delay)
    }
    const update = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      if (!active) return
      publishTime(video, metadata.mediaTime)
      callbackId = video.requestVideoFrameCallback(update)
      scheduleFallback(watchdogDelay)
    }
    if (typeof video.requestVideoFrameCallback === 'function') {
      callbackId = video.requestVideoFrameCallback(update)
      // Background and headless rendering can stall presented-frame callbacks.
      scheduleFallback(watchdogDelay)
    } else {
      scheduleFallback(frameInterval)
    }
    return () => {
      active = false
      clearFallback()
      if (callbackId !== undefined && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(callbackId)
      }
    }
  }, [fps, playing, preview.url, publishTime])

  return (
    <>
      <video
        ref={videoRef}
        className="preview-source-video preview-rendered-video"
        crossOrigin="anonymous"
        src={preview.url}
        preload="auto"
        playsInline
        onLoadedData={() => setMediaError(null)}
        onLoadedMetadata={(event) => syncRenderedTime(event.currentTarget, preview, playhead, playing, fps, total, seekingFromTimeline)}
        onError={() => setMediaError('This rendered face-blur preview cannot be shown. Try rendering it again.')}
        onSeeked={() => { seekingFromTimeline.current = false }}
        onEnded={() => {
          if (playingRef.current && !seekingFromTimeline.current) handoff()
        }}
      />
      {mediaError && <div className="preview-error" role="alert">{mediaError}</div>}
    </>
  )
}
