import {
  shortFrameMaxPoints,
  type MediaMetadata,
  type ProjectCanvas,
  type ShortFrameMove,
  type ShortFramePoint
} from './types'

const center = 0.5
const epsilon = 0.0001

export function isShortCanvas(canvas: ProjectCanvas): boolean {
  return canvas.width === 1080 && canvas.height === 1920 && canvas.fit === 'cover'
}

function clampPosition(position: number): number {
  return Math.max(0, Math.min(1, position))
}

function smoothstep(progress: number): number {
  return progress * progress * (3 - 2 * progress)
}

function number(value: number): string {
  return Number(value.toFixed(6)).toString()
}

/** Return a stable, sorted keyframe list, with the last point winning at one time. */
export function normalizeShortFramePoints(points: readonly ShortFramePoint[]): ShortFramePoint[] {
  const sorted = points.map((point, index) => ({ point, index })).sort((left, right) =>
    left.point.time - right.point.time || left.index - right.index
  )
  const output: ShortFramePoint[] = []
  for (const { point } of sorted) {
    if (!Number.isFinite(point.time) || point.time < 0 || !Number.isFinite(point.position)) {
      throw new Error('Short frame points contain an invalid value')
    }
    const normalized = { ...point, position: clampPosition(point.position) }
    const previous = output.at(-1)
    if (previous && Math.abs(previous.time - normalized.time) <= epsilon) output[output.length - 1] = normalized
    else output.push(normalized)
  }
  if (output.length > shortFrameMaxPoints) throw new Error(`Short frame points must contain at most ${shortFrameMaxPoints} entries`)
  return output
}

function anchors(points: readonly ShortFramePoint[], initialPosition: number): ShortFramePoint[] {
  const normalized = normalizeShortFramePoints(points)
  const first = normalized[0]
  if (first && Math.abs(first.time) <= epsilon) return [{ ...first, time: 0 }, ...normalized.slice(1)]
  return [{ id: 'short-frame-initial', time: 0, position: clampPosition(initialPosition) }, ...normalized]
}

/** Evaluate normalized horizontal framing with smoothstep interpolation and held endpoints. */
export function shortFramePositionAtTime(
  points: readonly ShortFramePoint[],
  time: number,
  initialPosition = center
): number {
  const timeline = anchors(points, initialPosition)
  const safeTime = Number.isFinite(time) ? time : 0
  if (safeTime <= 0) return timeline[0]?.position ?? clampPosition(initialPosition)
  for (let index = 1; index < timeline.length; index += 1) {
    const previous = timeline[index - 1]
    const next = timeline[index]
    if (!previous || !next) continue
    if (safeTime < next.time) {
      const progress = Math.max(0, Math.min(1, (safeTime - previous.time) / (next.time - previous.time)))
      return previous.position + (next.position - previous.position) * smoothstep(progress)
    }
  }
  return timeline.at(-1)?.position ?? clampPosition(initialPosition)
}

/** Build the same smoothstep interpolation as the preview for FFmpeg. */
export function shortFramePositionExpression(
  points: readonly ShortFramePoint[],
  time: string,
  initialPosition = center
): string {
  const timeline = anchors(points, initialPosition)
  let expression = number(timeline.at(-1)?.position ?? clampPosition(initialPosition))
  for (let index = timeline.length - 1; index > 0; index -= 1) {
    const previous = timeline[index - 1]
    const next = timeline[index]
    if (!previous || !next) continue
    const end = number(next.time)
    const progress = `min(1,max(0,((${time})-${number(previous.time)})/${number(next.time - previous.time)}))`
    const eased = `(${progress}*${progress}*(3-2*${progress}))`
    const moving = `${number(previous.position)}+(${number(next.position - previous.position)})*${eased}`
    expression = `if(lt(${time},${end}),${moving},${expression})`
  }
  return expression
}

/** Convert the legacy global/range representation into explicit keyframes. */
export function legacyShortFrameMovesToPoints(
  moves: readonly ShortFrameMove[],
  initialPosition = center,
  preserveInitial = Math.abs(initialPosition - center) > epsilon
): ShortFramePoint[] {
  let position = clampPosition(initialPosition)
  const points: ShortFramePoint[] = preserveInitial
    ? [{ id: 'short-frame-initial', time: 0, position }]
    : []
  for (const [index, move] of [...moves].sort((left, right) => left.start - right.start).entries()) {
    const destination = move.direction === 'left' ? 0 : 1
    points.push(
      { id: `short-frame-legacy-${index}-start`, time: move.start, position },
      { id: `short-frame-legacy-${index}-end`, time: move.start + move.duration, position: destination }
    )
    position = destination
  }
  return normalizeShortFramePoints(points)
}

/** Normalized source-space rectangle retained by a cover-fitted Short. */
export function shortFrameRect(
  canvas: ProjectCanvas,
  source: Pick<MediaMetadata, 'width' | 'height'>,
  position: number
): { left: number; top: number; width: number; height: number } {
  const sourceWidth = Math.max(1, source.width)
  const sourceHeight = Math.max(1, source.height)
  const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight)
  const width = Math.min(1, canvas.width / (sourceWidth * scale))
  const height = Math.min(1, canvas.height / (sourceHeight * scale))
  return {
    left: (1 - width) * clampPosition(position),
    top: (1 - height) / 2,
    width,
    height
  }
}
