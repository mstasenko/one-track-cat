import type { FaceBlurEffect, FaceBlurSettings } from '@shared/types'
import { makeId } from './timeline'

const EPSILON = 0.0001

function orderedRange(rawStart: number, rawEnd: number): [number, number] {
  return rawStart <= rawEnd ? [rawStart, rawEnd] : [rawEnd, rawStart]
}

/** Replace the selected interval while retaining every non-overlapping part of old effects. */
export function replaceFaceBlurRange(
  effects: FaceBlurEffect[],
  rawStart: number,
  rawEnd: number,
  settings: FaceBlurSettings
): FaceBlurEffect[] {
  const [start, end] = orderedRange(rawStart, rawEnd)
  if (end - start <= EPSILON) return effects
  const retained: FaceBlurEffect[] = []

  for (const effect of effects) {
    const effectEnd = effect.start + effect.duration
    if (effectEnd <= start + EPSILON || effect.start >= end - EPSILON) {
      retained.push(effect)
      continue
    }
    const leftDuration = start - effect.start
    if (leftDuration > EPSILON) retained.push({ ...effect, duration: leftDuration })
    const rightDuration = effectEnd - end
    if (rightDuration > EPSILON) {
      retained.push({
        ...effect,
        ...(leftDuration > EPSILON ? { id: makeId('face-blur') } : {}),
        start: end,
        duration: rightDuration
      })
    }
  }

  retained.push({ ...settings, id: makeId('face-blur'), start, duration: end - start })
  return retained.sort((left, right) => left.start - right.start)
}

export function removeFaceBlurById(effects: FaceBlurEffect[], id: string): FaceBlurEffect[] {
  const filtered = effects.filter((effect) => effect.id !== id)
  return filtered.length === effects.length ? effects : filtered
}

export function updateFaceBlurById(effects: FaceBlurEffect[], id: string, settings: FaceBlurSettings): FaceBlurEffect[] {
  const current = effects.find((effect) => effect.id === id)
  if (!current) return effects
  const updated = { ...current, ...settings, id: current.id, start: current.start, duration: current.duration }
  if (JSON.stringify(updated) === JSON.stringify(current)) return effects
  return effects.map((effect) => effect.id === id ? updated : effect)
}
