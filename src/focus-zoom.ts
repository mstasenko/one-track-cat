import type { FocusZoomEffect, ProjectCanvas } from './types'

export const focusZoomDefaultTransitionDuration = 0.5
export const focusZoomMinTransitionDuration = 0.05
export const focusZoomMaxTransitionDuration = 5

export interface FocusCircleGeometry {
  /** Output-space top-left of the circle. */
  x: number
  /** Output-space top-left y-coordinate of the circle. */
  y: number
  size: number
  borderWidth: number
}

function boundedTransitionDuration(effect: Pick<FocusZoomEffect, 'transitionDuration'>): number {
  const requested = typeof effect.transitionDuration === 'number' && Number.isFinite(effect.transitionDuration)
    ? effect.transitionDuration
    : focusZoomDefaultTransitionDuration
  return Math.min(focusZoomMaxTransitionDuration, Math.max(focusZoomMinTransitionDuration, requested))
}

/** Resolve the circular highlight and its outline width in canvas pixels. */
export function focusCircleGeometry(
  effect: Pick<FocusZoomEffect, 'focusX' | 'focusY' | 'zoom'>,
  canvas: Pick<ProjectCanvas, 'width' | 'height'>
): FocusCircleGeometry {
  const shortEdge = Math.min(canvas.width, canvas.height)
  // Preserve the existing 2× circle while higher factors highlight smaller areas.
  const size = shortEdge * 0.88 / effect.zoom
  const radius = size / 2
  const centerX = Math.max(radius, Math.min(canvas.width - radius, effect.focusX * canvas.width))
  const centerY = Math.max(radius, Math.min(canvas.height - radius, effect.focusY * canvas.height))
  return {
    x: centerX - radius,
    y: centerY - radius,
    size,
    borderWidth: Math.max(2, size * 0.025)
  }
}

/** Circle outline draw time; unlike frame zoom ramps it may span the full effect. */
export function circleDrawDuration(effect: Pick<FocusZoomEffect, 'duration' | 'transitionDuration'>): number {
  return Math.min(Math.max(0, effect.duration), boundedTransitionDuration(effect))
}

/** Return a valid transition length, capped so the in/out ramps cannot overlap. */
export function focusZoomTransitionDuration(effect: Pick<FocusZoomEffect, 'duration' | 'transitionDuration'>): number {
  return Math.min(boundedTransitionDuration(effect), Math.max(0, effect.duration) / 2)
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
