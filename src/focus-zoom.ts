import type { FocusZoomEffect } from './types'

export const focusZoomDefaultTransitionDuration = 0.5
export const focusZoomMinTransitionDuration = 0.05
export const focusZoomMaxTransitionDuration = 5

/** Return a valid transition length, capped so the in/out ramps cannot overlap. */
export function focusZoomTransitionDuration(effect: Pick<FocusZoomEffect, 'duration' | 'transitionDuration'>): number {
  const requested = typeof effect.transitionDuration === 'number' && Number.isFinite(effect.transitionDuration)
    ? effect.transitionDuration
    : focusZoomDefaultTransitionDuration
  const bounded = Math.min(
    focusZoomMaxTransitionDuration,
    Math.max(focusZoomMinTransitionDuration, requested)
  )
  return Math.min(bounded, Math.max(0, effect.duration) / 2)
}

export function smoothstep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped * clamped * (3 - 2 * clamped)
}

/** The FFmpeg equivalent of smoothstep, kept here beside the preview math. */
export function smoothstepExpression(value: string): string {
  const clamped = `min(1,max(0,${value}))`
  return `(${clamped})*(${clamped})*(3-2*(${clamped}))`
}

export function focusZoomAmountAtProgress(effect: Pick<FocusZoomEffect, 'duration' | 'transitionDuration'>, progress: number): number {
  if (!(effect.duration > 0)) return 1
  const ramp = focusZoomTransitionDuration(effect)
  if (!(ramp > 0)) return 1
  const normalized = Math.max(0, Math.min(1, progress))
  const ratio = ramp / effect.duration
  const easedIn = smoothstep(normalized / ratio)
  const easedOut = smoothstep((normalized - (1 - ratio)) / ratio)
  return easedIn * (1 - easedOut)
}
