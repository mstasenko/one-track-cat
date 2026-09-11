import { describe, expect, it } from 'vitest'
import { smoothstep, textAnimationAtTime, type TextAnimationFrame } from './text-animation'

const presets = ['none', 'pop', 'fade', 'bounce', 'shake'] as const

function expectFiniteFrame(frame: TextAnimationFrame): void {
  expect(Object.values(frame).every((value) => Number.isFinite(value))).toBe(true)
}

function expectIdentity(frame: TextAnimationFrame): void {
  expect(frame).toEqual({ opacity: 1, scale: 1, translateX: 0, translateY: 0 })
}

describe('text animation math', () => {
  it('clamps smoothstep and keeps nonfinite values safe', () => {
    expect(smoothstep(-1)).toBe(0)
    expect(smoothstep(0)).toBe(0)
    expect(smoothstep(0.5)).toBe(0.5)
    expect(smoothstep(1)).toBe(1)
    expect(smoothstep(2)).toBe(1)
    expect(smoothstep(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(smoothstep(Number.POSITIVE_INFINITY)).toBe(1)
    expect(smoothstep(Number.NaN)).toBe(0)
  })

  it('returns identity for none and undefined at every time', () => {
    for (const preset of ['none', undefined] as const) {
      for (const time of [-1, 0, 0.5, 3, Number.NaN, Number.POSITIVE_INFINITY]) {
        expectIdentity(textAnimationAtTime(preset, time, 2))
      }
    }
  })

  it('fades symmetrically with a smooth ramp and no transform', () => {
    const duration = 1
    const ramp = Math.min(0.22, duration / 2)
    expect(textAnimationAtTime('fade', -0.1, duration).opacity).toBe(0)
    expect(textAnimationAtTime('fade', 0, duration).opacity).toBe(0)
    expect(textAnimationAtTime('fade', ramp / 2, duration).opacity).toBe(0.5)
    expect(textAnimationAtTime('fade', ramp, duration).opacity).toBe(1)
    expect(textAnimationAtTime('fade', duration / 2, duration).opacity).toBe(1)
    expect(textAnimationAtTime('fade', duration - ramp / 2, duration).opacity).toBeCloseTo(0.5, 12)
    expect(textAnimationAtTime('fade', duration, duration).opacity).toBe(0)
    expect(textAnimationAtTime('fade', duration + 0.1, duration).opacity).toBe(0)

    for (const time of [0, 0.03, 0.11, 0.37, 0.5]) {
      const left = textAnimationAtTime('fade', time, duration)
      const right = textAnimationAtTime('fade', duration - time, duration)
      expect(left.opacity).toBeCloseTo(right.opacity, 12)
      expect(left.scale).toBe(1)
      expect(left.translateX).toBe(0)
      expect(left.translateY).toBe(0)
    }
  })

  it('supports independent explicit fade edges and short clips', () => {
    const shortDuration = 0.2
    expect(textAnimationAtTime('fade', 0.05, shortDuration).opacity).toBeCloseTo(0.5, 12)
    expect(textAnimationAtTime('fade', 0.1, shortDuration).opacity).toBe(1)
    expect(textAnimationAtTime('fade', 0.1, shortDuration, { fadeIn: 5, fadeOut: 5 }).opacity).toBeCloseTo(0.5, 12)

    expect(textAnimationAtTime('fade', 0.2, 1, { fadeIn: 0, fadeOut: 0 }).opacity).toBe(1)
    expect(textAnimationAtTime('fade', 0, 1, { fadeIn: 0, fadeOut: 0.2 }).opacity).toBe(1)
    expect(textAnimationAtTime('fade', 0.2, 1, { fadeIn: 0.4, fadeOut: 0.8 }).opacity).toBeCloseTo(0.5, 12)
    expect(textAnimationAtTime('fade', 0.8, 1, { fadeIn: 0.8, fadeOut: 0.4 }).opacity).toBeCloseTo(0.5, 12)
    expect(textAnimationAtTime('fade', 0.5, 1, { fadeIn: 0.8, fadeOut: 0.8 }).opacity).toBeCloseTo(0.68359375, 12)

    expect(textAnimationAtTime('pop', 0, 1, { fadeIn: 0, fadeOut: 0 })).toEqual(textAnimationAtTime('pop', 0, 1))
  })

  it('supports custom motion windows, zero motion, and short-clip clamping', () => {
    for (const preset of ['pop', 'bounce', 'shake'] as const) {
      expect(textAnimationAtTime(preset, 0.05, 2, { duration: 0.1 })).not.toEqual({ opacity: 1, scale: 1, translateX: 0, translateY: 0 })
      expectIdentity(textAnimationAtTime(preset, 0.1, 2, { duration: 0.1 }))
      expectIdentity(textAnimationAtTime(preset, 0, 2, { duration: 0 }))
      expectIdentity(textAnimationAtTime(preset, 1, 2, { duration: 0 }))

      expect(textAnimationAtTime(preset, 0.1, 0.2, { duration: 5 })).not.toEqual({ opacity: 1, scale: 1, translateX: 0, translateY: 0 })
      expectIdentity(textAnimationAtTime(preset, 0.2, 0.2, { duration: 5 }))
    }

    expect(textAnimationAtTime('fade', 0.05, 1, { duration: 0 })).toEqual(textAnimationAtTime('fade', 0.05, 1))
  })

  it('pops through its overshoot and settles by the entrance end', () => {
    const duration = 2
    const entrance = Math.min(0.28, duration / 2)
    const overshootDuration = entrance * 0.65
    const midpoint = entrance / 2
    const midpointProgress = smoothstep(midpoint / overshootDuration)
    const midpointFrame = textAnimationAtTime('pop', midpoint, duration)

    expect(textAnimationAtTime('pop', -0.01, duration)).toEqual({ opacity: 0, scale: 0.65, translateX: 0, translateY: 0 })
    expect(textAnimationAtTime('pop', 0, duration)).toEqual({ opacity: 0, scale: 0.65, translateX: 0, translateY: 0 })
    expect(midpointFrame.opacity).toBeCloseTo(midpointProgress, 12)
    expect(midpointFrame.scale).toBeCloseTo(0.65 + (1.12 - 0.65) * midpointProgress, 12)
    expect(textAnimationAtTime('pop', overshootDuration, duration)).toEqual({ opacity: 1, scale: 1.12, translateX: 0, translateY: 0 })
    expect(textAnimationAtTime('pop', entrance, duration)).toEqual({ opacity: 1, scale: 1, translateX: 0, translateY: 0 })
    expectIdentity(textAnimationAtTime('pop', duration / 2, duration))
    expectIdentity(textAnimationAtTime('pop', duration - 0.01, duration))
    expectIdentity(textAnimationAtTime('pop', duration, duration))
  })

  it('bounces through its overshoot and settles by the entrance end', () => {
    const duration = 2
    const entrance = Math.min(0.38, duration / 2)
    const overshootDuration = entrance * 0.6
    const midpoint = entrance / 2
    const midpointProgress = smoothstep(midpoint / overshootDuration)
    const midpointFrame = textAnimationAtTime('bounce', midpoint, duration)

    expect(textAnimationAtTime('bounce', -0.01, duration)).toEqual({ opacity: 0, scale: 0.92, translateX: 0, translateY: 0.2 })
    expect(textAnimationAtTime('bounce', 0, duration)).toEqual({ opacity: 0, scale: 0.92, translateX: 0, translateY: 0.2 })
    expect(midpointFrame.opacity).toBeCloseTo(midpointProgress, 12)
    expect(midpointFrame.scale).toBeCloseTo(0.92 + (1.03 - 0.92) * midpointProgress, 12)
    expect(midpointFrame.translateY).toBeCloseTo(0.2 + (-0.06 - 0.2) * midpointProgress, 12)
    expect(textAnimationAtTime('bounce', overshootDuration, duration)).toEqual({ opacity: 1, scale: 1.03, translateX: 0, translateY: -0.06 })
    expect(textAnimationAtTime('bounce', entrance, duration)).toEqual({ opacity: 1, scale: 1, translateX: 0, translateY: 0 })
    expectIdentity(textAnimationAtTime('bounce', duration / 2, duration))
    expectIdentity(textAnimationAtTime('bounce', duration - 0.01, duration))
    expectIdentity(textAnimationAtTime('bounce', duration, duration))
  })

  it('shakes deterministically with a bounded decay and settles at its window end', () => {
    const duration = 2
    const window = Math.min(0.55, duration)
    const time = window / 2
    const progress = time / window
    const amplitude = (1 - progress) ** 2
    const expected = {
      opacity: 1,
      scale: 1,
      translateX: 0.025 * amplitude * Math.sin(9 * Math.PI * progress),
      translateY: 0.012 * amplitude * Math.sin(13 * Math.PI * progress)
    }

    expectIdentity(textAnimationAtTime('shake', -0.01, duration))
    expectIdentity(textAnimationAtTime('shake', 0, duration))
    expect(textAnimationAtTime('shake', time, duration)).toEqual(expected)
    expect(textAnimationAtTime('shake', time, duration)).toEqual(textAnimationAtTime('shake', time, duration))
    expectIdentity(textAnimationAtTime('shake', window, duration))
    expectIdentity(textAnimationAtTime('shake', duration / 2, duration))
    expectIdentity(textAnimationAtTime('shake', duration - 0.01, duration))
    expectIdentity(textAnimationAtTime('shake', duration, duration))

    for (let index = 0; index <= 20; index += 1) {
      const frame = textAnimationAtTime('shake', window * index / 20, duration)
      expectFiniteFrame(frame)
      expect(Math.abs(frame.translateX)).toBeLessThanOrEqual(0.025)
      expect(Math.abs(frame.translateY)).toBeLessThanOrEqual(0.012)
      expect(frame.opacity).toBe(1)
      expect(frame.scale).toBe(1)
    }
  })

  it('uses a minimum duration and keeps every preset finite for hostile inputs', () => {
    for (const preset of presets) {
      for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        for (const time of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, -1, 0, 0.0005, 1]) {
          const frame = textAnimationAtTime(preset, time, duration)
          expectFiniteFrame(frame)
          expect(frame.opacity).toBeGreaterThanOrEqual(0)
          expect(frame.opacity).toBeLessThanOrEqual(1)
          expect(frame.scale).toBeGreaterThanOrEqual(0.65)
          expect(frame.scale).toBeLessThanOrEqual(1.12)
          expect(Math.abs(frame.translateX)).toBeLessThanOrEqual(0.025)
          expect(Math.abs(frame.translateY)).toBeLessThanOrEqual(0.2)
        }
      }
    }

    expect(textAnimationAtTime('fade', 0.0005, 0.0001).opacity).toBe(1)
    expectIdentity(textAnimationAtTime('pop', 0.001, 0.0001))
    expectIdentity(textAnimationAtTime('bounce', 0.001, 0.0001))
    expectIdentity(textAnimationAtTime('shake', 0.001, 0.0001))
  })
})
