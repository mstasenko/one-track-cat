import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TransitionPreview } from '../model/transitions'
import type { PreviewAudioMixer } from './usePreviewAudioMixer'

export function OutgoingTransitionVideo({ preview, fit, className, playing = false, preloadPath = '', preloadTime = 0, preloadRate = 0, showFallback = false, audibleFallback = false, fallbackGain = 1, audioCutTime, mixer, mediaRef }: {
  preview: TransitionPreview | null
  fit: 'contain' | 'cover'
  className?: string
  playing?: boolean
  preloadPath?: string
  preloadTime?: number
  preloadRate?: number
  showFallback?: boolean
  audibleFallback?: boolean
  fallbackGain?: number
  audioCutTime?: number
  mixer?: PreviewAudioMixer
  mediaRef?: React.RefObject<HTMLVideoElement | null>
}): React.JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null)
  const path = preview?.previousPath ?? preloadPath
  const active = Boolean(preview) || showFallback
  const sourceTime = preview?.previousSourceTime ?? preloadTime
  const rate = preview?.previousPlaybackRate ?? preloadRate
  const [ready, setReady] = useState(false)
  const latestTime = useRef(sourceTime)
  const pendingSeekTime = useRef<number | null>(null)
  latestTime.current = sourceTime
  const markReady = (): void => {
    const video = videoRef.current
    const tolerance = playing ? 0.25 : 0.001
    const target = pendingSeekTime.current
    const matchesSeek = target === null || Boolean(video && Math.abs(video.currentTime - target) <= tolerance)
    const decoded = Boolean(video && !video.seeking && video.readyState >= 2 && matchesSeek)
    if (decoded) pendingSeekTime.current = null
    setReady(decoded)
  }

  useEffect(() => {
    const video = videoRef.current
    return video && mixer ? mixer.register(video) : undefined
  }, [mixer])

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
        const delay = (audioCutTime - video.currentTime) / rate - 0.01
        mixer.setGain(video, 0, delay, 0.01)
      } else mixer.setGain(video, fallbackGain)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [path, playing, rate, audibleFallback, fallbackGain, audioCutTime, mixer])

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
    if (video && !playing && video.readyState >= 1 && Math.abs(video.currentTime - sourceTime) > 0.001) {
      setReady(false)
      pendingSeekTime.current = sourceTime
      video.currentTime = sourceTime
    }
  }, [playing, sourceTime])

  if (!path) return null
  return (
    <video
      ref={(video) => { videoRef.current = video; if (mediaRef) mediaRef.current = video }}
      className={className}
      crossOrigin="anonymous"
      src={path}
      style={{ objectFit: fit, ...preview?.styles.previous, visibility: active && ready ? 'visible' : 'hidden' }}
      onLoadedData={markReady}
      onSeeked={markReady}
      muted={!mixer}
      preload="auto"
      playsInline
      aria-label="Outgoing transition video"
    />
  )
}
