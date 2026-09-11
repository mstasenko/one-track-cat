import type { EditSession, FocusZoomAmount, FocusZoomEffect } from '@shared/types'
import { clamp, makeId, timelineDuration } from './timeline'

export function focusCropAtTime(effect: FocusZoomEffect, outputTime: number): { zoom: number; left: number; top: number; width: number; height: number } {
  const progress = clamp((outputTime - effect.start) / Math.max(0.001, effect.duration), 0, 1)
  const ramp = Math.min(0.18, effect.duration / 3)
  const inProgress = ramp > 0 ? clamp(progress / (ramp / effect.duration), 0, 1) : 1
  const outProgress = ramp > 0 ? clamp((progress - (1 - ramp / effect.duration)) / (ramp / effect.duration), 0, 1) : 0
  const smooth = (value: number): number => value * value * (3 - 2 * value)
  const amount = smooth(inProgress) * (1 - smooth(outProgress))
  const zoom = 1 + (effect.zoom - 1) * amount
  const width = 1 / zoom
  return { zoom, left: clamp(effect.focusX - width / 2, 0, 1 - width), top: clamp(effect.focusY - width / 2, 0, 1 - width), width, height: width }
}

export function focusCameraTransformAtTime(effects: FocusZoomEffect[], outputTime: number): string | undefined {
  const effect = effects.find((item) => outputTime >= item.start && outputTime <= item.start + item.duration)
  if (!effect) return undefined
  const crop = focusCropAtTime(effect, outputTime)
  const left = Number((-crop.left * 100).toFixed(6))
  const top = Number((-crop.top * 100).toFixed(6))
  return `scale(${crop.zoom}) translate(${left}%, ${top}%)`
}

export function addFocusZoom(session: EditSession, start: number, end: number, zoom: FocusZoomAmount, focusX: number, focusY: number): EditSession {
  const duration = timelineDuration(session.segments)
  const effect: FocusZoomEffect = { id: makeId('zoom'), start: clamp(start, 0, duration), duration: Math.max(0.001, Math.min(end, duration) - Math.max(start, 0)), zoom, focusX: clamp(focusX, 0, 1), focusY: clamp(focusY, 0, 1) }
  const focusZooms = session.focusZooms.filter((item) => item.start + item.duration <= effect.start || item.start >= effect.start + effect.duration)
  return { ...session, focusZooms: [...focusZooms, effect].sort((left, right) => left.start - right.start) }
}

export function removeFocusZoomFromRange(session: EditSession, start: number, end: number): EditSession {
  return { ...session, focusZooms: session.focusZooms.filter((effect) => effect.start + effect.duration <= start || effect.start >= end) }
}
