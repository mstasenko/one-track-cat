import { describe, expect, it } from 'vitest'
import {
  DUCK_ATTACK,
  DUCK_RELEASE,
  effectiveFadeDurations,
  gameAudioGainAtOutputTime,
  overlayGainAtLocalTime
} from './audio-envelope'
import type { Overlay } from './types'

const audio = (patch: Partial<Extract<Overlay, { type: 'audio' }>> = {}): Extract<Overlay, { type: 'audio' }> => ({
  id: 'sound', type: 'audio', name: 'Boom', path: '/boom.wav', start: 1, duration: 2,
  zIndex: 1, volume: 1, sourceIn: 0, duckGameAudio: true,
  gameAudioLevel: 0.3, ...patch
})

describe('audio envelopes', () => {
  it('clamps requested fades to half the overlay and stays finite', () => {
    expect(effectiveFadeDurations(0.2, 1, 0.5)).toEqual({ fadeIn: 0.1, fadeOut: 0.1 })
    expect(effectiveFadeDurations(0, 1, 1)).toEqual({ fadeIn: 0, fadeOut: 0 })
    for (const time of [-1, 0, 0.05, 0.1, 1, Number.NaN]) {
      expect(Number.isFinite(overlayGainAtLocalTime(0.2, 1, 1, time))).toBe(true)
    }
  })

  it('uses smooth monotonic fade-in and fade-out envelopes', () => {
    expect(overlayGainAtLocalTime(2, 0, 0, 1)).toBe(1)
    expect(overlayGainAtLocalTime(2, 0.5, 0.5, 0)).toBe(0)
    expect(overlayGainAtLocalTime(2, 0.5, 0.5, 0.25)).toBeCloseTo(0.5)
    expect(overlayGainAtLocalTime(2, 0.5, 0.5, 0.5)).toBe(1)
    expect(overlayGainAtLocalTime(2, 0.5, 0.5, 1.75)).toBeCloseTo(0.5)
    expect(overlayGainAtLocalTime(2, 0.5, 0.5, 2)).toBe(0)
  })

  it('ducks through attack, active time, and release', () => {
    const overlays: Overlay[] = [audio()]
    expect(gameAudioGainAtOutputTime(overlays, 1 - DUCK_ATTACK)).toBe(1)
    expect(gameAudioGainAtOutputTime(overlays, 1 - DUCK_ATTACK / 2)).toBeCloseTo(0.65)
    expect(gameAudioGainAtOutputTime(overlays, 1)).toBeCloseTo(0.3)
    expect(gameAudioGainAtOutputTime(overlays, 2)).toBeCloseTo(0.3)
    expect(gameAudioGainAtOutputTime(overlays, 3 + DUCK_RELEASE / 2)).toBeCloseTo(0.65)
    expect(gameAudioGainAtOutputTime(overlays, 3 + DUCK_RELEASE)).toBe(1)
  })

  it('uses the strongest audible request and ignores muted video or zero volume', () => {
    const overlays: Overlay[] = [
      audio({ id: 'soft', gameAudioLevel: 0.5 }),
      audio({ id: 'strong', gameAudioLevel: 0.15 }),
      audio({ id: 'silent', volume: 0, gameAudioLevel: 0.15 }),
      {
        id: 'video', type: 'video', name: 'Reaction', path: '/reaction.mp4', start: 1,
        duration: 2, zIndex: 2, x: 0, y: 0, width: 1, height: 1, opacity: 1,
        loop: false, audioEnabled: false, hasAudio: true, volume: 1, sourceIn: 0,
        sourceDuration: 2, duckGameAudio: true, gameAudioLevel: 0.15
      }
    ]
    expect(gameAudioGainAtOutputTime(overlays, 2)).toBeCloseTo(0.15)
    expect(gameAudioGainAtOutputTime(overlays.slice(0, 1), 2)).toBeCloseTo(0.5)
    expect(gameAudioGainAtOutputTime(overlays.slice(2), 2)).toBe(1)
  })
})
