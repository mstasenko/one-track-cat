import { describe, expect, it } from 'vitest'
import { narrationDurationSamples, placeNarration, type NarrationWindow } from './narration'

const window: NarrationWindow = { id: 'speech-1', start: 1, end: 3, generatedDuration: 1.5 }

describe('Narration timing', () => {
  it('defaults to original speed and honors a selected slowdown without moving anchors', () => {
    expect(placeNarration([window], 4)[0]?.tempo).toBe(1)
    expect(placeNarration([window], 4, 0.15)).toEqual([{
      id: 'speech-1', startSample: 48_000, windowSamples: 96_000,
      generatedSamples: 72_000, tempo: 0.85, needsReview: false
    }])
  })

  it('reduces slowdown when needed and keeps exact-fit speech at normal speed', () => {
    expect(placeNarration([{ ...window, generatedDuration: 1.9 }], 4, 0.15)[0]?.tempo).toBe(0.95)
    expect(placeNarration([{ ...window, generatedDuration: 2 }], 4, 0.15)[0]?.tempo).toBe(1)
    for (const generatedDuration of [0.2, 1.5, 1.9, 2, 2.2]) {
      const result = placeNarration([{ ...window, generatedDuration }], 4, 0.15)[0]
      if (!result) throw new Error('Missing placement')
      expect(result.generatedSamples / result.tempo).toBeLessThanOrEqual(result.windowSamples)
    }
  })

  it('uses the selected slowdown while always respecting the available window', () => {
    expect(placeNarration([window], 4, 0)[0]?.tempo).toBe(1)
    expect(placeNarration([window], 4, 0.5)[0]?.tempo).toBe(0.75)
    expect(placeNarration([{ ...window, generatedDuration: 0.5 }], 4, 0.5)[0]?.tempo).toBe(0.5)
  })

  it.each([NaN, Infinity, -0.1, 0.51])('rejects invalid slowdown: %s', (slowdown) => {
    expect(() => placeNarration([window], 4, slowdown)).toThrow('slowdown')
  })

  it('allows modest acceleration without moving the video', () => {
    const placed = placeNarration([{ ...window, generatedDuration: 2.2 }], 4)
    expect(placed[0]).toMatchObject({ startSample: 48_000, windowSamples: 96_000, tempo: 1.1, needsReview: false })
  })

  it('flags overlong speech instead of silently truncating it', () => {
    expect(placeNarration([{ ...window, generatedDuration: 3 }], 4)[0]).toMatchObject({ tempo: 1.5, needsReview: true })
  })

  it('accepts adjacent windows and rounds fractional times to samples', () => {
    expect(placeNarration([
      { ...window, start: 0, end: 1 / 3, generatedDuration: 0.2 },
      { ...window, id: 'speech-2', start: 1 / 3, end: 1, generatedDuration: 0.3 }
    ], 1).map(({ startSample, windowSamples }) => [startSample, windowSamples])).toEqual([[0, 16_000], [16_000, 32_000]])
    expect(narrationDurationSamples(1001 / 30000)).toBe(1602)
  })

  it('accepts a silent timeline', () => {
    expect(placeNarration([], 4)).toEqual([])
  })

  it.each([
    { start: -1 }, { start: NaN }, { end: Infinity }, { end: 5 }, { end: 1 },
    { generatedDuration: 0 }, { generatedDuration: -1 }, { id: 'invalid;id' }
  ])('rejects invalid windows: %j', (changes) => {
    expect(() => placeNarration([{ ...window, ...changes }], 4)).toThrow('Narration')
  })

  it('rejects overlaps and duplicate IDs', () => {
    expect(() => placeNarration([window, { ...window, id: 'speech-2' }], 4)).toThrow('non-overlapping')
    expect(() => placeNarration([window, { ...window, start: 3, end: 4 }], 4)).toThrow('unique')
  })

  it.each([0, -1, NaN, Infinity, 86_401])('rejects invalid timeline duration: %s', (duration) => {
    expect(() => narrationDurationSamples(duration)).toThrow('Narration')
  })
})
