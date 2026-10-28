import { describe, expect, it } from 'vitest'
import { placeNarration, type NarrationPlacement } from './narration'
import type { NarrationPhrase } from './narration-transcript'
import { narrationSpeechTailRanges } from './narration-subtitles'

function phrase(start: number, end: number, revisedText: string, id = `phrase-${start}`): NarrationPhrase {
  return { id, start, end, text: revisedText, revisedText, needsTimingReview: false }
}

function words(...values: [number, number, string][]): { start: number; end: number; text: string }[] {
  return values.map(([start, end, text]) => ({ start, end, text }))
}

function placements(windows: { id: string; start: number; end: number; generatedDuration: number }[], duration: number): NarrationPlacement[] {
  return placeNarration(windows, duration)
}

describe('narration speech tails', () => {
  it('returns a sample-aligned candidate after every requested word matches', () => {
    const result = narrationSpeechTailRanges(
      [phrase(0, 3, 'The tool works well.')],
      words([0.2, 0.4, 'The'], [0.5, 0.7, 'tool'], [0.8, 1, 'works'], [1.1, 1.3, 'well.'],
        [1.5, 1.7, 'such'], [1.8, 2, 'as']),
      3, placements([{ id: 'phrase-0', start: 0, end: 3, generatedDuration: 2.5 }], 3)
    )
    expect(result).toHaveLength(1)
    expect(result).toEqual([[64_320, 120_000]])
  })

  it('keeps a target word that straddles the phrase start as a clipped boundary anchor', () => {
    const target = phrase(1, 3, 'The tool works well.', 'boundary')
    const take = placements([{ id: 'boundary', start: 1, end: 3, generatedDuration: 1.5 }], 3)
    const result = narrationSpeechTailRanges([target], words(
      [0.9, 1.02, 'The'], [1.1, 1.2, 'tool'], [1.25, 1.4, 'works'], [1.42, 1.5, 'well'],
      [1.7, 1.8, 'such'], [1.9, 2, 'as']), 3, take)
    expect(result).toEqual([[73_920, 120_000]])
  })

  it('does not propose a cut when target words are missing or instructions are empty', () => {
    const take = placements([{ id: 'p', start: 0, end: 3, generatedDuration: 3 }], 3)
    const target = [phrase(0, 3, 'The tool works well.', 'p')]
    expect(narrationSpeechTailRanges(target, words(
      [0.2, 0.4, 'The'], [0.5, 0.7, 'tool'], [1.1, 1.3, 'well.'], [1.5, 1.7, 'such'], [1.8, 2, 'as']), 3, take)).toEqual([])
    expect(narrationSpeechTailRanges([phrase(0, 3, '[500ms]', 'p')], words(
      [0.2, 0.4, 'unexpected'], [0.5, 0.7, 'words']), 3, take)).toEqual([])
  })

  it.each(['Done.', 'All done.'])('checks short requests only after all their words match (%s)', (text) => {
    const take = placements([{ id: 'p', start: 0, end: 3, generatedDuration: 3 }], 3)
    const raw = text === 'Done.' ? words([0.1, 0.5, 'Done.']) : words([0.1, 0.3, 'All'], [0.3, 0.5, 'done.'])
    expect(narrationSpeechTailRanges([phrase(0, 3, text, 'p')], raw, 3, take)).toEqual([[25_920, 144_000]])
    expect(narrationSpeechTailRanges([phrase(0, 3, text, 'p')], words([0.1, 0.5, 'Different.']), 3, take)).toEqual([])
  })

  it('checks unintelligible tails even when no extra words were recognized', () => {
    const take = placements([{ id: 'p', start: 0, end: 3, generatedDuration: 3 }], 3)
    expect(narrationSpeechTailRanges([phrase(0, 3, 'The tool works well.', 'p')], words(
      [0.2, 0.4, 'The'], [0.5, 0.7, 'tool'], [0.8, 1, 'works'], [1.1, 1.3, 'well.']), 3, take))
      .toEqual([[64_320, 144_000]])
  })

  it('keeps a requested pause and the words after it before considering a tail', () => {
    const take = placements([{ id: 'p', start: 0, end: 3, generatedDuration: 3 }], 3)
    expect(narrationSpeechTailRanges([phrase(0, 3, 'Keep this. [1s] Then continue.', 'p')], words(
      [0.1, 0.3, 'Keep'], [0.3, 0.5, 'this.'], [1.5, 1.7, 'Then'], [1.7, 1.9, 'continue.']), 3, take))
      .toEqual([[93_120, 144_000]])
  })

  it('requires nonoverlapping anchors and never reaches into the next phrase', () => {
    const target = [phrase(0, 2, 'The tool works.', 'first'), phrase(2, 4, 'Next phrase here.', 'next')]
    const take = placements([
      { id: 'first', start: 0, end: 2, generatedDuration: 2 },
      { id: 'next', start: 2, end: 4, generatedDuration: 2 }
    ], 4)
    const nextWords = words([0.2, 0.4, 'The'], [0.5, 0.7, 'tool'], [0.8, 1, 'works.'],
      [2.1, 2.3, 'Next'], [2.4, 2.6, 'phrase'], [2.7, 2.9, 'here.'])
    expect(narrationSpeechTailRanges(target, nextWords, 4, take)).toEqual([[49_920, 96_000], [141_120, 192_000]])

    const overlapping = words([0.2, 0.4, 'The'], [0.5, 0.7, 'tool'], [0.8, 1, 'works.'],
      [0.95, 1.2, 'such'], [1.3, 1.5, 'as'])
    const firstPhrase = target[0]
    const firstTake = take[0]
    if (!firstPhrase || !firstTake) throw new Error('Missing first placement fixture')
    expect(narrationSpeechTailRanges([firstPhrase], overlapping, 2, [firstTake])).toEqual([])
  })

  it('accepts adjacent word boundaries after a completely matched sentence', () => {
    const target = [phrase(0, 3, "Don't break it.", 'p')]
    const take = placements([{ id: 'p', start: 0, end: 3, generatedDuration: 2 }], 3)
    expect(narrationSpeechTailRanges(target, words(
      [0.1, 0.4, "Don't"], [0.4, 0.6, 'break'], [0.6, 0.8, 'it.'],
      [0.8, 1.2, 'extra'], [1.2, 1.6, 'words']), 3, take)).toEqual([[40_320, 96_000]])
  })

  it('skips only an overlapping phrase while retaining a valid tail after it', () => {
    const target = [phrase(0, 2, 'The tool works.', 'bad'), phrase(2, 4, 'Next phrase here.', 'good')]
    const take = placements([
      { id: 'bad', start: 0, end: 2, generatedDuration: 2 },
      { id: 'good', start: 2, end: 4, generatedDuration: 2 }
    ], 4)
    const raw = words([0.2, 0.4, 'The'], [0.5, 0.7, 'tool'], [0.8, 1, 'works.'],
      [1.2, 1.4, 'such'], [1.3, 1.5, 'as'],
      [2.2, 2.4, 'Next'], [2.5, 2.7, 'phrase'], [2.8, 3, 'here.'], [3.2, 3.4, 'such'], [3.5, 3.7, 'as'])
    expect(narrationSpeechTailRanges(target, raw, 4, take)).toEqual([[145_920, 192_000]])
  })

  it('retains a valid tail before a later overlapping phrase', () => {
    const target = [phrase(0, 2, 'The tool works.', 'good'), phrase(2, 4, 'Next phrase here.', 'bad')]
    const take = placements([
      { id: 'good', start: 0, end: 2, generatedDuration: 2 },
      { id: 'bad', start: 2, end: 4, generatedDuration: 2 }
    ], 4)
    const raw = words([0.2, 0.4, 'The'], [0.5, 0.7, 'tool'], [0.8, 1, 'works.'], [1.2, 1.4, 'such'], [1.5, 1.7, 'as'],
      [2.2, 2.4, 'Next'], [2.5, 2.7, 'phrase'], [2.8, 3, 'here.'], [3.2, 3.5, 'such'], [3.4, 3.7, 'as'])
    expect(narrationSpeechTailRanges(target, raw, 4, take)).toEqual([[49_920, 96_000]])
  })

  it('handles punctuation, combining stress, pause markers, malformed input, and short targets conservatively', () => {
    const take = placements([{ id: 'accented', start: 0, end: 3, generatedDuration: 2 }], 3)
    expect(narrationSpeechTailRanges([phrase(0, 3, 'Гло́хла машина, быстро. [500ms]', 'accented')], words(
      [0.2, 0.4, 'Глохла'], [0.5, 0.7, 'машина,'], [0.8, 1, 'быстро.'],
      [1.2, 1.4, 'such'], [1.5, 1.7, 'as']), 3, take)[0]).toEqual([49_920, 96_000])
    expect(narrationSpeechTailRanges([], [], 3, [])).toEqual([])
    expect(narrationSpeechTailRanges([phrase(0, 3, 'One two.', 'accented')], [], 3, take)).toEqual([])
    expect(narrationSpeechTailRanges([phrase(0, 3, 'One two three.', 'accented')], null, 3, take)).toEqual([])
    const malformedPlacement = take[0]
    if (!malformedPlacement) throw new Error('Missing malformed placement fixture')
    expect(narrationSpeechTailRanges([phrase(0, 3, 'One two three.', 'accented')], words(
      [0.2, 0.4, 'One'], [0.5, 0.7, 'two'], [0.8, 1, 'three'], [1.2, 1.4, 'extra'], [1.5, 1.7, 'words']), 3,
      [{ ...malformedPlacement, generatedSamples: 0 }])).toEqual([])
  })

  it('returns no result before allocating an oversized alignment matrix', () => {
    const text = 'x '.repeat(2_000)
    const raw = Array.from({ length: 2_000 }, (_, index) => ({ start: index / 1_000, end: index / 1_000 + 0.0005, text: 'x' }))
    const take = placements([{ id: 'large', start: 0, end: 4, generatedDuration: 4 }], 4)
    expect(narrationSpeechTailRanges([phrase(0, 4, text, 'large')], raw, 4, take)).toEqual([])
  })
})
