import type { AnimationTiming, TextAnimationPreset } from '@shared/types'

export interface TextAnimationFrame {
  opacity: number
  scale: number
  translateX: number
  translateY: number
}

const MIN_DURATION = 0.001

const identityFrame = (): TextAnimationFrame => ({
  opacity: 1,
  scale: 1,
  translateX: 0,
  translateY: 0
})

function clampUnit(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function smoothstep(value: number): number {
  const clamped = clampUnit(value)
  return clamped * clamped * (3 - 2 * clamped)
}

function safeDuration(duration: number): number {
  return Number.isFinite(duration) ? Math.max(MIN_DURATION, duration) : MIN_DURATION
}

function safeLocalTime(localTime: number, duration: number): number {
  if (Number.isNaN(localTime) || localTime === Number.NEGATIVE_INFINITY) return 0
  if (localTime === Number.POSITIVE_INFINITY) return duration
  return Math.min(duration, Math.max(0, localTime))
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress
}

function fadeRamp(value: number | undefined, duration: number): number {
  if (value === undefined) return Math.min(0.22, duration / 2)
  return Math.min(duration, Math.max(0, Number.isNaN(value) ? 0 : value))
}

function motionWindow(value: number | undefined, fallback: number, duration: number): number {
  if (value === undefined) return fallback
  if (Number.isNaN(value) || value <= 0) return 0
  return Math.min(duration, value)
}

function fadeAtTime(localTime: number, duration: number, timing?: AnimationTiming): TextAnimationFrame {
  const fadeInRamp = fadeRamp(timing?.fadeIn, duration)
  const fadeOutRamp = fadeRamp(timing?.fadeOut, duration)
  const fadeIn = fadeInRamp > 0 ? smoothstep(localTime / fadeInRamp) : 1
  const fadeOut = fadeOutRamp > 0 ? smoothstep((duration - localTime) / fadeOutRamp) : 1
  return {
    opacity: Math.min(fadeIn, fadeOut),
    scale: 1,
    translateX: 0,
    translateY: 0
  }
}

function popAtTime(localTime: number, duration: number, timing?: AnimationTiming): TextAnimationFrame {
  const entrance = motionWindow(timing?.duration, Math.min(0.28, duration / 2), duration)
  if (entrance === 0 || localTime >= entrance) return identityFrame()

  const overshootDuration = entrance * 0.65
  const settleDuration = entrance - overshootDuration
  const overshootProgress = smoothstep(localTime / overshootDuration)
  const settleProgress = smoothstep((localTime - overshootDuration) / settleDuration)

  return {
    opacity: overshootProgress,
    scale: localTime <= overshootDuration
      ? interpolate(0.65, 1.12, overshootProgress)
      : interpolate(1.12, 1, settleProgress),
    translateX: 0,
    translateY: 0
  }
}

function bounceAtTime(localTime: number, duration: number, timing?: AnimationTiming): TextAnimationFrame {
  const entrance = motionWindow(timing?.duration, Math.min(0.38, duration / 2), duration)
  if (entrance === 0 || localTime >= entrance) return identityFrame()

  const overshootDuration = entrance * 0.6
  const settleDuration = entrance - overshootDuration
  const overshootProgress = smoothstep(localTime / overshootDuration)
  const settleProgress = smoothstep((localTime - overshootDuration) / settleDuration)

  if (localTime <= overshootDuration) {
    return {
      opacity: overshootProgress,
      scale: interpolate(0.92, 1.03, overshootProgress),
      translateX: 0,
      translateY: interpolate(0.2, -0.06, overshootProgress)
    }
  }

  return {
    opacity: 1,
    scale: interpolate(1.03, 1, settleProgress),
    translateX: 0,
    translateY: interpolate(-0.06, 0, settleProgress)
  }
}

function shakeAtTime(localTime: number, duration: number, timing?: AnimationTiming): TextAnimationFrame {
  const window = motionWindow(timing?.duration, Math.min(0.55, duration), duration)
  if (window === 0 || localTime >= window) return identityFrame()

  const progress = clampUnit(localTime / window)
  const amplitude = (1 - progress) ** 2
  return {
    opacity: 1,
    scale: 1,
    translateX: 0.025 * amplitude * Math.sin(9 * Math.PI * progress),
    translateY: 0.012 * amplitude * Math.sin(13 * Math.PI * progress)
  }
}

export function textAnimationAtTime(
  preset: TextAnimationPreset | undefined,
  localTime: number,
  duration: number,
  timing?: AnimationTiming
): TextAnimationFrame {
  const safeDurationValue = safeDuration(duration)
  const safeTime = safeLocalTime(localTime, safeDurationValue)

  switch (preset) {
    case 'fade':
      return fadeAtTime(safeTime, safeDurationValue, timing)
    case 'pop':
      return popAtTime(safeTime, safeDurationValue, timing)
    case 'bounce':
      return bounceAtTime(safeTime, safeDurationValue, timing)
    case 'shake':
      return shakeAtTime(safeTime, safeDurationValue, timing)
    case 'none':
    case undefined:
      return identityFrame()
  }
}
