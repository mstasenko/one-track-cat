import type { EditSession, FocusZoomAmount, FocusZoomEffect, FocusZoomMode } from '@shared/types'
import { focusZoomAmountAtProgress, focusZoomDefaultTransitionDuration } from '@shared/focus-zoom'
import { clamp, makeId, timelineDuration } from './timeline'

export function focusCropAtTime(effect: FocusZoomEffect, outputTime: number): { zoom: number; left: number; top: number; width: number; height: number } {
  const progress = clamp((outputTime - effect.start) / Math.max(0.001, effect.duration), 0, 1)
  const amount = focusZoomAmountAtProgress(effect, progress)
  const zoom = 1 + (effect.zoom - 1) * amount
  const width = 1 / zoom
  return { zoom, left: clamp(effect.focusX - width / 2, 0, 1 - width), top: clamp(effect.focusY - width / 2, 0, 1 - width), width, height: width }
}

export function focusCameraTransformAtTime(
  effects: FocusZoomEffect[],
  outputTime: number,
  frame = { left: 0, top: 0, width: 1, height: 1 }
): string | undefined {
  const effect = effects.find((item) => outputTime >= item.start && outputTime <= item.start + item.duration)
  if (!effect || effect.mode === 'circle') return undefined
  const crop = focusCropAtTime(effect, outputTime)
  // Export zooms after the Short crop. Map that crop-local camera back into
  // the full-source preview, keeping the red guide and overlays stationary.
  const left = Number(((frame.left * (1 / crop.zoom - 1) - frame.width * crop.left) * 100).toFixed(6))
  const top = Number(((frame.top * (1 / crop.zoom - 1) - frame.height * crop.top) * 100).toFixed(6))
  return `scale(${crop.zoom}) translate(${left}%, ${top}%)`
}

export function addFocusZoom(session: EditSession, start: number, end: number, zoom: FocusZoomAmount, focusX: number, focusY: number,
  transitionDuration = focusZoomDefaultTransitionDuration, mode?: FocusZoomMode): EditSession {
  const duration = timelineDuration(session.segments)
  const effect: FocusZoomEffect = { id: makeId('zoom'), start: clamp(start, 0, duration), duration: Math.max(0.001, Math.min(end, duration) - Math.max(start, 0)), transitionDuration,
    ...(mode === undefined ? {} : { mode }), zoom, focusX: clamp(focusX, 0, 1), focusY: clamp(focusY, 0, 1) }
  const focusZooms = session.focusZooms.filter((item) => item.start + item.duration <= effect.start || item.start >= effect.start + effect.duration)
  return { ...session, focusZooms: [...focusZooms, effect].sort((left, right) => left.start - right.start) }
}

export function removeFocusZoomFromRange(session: EditSession, start: number, end: number): EditSession {
  return { ...session, focusZooms: session.focusZooms.filter((effect) => effect.start + effect.duration <= start || effect.start >= end) }
}
