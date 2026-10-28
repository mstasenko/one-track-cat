import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TransitionPreview } from '../model/transitions'
import type { PreviewAudioMixer } from './usePreviewAudioMixer'

interface TransitionVideoProps {
  preview: TransitionPreview | null
  fit: 'contain' | 'cover'
  objectPosition?: string
  className?: string
  playing?: boolean
  preloadPath?: string
  preloadTime?: number
  preloadRate?: number
  showFallback?: boolean
  audibleFallback?: boolean
  fallbackGain?: number
  audioCutTime?: number
  audioClockRef?: React.RefObject<HTMLVideoElement | null>
  mixer?: PreviewAudioMixer
  mediaRef?: React.RefObject<HTMLVideoElement | null>
  onPresentedTime?: (sourceTime: number, path: string) => void
}

function TransitionVideo({ side, preview, fit, objectPosition, className, playing = false, preloadPath = '', preloadTime = 0, preloadRate = 0, showFallback = false, audibleFallback = false, fallbackGain = 1, audioCutTime, audioClockRef, mixer, mediaRef, onPresentedTime }: TransitionVideoProps & {
  side: 'current' | 'previous'
}): React.JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null)
  const path = preview?.[`${side}Path`] ?? preloadPath
  const hasMedia = Boolean(path)
  const active = Boolean(preview) || showFallback
  const sourceTime = preview?.[`${side}SourceTime`] ?? preloadTime
  const rate = preview?.[`${side}PlaybackRate`] ?? preloadRate
  const [ready, setReady] = useState(false)
  const latestTime = useRef(sourceTime)
  const pendingSeekTime = useRef<number | null>(null)
  const onPresentedTimeRef = useRef(onPresentedTime)
  useLayoutEffect(() => {
    latestTime.current = sourceTime
    onPresentedTimeRef.current = onPresentedTime
  }, [sourceTime, onPresentedTime])
  const markReady = (): void => {
    const video = videoRef.current
    const tolerance = playing ? 0.25 : 0.001
    const target = pendingSeekTime.current
    const matchesSeek = target === null || Boolean(video && (playing && rate > 0
      ? video.currentTime >= target - tolerance
      : Math.abs(video.currentTime - target) <= tolerance))
    const decoded = Boolean(video && !video.seeking && video.readyState >= 2 && matchesSeek)
    if (decoded) pendingSeekTime.current = null
    setReady(decoded)
  }

  useEffect(() => {
    const video = videoRef.current
    return video && mixer ? mixer.register(video) : undefined
  }, [mixer, hasMedia])

  useLayoutEffect(() => {
    const video = videoRef.current
    return () => {
      if (video && !video.paused) video.pause()
    }
  }, [path])

  useEffect(() => {
    const video = videoRef.current
    if (video && mixer) mixer.setGain(video, 0)
  }, [mixer, path])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !mixer) return
    let cancelled = false
    if (!audibleFallback || !playing || rate <= 0) {
      mixer.setGain(video, 0)
      return
    }

    // A preloaded decoder can still take time to start. Begin its audio fade
    // only once playback starts, and ignore completion after the handoff changes.
    void video.play().then(() => {
      if (cancelled) return
      if (audioCutTime !== undefined) {
        // The primary decoder replaces both sources at the join. Finish the fade
        // before either decoder reaches it, including a late-starting fallback.
        const clockTime = Math.max(video.currentTime, audioClockRef?.current?.currentTime ?? video.currentTime)
        const delay = (audioCutTime - clockTime) / rate - 0.01
        mixer.setGain(video, 0, delay, 0.01)
      } else mixer.setGain(video, fallbackGain)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [path, playing, rate, audibleFallback, fallbackGain, audioCutTime, audioClockRef, mixer])

  useLayoutEffect(() => {
    const video = videoRef.current
    if (!video || !path) return
    const seek = (): void => {
      if (Math.abs(video.currentTime - latestTime.current) > (playing ? 0.25 : 0.001)) {
        setReady(false)
        pendingSeekTime.current = latestTime.current
        video.currentTime = latestTime.current
      } else {
        pendingSeekTime.current = null
        setReady(video.readyState >= 2)
      }
      if (playing && rate > 0) {
        video.playbackRate = rate
        void video.play().catch(() => undefined)
      } else video.pause()
    }
    if (video.readyState >= 1) seek()
    else {
      setReady(false)
      video.addEventListener('loadedmetadata', seek, { once: true })
      return () => video.removeEventListener('loadedmetadata', seek)
    }
  }, [path, playing, rate, active, preview?.active.previousSegmentIndex])

  useEffect(() => {
    const video = videoRef.current
    // Park inactive preloaders, but let a retained playing audio tail finish its
    // fade. Seeking that tail back to its captured handoff time makes it click.
    if (video && (!playing || (!active && rate <= 0)) && video.readyState >= 1 && Math.abs(video.currentTime - sourceTime) > 0.001) {
      setReady(false)
      pendingSeekTime.current = sourceTime
      video.currentTime = sourceTime
    }
  }, [active, playing, rate, sourceTime])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !path || !playing || !onPresentedTimeRef.current) return
    let callbackId = 0
    let activeCallback = true
    const publish = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      if (!activeCallback) return
      // Keep this callback armed during preload. Some recordings begin with a
      // non-zero media timestamp, which must be known before a short transition starts.
      onPresentedTimeRef.current?.(metadata.mediaTime, path)
      callbackId = video.requestVideoFrameCallback(publish)
    }
    callbackId = video.requestVideoFrameCallback(publish)
    return () => {
      activeCallback = false
      video.cancelVideoFrameCallback(callbackId)
    }
  }, [path, playing])

  if (!path) return null
  const transitionStyle = preview?.styles[side]
  return (
    <video
      ref={(video) => { videoRef.current = video; if (mediaRef) mediaRef.current = video }}
      className={className}
      crossOrigin="anonymous"
      src={path}
      style={{
        objectFit: fit,
        objectPosition,
        ...transitionStyle,
        visibility: !active || ready ? 'visible' : 'hidden',
        ...(!active ? { opacity: 0 } : {})
      }}
      data-transition={preview?.active.effect}
      onLoadedData={markReady}
      onCanPlay={markReady}
      onPlaying={markReady}
      onSeeked={markReady}
      onTimeUpdate={markReady}
      muted={!mixer}
      preload="auto"
      playsInline
      aria-label={`${side === 'current' ? 'Incoming' : 'Outgoing'} transition video`}
    />
  )
}

export function OutgoingTransitionVideo(props: TransitionVideoProps): React.JSX.Element | null {
  return <TransitionVideo side="previous" {...props} />
}

export function IncomingTransitionVideo(props: TransitionVideoProps): React.JSX.Element | null {
  return <TransitionVideo side="current" {...props} />
}
