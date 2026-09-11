import type { AudioFadeDuration, GameAudioLevel, Overlay } from './types'

export const DUCK_ATTACK = 0.08
export const DUCK_RELEASE = 0.18
const AUDIBLE_EPSILON = 0.0001

export type AudioEnabledOverlay = Extract<Overlay, { type: 'audio' | 'video' }>

export function isAudioEnabledOverlay(overlay: Overlay): overlay is AudioEnabledOverlay {
  return overlay.type === 'audio' || (
    overlay.type === 'video' && overlay.hasAudio && overlay.audioEnabled
  )
}

function clamp(value: number, min = 0, max = 1): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
}

function smoothstep(progress: number): number {
  const value = clamp(progress)
  return value * value * (3 - 2 * value)
}

export function effectiveFadeDurations(
  duration: number,
  requestedFadeIn: AudioFadeDuration | undefined,
  requestedFadeOut: AudioFadeDuration | undefined
): { fadeIn: number; fadeOut: number } {
  const half = clamp(duration, 0, Number.MAX_SAFE_INTEGER) / 2
  return {
    fadeIn: Math.min(requestedFadeIn ?? 0, half),
    fadeOut: Math.min(requestedFadeOut ?? 0, half)
  }
}

export function overlayGainAtLocalTime(
  duration: number,
  requestedFadeIn: AudioFadeDuration | undefined,
  requestedFadeOut: AudioFadeDuration | undefined,
  localTime: number
): number {
  const safeDuration = clamp(duration, 0, Number.MAX_SAFE_INTEGER)
  if (safeDuration <= 0) return 0
  const time = clamp(localTime, 0, safeDuration)
  const { fadeIn, fadeOut } = effectiveFadeDurations(safeDuration, requestedFadeIn, requestedFadeOut)
  const fadeInGain = fadeIn > 0 ? smoothstep(time / fadeIn) : 1
  const fadeOutGain = fadeOut > 0 ? smoothstep((safeDuration - time) / fadeOut) : 1
  return clamp(Math.min(fadeInGain, fadeOutGain))
}

function requestsDucking(overlay: Extract<Overlay, { type: 'audio' | 'video' }>): boolean {
  return overlay.duckGameAudio === true ? overlay.volume > AUDIBLE_EPSILON : false
}

function audibleDucker(overlay: Overlay): overlay is Extract<Overlay, { type: 'audio' | 'video' }> {
  return isAudioEnabledOverlay(overlay) && requestsDucking(overlay)
}

function attackGain(start: number, attackStart: number, level: GameAudioLevel, outputTime: number): number {
  if (start === attackStart) return level
  const progress = (outputTime - attackStart) / (start - attackStart)
  return 1 - (1 - level) * smoothstep(progress)
}

function duckGain(
  start: number,
  end: number,
  level: GameAudioLevel,
  outputTime: number
): number {
  const attackStart = Math.max(0, start - DUCK_ATTACK)
  if (outputTime < attackStart) return 1
  if (outputTime > end + DUCK_RELEASE) return 1
  if (outputTime < start) return attackGain(start, attackStart, level, outputTime)
  if (outputTime <= end) return level
  return level + (1 - level) * smoothstep((outputTime - end) / DUCK_RELEASE)
}

export function gameAudioGainAtOutputTime(overlays: Overlay[], outputTime: number): number {
  if (!Number.isFinite(outputTime)) return 1
  return overlays.reduce((gain, overlay) => {
    if (!audibleDucker(overlay)) return gain
    return Math.min(gain, duckGain(
      overlay.start,
      overlay.start + overlay.duration,
      overlay.gameAudioLevel ?? 0.3,
      outputTime
    ))
  }, 1)
}
