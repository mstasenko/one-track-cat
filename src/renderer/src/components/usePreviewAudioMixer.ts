import { useCallback, useEffect, useMemo, useRef } from 'react'
import { previewMediaVolume } from './preview-media'

interface RoutedMedia {
  source: MediaElementAudioSourceNode
  gain: GainNode
  gate?: AudioWorkletNode
  targetGain?: number
  rampStart?: number
  rampStartGain?: number
  rampEnd?: number
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
  route.gate?.disconnect()
  route.gain.disconnect()
  routes.delete(media)
}

function connectMedia(
  media: HTMLMediaElement,
  context: AudioContext,
  limiter: DynamicsCompressorNode,
  sources: WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>,
  routes: Map<HTMLMediaElement, RoutedMedia>
): RoutedMedia {
  const source = sources.get(media) ?? context.createMediaElementSource(media)
  sources.set(media, source)
  const gain = context.createGain()
  // A newly registered decoder must stay silent until its owner schedules a fade-in.
  gain.gain.value = 0
  gain.connect(limiter)
  media.volume = 1
  const route = { source, gain }
  routes.set(media, route)
  return route
}

function connectStartupGate(context: AudioContext, route: RoutedMedia): void {
  if (typeof AudioWorkletNode !== 'function') throw new Error('AudioWorkletNode is unavailable')
  const gate = new AudioWorkletNode(context, 'otc-preview-startup', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: 'explicit',
    outputChannelCount: [2]
  })
  try {
    route.source.connect(gate)
    gate.connect(route.gain)
    route.gate = gate
  } catch (error) {
    route.source.disconnect()
    gate.disconnect()
    throw error
  }
}

function routedGainAt(route: RoutedMedia, time: number, fallback: number): number {
  const { targetGain, rampStart, rampStartGain, rampEnd } = route
  if (targetGain === undefined || rampStart === undefined || rampStartGain === undefined || rampEnd === undefined) {
    return fallback
  }
  if (time <= rampStart) return rampStartGain
  if (time >= rampEnd) return targetGain
  return rampStartGain + (targetGain - rampStartGain) * ((time - rampStart) / (rampEnd - rampStart))
}

export function usePreviewAudioMixer(): PreviewAudioMixer {
  const contextRef = useRef<AudioContext | null>(null)
  const limiterRef = useRef<DynamicsCompressorNode | null>(null)
  const sourcesRef = useRef(new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>())
  const routesRef = useRef(new Map<HTMLMediaElement, RoutedMedia>())
  const failedRef = useRef(false)
  const disposalRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startupWorkletRef = useRef<Promise<boolean> | null>(null)

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

  const ensureStartupWorklet = useCallback((context: AudioContext): Promise<boolean> => {
    if (startupWorkletRef.current) return startupWorkletRef.current
    startupWorkletRef.current = (async () => {
      try {
        const audioWorklet = (context as unknown as { audioWorklet?: AudioWorklet }).audioWorklet
        if (!audioWorklet) throw new Error('AudioWorklet is unavailable')
        await audioWorklet.addModule(new URL('./preview-audio-worklet.js?no-inline', import.meta.url).href)
        return true
      } catch (error) {
        console.error('Preview audio startup gate failed to load; using direct audio routing.', error)
        return false
      }
    })()
    return startupWorkletRef.current
  }, [])

  const register = useCallback((media: HTMLMediaElement): (() => void) => {
    if (routesRef.current.has(media)) return () => undefined
    const context = ensureContext()
    const limiter = limiterRef.current
    if (!context || !limiter) return () => undefined
    try {
      const route = connectMedia(media, context, limiter, sourcesRef.current, routesRef.current)
      void ensureStartupWorklet(context).then((useStartupGate) => {
        if (routesRef.current.get(media) !== route) return
        try {
          if (useStartupGate) connectStartupGate(context, route)
          else route.source.connect(route.gain)
        } catch (error) {
          console.error('Preview audio startup gate failed; using direct audio routing.', error)
          if (routesRef.current.get(media) === route) {
            try { route.source.connect(route.gain) } catch (fallbackError) {
              console.error('Preview audio direct routing also failed.', fallbackError)
            }
          }
        }
      })
      return () => disconnectMedia(media, routesRef.current)
    } catch {
      failedRef.current = true
      return () => undefined
    }
  }, [ensureContext, ensureStartupWorklet])

  const setGain = useCallback((media: HTMLMediaElement, gain: number, delay?: number, duration?: number): void => {
    const safeGain = Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1
    const safeDelay = Number.isFinite(delay) ? Math.max(0, delay ?? 0) : 0
    const safeDuration = Number.isFinite(duration) ? Math.max(0.001, duration ?? 0.02) : 0.02
    const route = routesRef.current.get(media)
    const context = contextRef.current
    if (!route || !context) {
      try { media.volume = previewMediaVolume(safeGain) } catch { /* native fallback stays usable */ }
      return
    }
    const parameter = route.gain.gain
    const now = context.currentTime
    const end = now + safeDelay + safeDuration
    // Handoff/path-change effects can ask to mute an already fading decoder.
    // Extending that fade lets its source end/seek while still audible.
    if (route.targetGain === safeGain && route.rampEnd !== undefined && route.rampEnd <= end) return
    // A steady-gain handoff needs a few render blocks for automation to arrive.
    // Reserve that lead inside the existing fade; active ramps and explicit cut
    // deadlines keep their timing, so a draining decoder is not retained longer.
    const holdTime = now + (delay === undefined && duration === undefined &&
      (route.rampEnd === undefined || route.rampEnd <= now) ? 0.01 : 0)
    // AudioParam.value may lag an active automation curve by a render quantum.
    // Every route ramp is created here, so evaluate its exact held value instead.
    const current = routedGainAt(route, holdTime, parameter.value)
    if (typeof parameter.cancelAndHoldAtTime === 'function') {
      parameter.cancelAndHoldAtTime(holdTime)
    } else {
      parameter.cancelScheduledValues(holdTime)
    }
    // Cancellation inserts no anchor once previous automation has finished.
    // Always start at the current value, or a new ramp can jump toward its target.
    parameter.setValueAtTime(current, holdTime)
    if (safeDelay > 0) parameter.setValueAtTime(current, holdTime + safeDelay)
    parameter.linearRampToValueAtTime(safeGain, end)
    route.targetGain = safeGain
    route.rampStart = holdTime + safeDelay
    route.rampStartGain = current
    route.rampEnd = end
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
        routes.forEach(({ source, gate, gain }) => {
          source.disconnect()
          gate?.disconnect()
          gain.disconnect()
        })
        routes.clear()
        limiterRef.current?.disconnect()
        const context = contextRef.current
        contextRef.current = null
        limiterRef.current = null
        startupWorkletRef.current = null
        if (context && context.state !== 'closed') void context.close().catch(() => undefined)
      }, 0)
    }
  }, [])

  return useMemo(() => ({ register, setGain, resume }), [register, resume, setGain])
}
