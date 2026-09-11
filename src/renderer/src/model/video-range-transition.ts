import type { CSSProperties } from 'react'
import type { VideoRangeTransition, VideoTransition } from '@shared/types'
import { clamp, makeId } from './timeline'
import { fitVideoRangeTransition } from '@shared/video-range-transition'

const EPSILON = 0.0001

function fitted(effect: VideoTransition | undefined, duration: number, bothEdges: boolean): VideoTransition | undefined {
  if (!effect) return undefined
  const fittedDuration = Math.min(bothEdges ? duration / 2 : duration, effect.duration)
  return fittedDuration >= 0.05 ? { ...effect, duration: fittedDuration } : undefined
}

export function replaceVideoRangeTransition(
  effects: VideoRangeTransition[],
  start: number,
  end: number,
  into: VideoTransition | undefined,
  out: VideoTransition | undefined
): VideoRangeTransition[] {
  const duration = end - start
  const bothEdges = Boolean(into && out)
  const next = {
    id: makeId('video-transition'), start, duration,
    into: fitted(into, duration, bothEdges), out: fitted(out, duration, bothEdges)
  }
  const kept = effects.filter((effect) => effect.start + effect.duration <= start + EPSILON || effect.start >= end - EPSILON)
  return next.into || next.out ? [...kept, next].sort((left, right) => left.start - right.start) : kept
}

function smoothstep(progress: number): number {
  return progress * progress * (3 - 2 * progress)
}

function edgeProgress(effect: VideoTransition | undefined, elapsed: number, fromStart: boolean): number {
  if (!effect) return 1
  const distance = fromStart ? elapsed : -elapsed
  return smoothstep(clamp(distance / effect.duration, 0, 1))
}

export function videoRangeStyleAtTime(effects: VideoRangeTransition[], time: number): CSSProperties {
  const found = effects.find((item) => time >= item.start && time <= item.start + item.duration)
  if (!found) return {}
  const effect = fitVideoRangeTransition(found)
  const elapsed = time - effect.start
  const remaining = effect.start + effect.duration - time
  const intoProgress = edgeProgress(effect.into, elapsed, true)
  const outProgress = edgeProgress(effect.out, -remaining, false)
  let opacity = 1
  let blur = 0
  if (effect.into?.effect === 'fade' || effect.into?.effect === 'dissolve') opacity = Math.min(opacity, intoProgress)
  if (effect.out?.effect === 'fade' || effect.out?.effect === 'dissolve') opacity = Math.min(opacity, outProgress)
  if (effect.into?.effect === 'hblur' || effect.into?.effect === 'dissolve') blur = Math.max(blur, (1 - intoProgress) * 18)
  if (effect.out?.effect === 'hblur' || effect.out?.effect === 'dissolve') blur = Math.max(blur, (1 - outProgress) * 18)
  return {
    ...(opacity < 1 ? { opacity } : {}),
    ...(blur > 0.01 ? { filter: `blur(${blur}px)` } : {})
  }
}
