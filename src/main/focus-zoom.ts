import {
  circleDrawDuration,
  focusCircleGeometry,
  focusZoomTransitionDuration,
  smoothstepExpression
} from '../focus-zoom'
import type { ExportRequest, FocusZoomEffect } from '../types'

function seconds(value: number): string {
  return Math.max(0, value).toFixed(6)
}

/** Escape commas inside an FFmpeg expression argument. */
function expression(value: string): string {
  return value.replaceAll(',', '\\,')
}

function focusZoomExpression(request: ExportRequest): { zoom: string; x: string; y: string } | null {
  const effects = (request.focusZooms ?? []).filter((effect) => effect.mode !== 'circle')
  if (effects.length === 0) return null
  const time = `on/${request.canvas.fps}`
  let zoom = '1'
  let x = '0'
  let y = '0'
  for (const effect of [...effects].reverse()) {
    const end = effect.start + effect.duration
    const ramp = focusZoomTransitionDuration(effect)
    const local = `((${time})-${seconds(effect.start)})`
    const easedIn = smoothstepExpression(`${local}/${seconds(ramp)}`)
    const easedOut = smoothstepExpression(`(${local}-${seconds(effect.duration - ramp)})/${seconds(ramp)}`)
    const activeZoom = `(1+${effect.zoom - 1}*${easedIn}*(1-${easedOut}))`
    const active = `between(${time},${seconds(effect.start)},${seconds(end)})`
    zoom = `if(${active},${activeZoom},${zoom})`
    x = `if(${active},max(0,min(iw-iw/zoom,${effect.focusX}*iw-iw/(2*zoom))),${x})`
    y = `if(${active},max(0,min(ih-ih/zoom,${effect.focusY}*ih-ih/(2*zoom))),${y})`
  }
  return { zoom, x, y }
}

function focusZoomOpacityExpression(effect: Pick<FocusZoomEffect, 'start' | 'duration' | 'transitionDuration'>): string {
  const ramp = focusZoomTransitionDuration(effect)
  const local = `(T-${seconds(effect.start)})`
  const easedIn = smoothstepExpression(`${local}/${seconds(ramp)}`)
  const easedOut = smoothstepExpression(`(${local}-${seconds(effect.duration - ramp)})/${seconds(ramp)}`)
  const active = `between(T,${seconds(effect.start)},${seconds(effect.start + effect.duration)})`
  return `if(${active},${easedIn}*(1-${easedOut}),0)`
}

function circleRingFilter(effect: FocusZoomEffect, request: ExportRequest, index: number): {
  ring: string
  x: number
  y: number
} {
  const geometry = focusCircleGeometry(effect, request.canvas)
  const size = Math.max(2, Math.round(geometry.size))
  const x = Math.max(0, Math.min(request.canvas.width - size, Math.round(geometry.x)))
  const y = Math.max(0, Math.min(request.canvas.height - size, Math.round(geometry.y)))

  const centerX = '(W-1)/2'
  const centerY = '(H-1)/2'
  const radius = '(W-1)/2'
  const distanceSquared = `(X-${centerX})*(X-${centerX})+(Y-${centerY})*(Y-${centerY})`
  const redWidth = Math.max(2, geometry.borderWidth)
  const blackEdge = Math.max(1, redWidth * 0.3)
  // Keep the black under-stroke inside the output boundary and center the red stroke
  // inside it, matching the preview's butt-capped SVG strokes.
  const redOuterRadius = `${radius}-${blackEdge}`
  const redInnerRadius = `${radius}-${blackEdge}-${redWidth}`
  const blackInnerRadius = `${radius}-${redWidth}-${2 * blackEdge}`
  const redRing = `lte(${distanceSquared},(${redOuterRadius})*(${redOuterRadius}))*gte(${distanceSquared},(${redInnerRadius})*(${redInnerRadius}))`
  const blackRing = `lte(${distanceSquared},${radius}*${radius})*gte(${distanceSquared},(${blackInnerRadius})*(${blackInnerRadius}))`
  const rawAngle = `atan2(X-${centerX},${centerY}-Y)`
  const angle = `if(lt(${rawAngle},0),${rawAngle}+2*PI,${rawAngle})`
  const drawProgress = smoothstepExpression(`(T-${seconds(effect.start)})/${seconds(circleDrawDuration(effect))}`)
  const arc = `lte(${angle},${drawProgress}*2*PI)`
  const active = `between(T,${seconds(effect.start)},${seconds(effect.start + effect.duration)})`
  const redStroke = `${active}*${redRing}*${arc}`
  const blackStroke = `${active}*${blackRing}*${arc}`
  const opacity = focusZoomOpacityExpression(effect)
  const ringAlpha = `min(1,${redStroke}+${blackStroke})*255*${opacity}`

  // The overlay contains only the animated outline. Its interior and exterior stay transparent,
  // so circle mode never crops, magnifies, or replaces the original footage.
  const red = `if(${redStroke},255,0)`
  const geq = `format=rgba,geq=r='${expression(red)}':g='0':b='0':a='${expression(ringAlpha)}'`
  const ringDuration = seconds(effect.duration)
  return {
    ring: `color=c=black@0.0:s=${size}x${size}:r=${request.canvas.fps}:d=${ringDuration},setpts=PTS+${seconds(effect.start)}/TB,${geq}[focusRing${index}]`,
    x,
    y
  }
}

function addCircleFocusZoomFilter(filters: string[], inputLabel: string, effect: FocusZoomEffect, request: ExportRequest, index: number): string {
  const ring = circleRingFilter(effect, request, index)
  const output = `focusCircle${index}`
  const enable = expression(`between(t,${seconds(effect.start)},${seconds(effect.start + effect.duration)})`)
  filters.push(
    ring.ring,
    `[${inputLabel}][focusRing${index}]overlay=x=${ring.x}:y=${ring.y}:eof_action=pass:repeatlast=1:format=rgb:enable='${enable}'[${output}]`
  )
  return output
}

export function addFocusZoomFilters(filters: string[], request: ExportRequest, input = 'basev'): string {
  const frame = focusZoomExpression(request)
  let current = input
  if (frame) {
    const { width, height, fps } = request.canvas
    filters.push(`[${current}]zoompan=z='${frame.zoom}':x='${frame.x}':y='${frame.y}':d=1:s=${width}x${height}:fps=${fps}[camera]`)
    current = 'camera'
  }
  for (const [index, effect] of (request.focusZooms ?? []).entries()) {
    if (effect.mode !== 'circle') continue
    current = addCircleFocusZoomFilter(filters, current, effect, request, index)
  }
  return current
}
