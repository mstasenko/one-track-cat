import { describe, expect, it } from 'vitest'
import { NarrationPauseError, parseNarrationPauses } from './narration-pauses'

describe('narration pause markers', () => {
  it('splits spoken parts and removes markers from subtitle text', () => {
    expect(parseNarrationPauses('Wait [500ms] for this [1.5s] now.')).toEqual({
      text: 'Wait for this now.',
      parts: [
        { text: 'Wait', pauseBefore: 0 },
        { text: 'for this', pauseBefore: 0.5 },
        { text: 'now.', pauseBefore: 1.5 }
      ],
      trailingPause: 0,
      totalPause: 2,
      hasMarkers: true
    })
  })

  it('keeps words separated when a marker has no surrounding whitespace', () => {
    expect(parseNarrationPauses('Wait[1s]now')).toMatchObject({ text: 'Wait now' })
  })

  it('supports leading, trailing, and adjacent markers', () => {
    expect(parseNarrationPauses('[1s] Wait[500ms]')).toMatchObject({
      text: 'Wait',
      parts: [{ text: 'Wait', pauseBefore: 1 }],
      trailingPause: 0.5,
      totalPause: 1.5
    })
    expect(parseNarrationPauses('[500ms][1s]Wait')).toMatchObject({
      parts: [{ text: 'Wait', pauseBefore: 1.5 }], trailingPause: 0
    })
  })

  it('keeps marker-only text empty while retaining its complete pause', () => {
    expect(parseNarrationPauses('[500ms][1s]')).toEqual({
      text: '', parts: [], trailingPause: 1.5, totalPause: 1.5, hasMarkers: true
    })
  })

  it('preserves text and marks the no-marker path', () => {
    expect(parseNarrationPauses('Wait, please.')).toEqual({
      text: 'Wait, please.', parts: [{ text: 'Wait, please.', pauseBefore: 0 }],
      trailingPause: 0, totalPause: 0, hasMarkers: false
    })
  })

  it.each(['[0ms]', '[-1s]', '[10.001s]', '[NaNs]', '[1x]', '[1s'])('rejects malformed or out-of-bounds marker %s', (marker) => {
    const value = marker === '[1s' ? `Wait ${marker}` : `Wait ${marker}`
    expect(() => parseNarrationPauses(value)).toThrow(NarrationPauseError)
  })

  it('rejects unmatched brackets and bounded totals/counts', () => {
    expect(() => parseNarrationPauses('Wait [1s')).toThrow('malformed')
    expect(() => parseNarrationPauses(`${'[1s]'.repeat(17)}Wait`)).toThrow('at most 16')
    expect(() => parseNarrationPauses('[10s][10s][10s][1ms]Wait')).toThrow('total pauses')
  })
})
