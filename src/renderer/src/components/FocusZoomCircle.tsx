import type { FocusZoomEffect, ProjectCanvas } from '@shared/types'
import { circleDrawDuration, focusCircleGeometry, focusZoomAmountAtProgress, smoothstep } from '@shared/focus-zoom'

export interface FocusZoomCircleProps {
  effects: FocusZoomEffect[]
  outputTime: number
  canvas: Pick<ProjectCanvas, 'width' | 'height'>
}

function activeCircle(effects: FocusZoomEffect[], outputTime: number): FocusZoomEffect | null {
  return effects.find((effect) => effect.mode === 'circle' && outputTime >= effect.start && outputTime <= effect.start + effect.duration) ?? null
}

function clampedProgress(outputTime: number, start: number, duration: number): number {
  return Math.max(0, Math.min(1, (outputTime - start) / Math.max(0.001, duration)))
}

/** Render the circle as an overlay only; the preview's video remains the sole image source. */
export function FocusZoomCircle({ effects, outputTime, canvas: output }: FocusZoomCircleProps): React.JSX.Element | null {
  const effect = activeCircle(effects, outputTime)
  if (!effect) return null

  const geometry = focusCircleGeometry(effect, output)
  const centerX = geometry.x + geometry.size / 2
  const centerY = geometry.y + geometry.size / 2
  const radius = geometry.size / 2
  const redWidth = geometry.borderWidth
  const blackEdge = Math.max(1, redWidth * 0.3)
  const strokeRadius = radius - blackEdge - redWidth / 2
  const circumference = 2 * Math.PI * strokeRadius
  const drawDuration = circleDrawDuration(effect)
  const outlineProgress = drawDuration > 0
    ? smoothstep((outputTime - effect.start) / drawDuration)
    : 1
  const dashOffset = circumference * (1 - outlineProgress)
  const opacity = focusZoomAmountAtProgress(effect, clampedProgress(outputTime, effect.start, effect.duration))
  const transform = `rotate(-90 ${centerX} ${centerY})`

  return <svg
    className="focus-zoom-circle"
    aria-hidden="true"
    viewBox={`0 0 ${output.width} ${output.height}`}
    width={output.width}
    height={output.height}
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5, opacity }}
  >
    <circle
      cx={centerX}
      cy={centerY}
      r={strokeRadius}
      fill="none"
      stroke="#000"
      strokeWidth={redWidth + 2 * blackEdge}
      strokeDasharray={circumference}
      strokeDashoffset={dashOffset}
      strokeLinecap="butt"
      transform={transform}
    />
    <circle
      cx={centerX}
      cy={centerY}
      r={strokeRadius}
      fill="none"
      stroke="#ff0000"
      strokeWidth={redWidth}
      strokeDasharray={circumference}
      strokeDashoffset={dashOffset}
      strokeLinecap="butt"
      transform={transform}
    />
  </svg>
}
