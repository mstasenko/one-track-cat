import { useCallback, useEffect, useMemo, useRef } from 'react'
import { previewMediaVolume } from './preview-media'

interface RoutedMedia {
  source: MediaElementAudioSourceNode
  gain: GainNode
}

export interface PreviewAudioMixer {
  register: (media: HTMLMediaElement) => () => void
  setGain: (media: HTMLMediaElement, gain: number, delay?: number, duration?: number) => void
  resume: () => void
}

function disconnectMedia(media: HTMLMediaElement, routes: Map<HTMLMediaElement, RoutedMedia>): void {
  const route = routes.get(media)
  if (!route) return
  route.source.disconnect()
  route.gain.disconnect()
  routes.delete(media)
}

function connectMedia(
  media: HTMLMediaElement,
  context: AudioContext,
  limiter: DynamicsCompressorNode,
  sources: WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>,
  routes: Map<HTMLMediaElement, RoutedMedia>
): void {
  const source = sources.get(media) ?? context.createMediaElementSource(media)
  sources.set(media, source)
  const gain = context.createGain()
  source.connect(gain)
  gain.connect(limiter)
  media.volume = 1
  routes.set(media, { source, gain })
}

export function usePreviewAudioMixer(): PreviewAudioMixer {
  const contextRef = useRef<AudioContext | null>(null)
  const limiterRef = useRef<DynamicsCompressorNode | null>(null)
  const sourcesRef = useRef(new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>())
  const routesRef = useRef(new Map<HTMLMediaElement, RoutedMedia>())
  const failedRef = useRef(false)
  const disposalRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ensureContext = useCallback((): AudioContext | null => {
    if (contextRef.current) return contextRef.current
    if (failedRef.current) return null
    try {
      const context = new AudioContext()
      const limiter = context.createDynamicsCompressor()
      limiter.threshold.value = -2
      limiter.knee.value = 3
      limiter.ratio.value = 12
      limiter.attack.value = 0.003
      limiter.release.value = 0.1
      limiter.connect(context.destination)
      contextRef.current = context
      limiterRef.current = limiter
      return context
    } catch {
      failedRef.current = true
      return null
    }
  }, [])

  const register = useCallback((media: HTMLMediaElement): (() => void) => {
    if (routesRef.current.has(media)) return () => undefined
    const context = ensureContext()
    const limiter = limiterRef.current
    if (!context || !limiter) return () => undefined
    try {
      connectMedia(media, context, limiter, sourcesRef.current, routesRef.current)
      return () => disconnectMedia(media, routesRef.current)
    } catch {
      failedRef.current = true
      return () => undefined
    }
  }, [ensureContext])

  const setGain = useCallback((media: HTMLMediaElement, gain: number, delay = 0, duration = 0.02): void => {
    const safeGain = Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1
    const safeDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0
    const safeDuration = Number.isFinite(duration) ? Math.max(0.001, duration) : 0.02
    const route = routesRef.current.get(media)
    const context = contextRef.current
    if (!route || !context) {
      try { media.volume = previewMediaVolume(safeGain) } catch { /* native fallback stays usable */ }
      return
    }
    const parameter = route.gain.gain
    const now = context.currentTime
    const current = parameter.value
    if (typeof parameter.cancelAndHoldAtTime === 'function') {
      parameter.cancelAndHoldAtTime(now)
    } else {
      parameter.cancelScheduledValues(now)
    }
    // Cancellation inserts no anchor once previous automation has finished.
    // Always start at the current value, or a new ramp can jump toward its target.
    parameter.setValueAtTime(current, now)
    if (safeDelay > 0) parameter.setValueAtTime(current, now + safeDelay)
    parameter.linearRampToValueAtTime(safeGain, now + safeDelay + safeDuration)
  }, [])

  const resume = useCallback((): void => {
    const context = ensureContext()
    if (context?.state === 'suspended') void context.resume().catch(() => undefined)
  }, [ensureContext])

  useEffect(() => {
    const routes = routesRef.current
    if (disposalRef.current) clearTimeout(disposalRef.current)
    disposalRef.current = null
    return () => {
      // React development Strict Mode replays effects without replacing the media
      // element. Deferring disposal lets that immediate remount retain its context.
      disposalRef.current = setTimeout(() => {
        routes.forEach(({ source, gain }) => {
          source.disconnect()
          gain.disconnect()
        })
        routes.clear()
        limiterRef.current?.disconnect()
        const context = contextRef.current
        contextRef.current = null
        limiterRef.current = null
        if (context && context.state !== 'closed') void context.close().catch(() => undefined)
      }, 0)
    }
  }, [])

  return useMemo(() => ({ register, setGain, resume }), [register, resume, setGain])
}
