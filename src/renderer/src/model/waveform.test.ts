import { describe, expect, it } from 'vitest'
import { waveformPath } from './waveform'

describe('audio waveform', () => {
  it('keeps a single requested sample path finite', () => {
    const path = waveformPath([0.5], 0, 1, 1, 1)

    expect(path).not.toMatch(/NaN|Infinity/)
    expect(path).toBe('M0.00,11.50 L100.00,11.50 L100.00,28.50 L0.00,28.50 Z')
  })

  it('preserves quiet and loud ranges at four samples', () => {
    expect(waveformPath([0, 0, 0, 0], 0, 2, 4, 4)).toBe(
      'M0.00,20.00 L33.33,20.00 L66.67,20.00 L100.00,20.00 L100.00,20.00 L66.67,20.00 L33.33,20.00 L0.00,20.00 Z',
    )
    expect(waveformPath([0, 0, 1, 1], 2, 4, 4, 4)).toBe(
      'M0.00,3.00 L33.33,3.00 L66.67,3.00 L100.00,3.00 L100.00,37.00 L66.67,37.00 L33.33,37.00 L0.00,37.00 Z',
    )
  })

  it('renders actual peaks for the retained source range', () => {
    const quiet = waveformPath([0, 0, 0, 0], 0, 2, 4)
    const loud = waveformPath([0, 0, 1, 1], 2, 4, 4)
    expect(quiet).toContain('20.00')
    expect(loud).toContain('3.00')
    expect(loud).toContain('37.00')
  })

  it('does not invent a waveform when audio data is unavailable', () => {
    expect(waveformPath([], 0, 1, 1)).toBe('')
  })

  it('uses the requested display resolution', () => {
    expect(waveformPath([0, 0.25, 0.5, 1], 0, 1, 1, 4).match(/ L/g)).toHaveLength(7)
    expect(waveformPath([0, 0.25, 0.5, 1], 0, 1, 1, 8).match(/ L/g)).toHaveLength(15)
  })
})
