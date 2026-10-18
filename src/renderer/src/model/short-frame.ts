import { shortFrameMaxPoints } from '@shared/types'
import type { EditSession, ShortFrameDirection, ShortFramePoint } from '@shared/types'
import { normalizeShortFramePoints, shortFramePositionAtTime } from '@shared/short-frame'

const EPSILON = 0.0001

export function nudgeShortFrame(
  session: EditSession,
  direction: ShortFrameDirection
): EditSession | null {
  const points = session.shortFramePoints ?? []
  const time = Math.max(0, session.playhead)
  const index = points.findIndex((point) => Math.abs(point.time - time) <= EPSILON)
  if (index < 0 && points.length >= shortFrameMaxPoints) return null
  const current = shortFramePositionAtTime(points, time, session.canvas.shortFramePosition ?? 0.5)
  const position = Math.round(Math.max(0, Math.min(1, current + (direction === 'left' ? -0.05 : 0.05))) * 1e6) / 1e6
  if (position === current) return session
  let point: ShortFramePoint
  if (index < 0) {
    point = { id: `short-frame-point-${globalThis.crypto.randomUUID()}`, time, position }
  } else {
    const existing = points[index]
    if (!existing) return session
    point = { ...existing, time, position }
  }
  const next = index < 0 ? [...points, point] : points.map((item, itemIndex) => itemIndex === index ? point : item)
  return { ...session, shortFramePoints: normalizeShortFramePoints(next) }
}

export function shortFramePointsAfterInsertion(
  points: readonly ShortFramePoint[],
  point: number,
  duration: number
): ShortFramePoint[] {
  return normalizeShortFramePoints(points.map((item) =>
    // The time-zero anchor defines initial framing, including any new prefix.
    item.time > EPSILON && item.time >= point - EPSILON ? { ...item, time: item.time + duration } : item
  ))
}

export function shortFramePointsAfterRemoval(
  points: readonly ShortFramePoint[],
  start: number,
  end: number
): ShortFramePoint[] {
  const removed = end - start
  return normalizeShortFramePoints(points.flatMap((item) => {
    if (item.time <= start + EPSILON) return [item]
    if (item.time >= end - EPSILON) return [{ ...item, time: item.time - removed }]
    return []
  }))
}

export function remapShortFramePoints(
  points: readonly ShortFramePoint[],
  map: (time: number) => number
): ShortFramePoint[] {
  return normalizeShortFramePoints(points.map((item) => ({ ...item, time: Math.max(0, map(item.time)) })))
}
