import { shortFrameMaxPoints, type ProjectCanvas, type ShortFramePoint, type ShortFrameMove } from '../types'
import {
  isShortCanvas,
  legacyShortFrameMovesToPoints,
  normalizeShortFramePoints
} from '../short-frame'
import { record, identifier, number, oneOf, validateUniqueIds, type UnknownRecord } from './validation-values'

function parseShortFramePoints(
  value: unknown,
  timelineDuration: number,
  canvas: ProjectCanvas
): ShortFramePoint[] {
  if (!Array.isArray(value) || value.length > shortFrameMaxPoints) throw new Error(`Short frame points must be an array with at most ${shortFrameMaxPoints} entries`)
  if (value.length > 0 && !isShortCanvas(canvas)) {
    throw new Error('Short frame points require a YouTube Short project')
  }
  const output = value.map((item) => {
    const input = record(item, 'Short frame point')
    return {
      id: identifier(input.id, 'Short frame point ID'),
      time: number(input.time, 'Short frame point time', 0, timelineDuration),
      position: number(input.position, 'Short frame point position', 0, 1)
    }
  }).sort((left, right) => left.time - right.time)
  validateUniqueIds(output, 'Short frame point')
  if (output.some((point, index) => index > 0 && point.time - (output[index - 1]?.time ?? 0) <= 0.0001)) {
    throw new Error('Short frame points must have unique times')
  }
  return output
}

function parseLegacyShortFrameMoves(value: unknown, timelineDuration: number, canvas: ProjectCanvas): ShortFrameMove[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) throw new Error('Short frame moves must be an array')
  if (value.length > 0 && !isShortCanvas(canvas)) {
    throw new Error('Short frame moves require a YouTube Short project')
  }
  const output = value.map((item) => {
    const input = record(item, 'Short frame move')
    const start = number(input.start, 'Short frame move start', 0, timelineDuration)
    const duration = number(input.duration, 'Short frame move duration', 0.0001, timelineDuration)
    if (start + duration > timelineDuration + 0.0001) throw new Error('Short frame move extends past the timeline')
    return {
      id: identifier(input.id, 'Short frame move ID'),
      start,
      duration,
      direction: oneOf(input.direction, ['left', 'right'] as const, 'Short frame move direction')
    }
  }).sort((left, right) => left.start - right.start)
  validateUniqueIds(output, 'Short frame move')
  if (output.some((move, index) => index > 0 && move.start < (output[index - 1]?.start ?? 0) + (output[index - 1]?.duration ?? 0) - 0.0001)) {
    throw new Error('Short frame moves cannot overlap')
  }
  return output
}

export function parseShortFraming(
  input: UnknownRecord,
  timelineDuration: number,
  canvas: ProjectCanvas,
  legacyInitial: number | undefined
): ShortFramePoint[] | undefined {
  const hasPoints = input.shortFramePoints !== undefined
  const hasMoves = input.shortFrameMoves !== undefined
  const hasInitial = legacyInitial !== undefined
  if (hasPoints && (hasMoves || hasInitial)) {
    throw new Error('Short frame points cannot be combined with legacy framing fields')
  }
  if (hasPoints) {
    return parseShortFramePoints(input.shortFramePoints, timelineDuration, canvas)
  }
  if (!hasMoves && !hasInitial) return undefined
  // Preserve the old permissive ordinary-canvas schema when the field had no effect.
  if (!isShortCanvas(canvas) && !hasMoves) return []
  const moves = parseLegacyShortFrameMoves(input.shortFrameMoves, timelineDuration, canvas)
  return normalizeShortFramePoints(
    legacyShortFrameMovesToPoints(moves, legacyInitial ?? 0.5, hasInitial)
      .map((point) => ({ ...point, time: Math.min(point.time, timelineDuration) }))
  )
}
