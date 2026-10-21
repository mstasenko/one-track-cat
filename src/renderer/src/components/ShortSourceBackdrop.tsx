import { useCallback, useEffect, useRef } from 'react'
import type { EditSession } from '@shared/types'
import { segmentPlaybackRate } from '../model/timeline'
import { transitionPreviewAtOutputTime } from '../model/transitions'
import { OutgoingTransitionVideo } from './TransitionPreview'
import { previewContext, previewSeekTime, previewSourceFps } from './preview-context'

/** The rendered Short contains only its crop; retain silent source footage around it. */
export function ShortSourceBackdrop({ session, playing }: { session: EditSession; playing: boolean }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const { position, playbackPath, freeze } = previewContext(session)
  const sourceTime = position ? previewSeekTime(position, playing, previewSourceFps(session, position)) : 0
  const rate = position ? segmentPlaybackRate(position.segment) : 1
  const transition = transitionPreviewAtOutputTime(session, session.playhead)
  const sync = useCallback((video: HTMLVideoElement): void => {
    video.playbackRate = rate
    if (Math.abs(video.currentTime - sourceTime) > (playing ? 0.16 : 0.0005)) video.currentTime = sourceTime
    if (playing && !freeze) {
      if (video.paused) void video.play().catch(() => undefined)
    } else video.pause()
  }, [rate, sourceTime, playing, freeze])
  useEffect(() => {
    const video = videoRef.current
    if (video && video.readyState >= 1) sync(video)
    // The rendered preview owns the clock; this silent backdrop follows it.
  }, [playbackPath, sync])

  return <div className="camera-layer">
    <OutgoingTransitionVideo preview={transition} fit="contain" playing={playing} className="preview-source-video preview-transition-previous" />
    <video
      ref={videoRef}
      className="preview-source-video preview-short-backdrop"
      src={playbackPath || undefined}
      muted
      playsInline
      preload="auto"
      style={{ objectFit: 'contain', ...transition?.styles.current }}
      onLoadedMetadata={(event) => sync(event.currentTarget)}
    />
  </div>
}
