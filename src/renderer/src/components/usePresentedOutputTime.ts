import { useEffect, useState } from 'react'
import type { EditSession } from '@shared/types'
import { isFreezeSegment, outputTimeForSource } from '../model/timeline'

interface PresentedFrame {
  segmentId: string
  outputTime: number
}

export function usePresentedOutputTime(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  session: EditSession,
  segmentIndex: number,
  playing: boolean,
  mediaKey: string
): number {
  const [frame, setFrame] = useState<PresentedFrame | null>(null)
  const segment = session.segments[segmentIndex]

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playing || !segment || isFreezeSegment(segment)) {
      setFrame(null)
      return
    }
    let callbackId = 0
    let fallbackTimer: number | undefined
    let active = true
    const fps = Math.max(1, session.canvas.fps)
    const frameInterval = 1000 / fps
    // Headless or background rendering can stall RVFC while timeupdate remains coarse.
    const watchdogDelay = Math.max(100, frameInterval * 2)
    const clearFallbackTimer = (): void => {
      if (fallbackTimer === undefined) return
      window.clearTimeout(fallbackTimer)
      fallbackTimer = undefined
    }
    const publish = (sourceTime: number): void => {
      if (!active) return
      setFrame({
        segmentId: segment.id,
        outputTime: outputTimeForSource(session.segments, segmentIndex, sourceTime)
      })
    }
    const scheduleFallback = (delay: number): void => {
      clearFallbackTimer()
      fallbackTimer = window.setTimeout(() => {
        if (!active) return
        publish(video.currentTime)
        scheduleFallback(frameInterval)
      }, delay)
    }
    const update = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      if (!active) return
      clearFallbackTimer()
      publish(metadata.mediaTime)
      callbackId = video.requestVideoFrameCallback(update)
      scheduleFallback(watchdogDelay)
    }
    callbackId = video.requestVideoFrameCallback(update)
    scheduleFallback(watchdogDelay)
    return () => {
      active = false
      clearFallbackTimer()
      video.cancelVideoFrameCallback(callbackId)
    }
  }, [mediaKey, playing, segment, segmentIndex, session.canvas.fps, session.segments, videoRef])

  return playing && frame && frame.segmentId === segment?.id ? frame.outputTime : session.playhead
}
