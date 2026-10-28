import { describe, expect, it } from 'vitest'
import { spinFilterExpressions, spinTransform } from './spin-transition'

describe('spin transition geometry', () => {
  it('keeps CSS endpoints unscaled and rotates through a full turn', () => {
    expect(spinTransform(0, true, 16 / 9)).toEqual({ angle: -Math.PI * 2, scale: 1 })
    expect(spinTransform(1, false, 16 / 9)).toEqual({ angle: Math.PI * 2, scale: 1 })
    expect(spinTransform(0.25, true, 16 / 9).scale).toBeGreaterThan(1)
  })

  it('uses frame-level rotation and dynamic cover zoom for native FFmpeg filters', () => {
    const outgoing = spinFilterExpressions(60, 0.5, false, 16, 9)
    const incoming = spinFilterExpressions(60, 0.5, true, 16, 9)
    expect(outgoing.angle).toContain('min(1,max(0,t/0.5))')
    expect(incoming.angle).toContain('1-')
    expect(incoming.angle).toContain('min(1,max(0,t/0.5))')
    expect(outgoing.scale).toContain('min(1,max(0,on/30))')
    expect(outgoing.scale).toContain('9/16')
    expect(outgoing.scale).toContain('16/9')
  })
})
