import { describe, expect, it } from 'vitest'
import type { Overlay } from '../types'
import { addAudioOverlayFilters, overlayVolumeExpression } from './audio-filters'

const audio = (patch: Partial<Extract<Overlay, { type: 'audio' }>> = {}): Extract<Overlay, { type: 'audio' }> => ({
  id: 'audio', type: 'audio', name: 'Boom', path: '/boom.wav', start: 1, duration: 0.4,
  zIndex: 1, volume: 2, sourceIn: 0.25, ...patch
})

describe('audio export filters', () => {
  it('keeps the simple volume path without fades', () => {
    expect(overlayVolumeExpression(audio())).toBe('2.000000')
  })

  it('builds smooth frame-evaluated fades clamped for a short overlay', () => {
    const expression = overlayVolumeExpression(audio({ fadeIn: 1, fadeOut: 0.25 }))
    expect(expression).toContain('min(')
    expect(expression).toContain('/0.2')
    expect(expression).toContain('(0.400000-t)/0.200000')
  })

  it('ducks the base on output time and mixes only audible overlay streams', () => {
    const filters: string[] = []
    const mutedVideo: Extract<Overlay, { type: 'video' }> = {
      id: 'video', type: 'video', name: 'Muted', path: '/muted.mp4', start: 0,
      duration: 1, zIndex: 2, x: 0, y: 0, width: 1, height: 1, opacity: 1,
      loop: false, audioEnabled: false, hasAudio: true, volume: 1, sourceIn: 0,
      sourceDuration: 1, duckGameAudio: true, gameAudioLevel: 0.15
    }
    addAudioOverlayFilters(filters, [
      { overlay: audio({ duckGameAudio: true, gameAudioLevel: 0.3 }), index: 1 },
      { overlay: mutedVideo, index: 2 }
    ], 4)
    const graph = filters.join(';')
    expect(graph).toContain('[basea]volume=')
    expect(graph).toContain('0.92')
    expect(graph).toContain('0.3')
    expect(graph).toContain('atrim=start=0.250000:end=0.650000')
    expect(graph).toContain('amix=inputs=2')
    expect(graph).not.toContain('[2:a:0]')
    expect(graph).toContain('alimiter=limit=0.95')
  })
})
