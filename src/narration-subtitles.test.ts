import { placeNarration } from './narration'
import { describe, expect, it } from 'vitest'
import type { NarrationPhrase } from './narration-transcript'
import { narrationSubtitleLines } from './narration-subtitles'

function phrase(start: number, end: number, revisedText: string, id = `phrase-${start}`): NarrationPhrase {
  return { id, start, end, text: revisedText, revisedText, needsTimingReview: false }
}

function words(...values: [number, number, string][]): { start: number; end: number; text: string }[] {
  return values.map(([start, end, text]) => ({ start, end, text }))
}

describe('narration subtitles', () => {
  it('omits pause markers while following the actual spoken word times', () => {
    const lines = narrationSubtitleLines([phrase(0, 4, '[500ms] Wait. [1s] Now. [250ms]')],
      words([0.5, 1, 'Wait.'], [2, 2.5, 'Now.']), 4)
    expect(lines).toEqual([{ start: 0.5, end: 1, text: 'Wait.' }, { start: 2, end: 2.5, text: 'Now.' }])
    expect(narrationSubtitleLines([phrase(0, 4, '[1s]')], [], 4)).toEqual([])
  })

  it('uses bounded word estimates when a whole caption line was missed by recognition', () => {
    const lines = narrationSubtitleLines([phrase(0, 2, 'First, missing words final.')],
      words([0.1, 0.3, 'First'], [0.7, 0.9, 'final']), 2, 13)
    expect(lines.map((line) => line.text).join(' ')).toBe('First, missing words final.')
    const middle = lines.find((line) => line.text === 'missing words')
    expect(middle?.start).toBeGreaterThanOrEqual(0.3)
    expect(middle?.end).toBeLessThanOrEqual(0.7)
    expect((middle?.end ?? 0) - (middle?.start ?? 0)).toBeGreaterThan(0)
  })

  it('times an unrecognized opening sentence from the fixed phrase start', () => {
    const text = "So... we'll disassemble only what's absolutely necessary."
    const lines = narrationSubtitleLines([phrase(54.42, 60, text)],
      words([56.84, 57.24, "what's"], [57.24, 57.68, 'absolutely'], [57.68, 58.24, 'necessary']), 60)
    expect(lines.map((line) => line.text).join(' ')).toBe(text)
    expect(lines[0]).toMatchObject({ start: 54.42, text: 'So...' })
    expect(lines.every((line) => line.end > line.start)).toBe(true)
    expect(lines.at(-1)?.end).toBe(58.24)
  })

  it('keeps missed closing words inside the last observed speech interval', () => {
    const lines = narrationSubtitleLines([phrase(0, 20, 'First. Missing ending.')], words([0.2, 1, 'First']), 20, 15)
    expect(lines.map((line) => line.text).join(' ')).toBe('First. Missing ending.')
    expect(lines.every((line) => line.end > line.start && line.end <= 1)).toBe(true)
  })

  it('shares the first observed interval when missing opening words have no lead-in', () => {
    const lines = narrationSubtitleLines([phrase(0, 2, 'Missing. First.')], words([0, 1, 'First']), 2)
    expect(lines).toEqual([{ start: 0, end: 0.5, text: 'Missing.' }, { start: 0.5, end: 1, text: 'First.' }])
  })

  it('partitions a multi-token ASR record when wrapping a caption', () => {
    const lines = narrationSubtitleLines([phrase(0, 2, 'alpha beta!')],
      words([0.5, 1.5, 'alpha beta!']), 2, 5)
    expect(lines).toEqual([
      { start: 0.5, end: 1, text: 'alpha' },
      { start: 1, end: 1.5, text: 'beta!' }
    ])
  })

  it('fills a zero-gap missing word from the following observed anchor', () => {
    const lines = narrationSubtitleLines([phrase(0, 2, "first... second... It's claimed.")],
      words([0.2, 0.5, 'first'], [0.5, 1.5, "It's"], [1.5, 1.8, 'claimed.']), 2, 8)
    expect(lines).toEqual([
      { start: 0.2, end: 0.5, text: 'first...' },
      { start: 0.5, end: 1, text: 'second...' },
      { start: 1, end: 1.5, text: "It's" },
      { start: 1.5, end: 1.8, text: 'claimed.' }
    ])
  })

  it('keeps the repeated missing since caption from the reconstructed speech case', () => {
    const text = "They say it's not necessary, but since... since... It's claimed that..."
    const lines = narrationSubtitleLines([phrase(0, 20, text)], words(
      [7.58, 8.3, 'They'], [8.3, 8.8, 'say'], [8.8, 9.02, "it's"],
      [9.02, 9.24, 'not'], [9.24, 9.8, 'necessary'], [9.8, 11.08, 'but'],
      [11.08, 11.62, 'since'], [11.62, 13.9, "it's"], [13.9, 14.26, 'claimed'],
      [14.26, 14.7, 'that.']), 20)
    expect(lines.map(({ text: value }) => value)).toEqual([
      "They say it's not necessary, but since...", 'since...', "It's claimed that..."
    ])
    const missing = lines[1]
    const following = lines[2]
    expect(missing?.start).toBeCloseTo(11.62)
    expect(missing?.end).toBeCloseTo(12.76)
    expect(following?.start).toBeCloseTo(missing?.end ?? 0)
    expect(following?.end).toBeCloseTo(14.7)
  })

  it('keeps repeated words aligned after recognition changes a contraction', () => {
    const text = "We'll use a wrench, which we'll also need for clamps holding everything in place. Then we'll finish."
    const recognized = "We'll use a wrench which will also need for clamps holding everything in place Then we'll finish".split(' ')
    const raw = recognized.map((text, index) => ({ text, start: index * 0.3, end: (index + 1) * 0.3 }))
    const lines = narrationSubtitleLines([phrase(0, 6, text)], raw, 6, 24)
    expect(lines.map((line) => line.text).join(' ')).toBe(text)
    const middle = lines.find((line) => line.text.includes('holding'))
    expect(middle?.start).toBeLessThan(4)
    expect(middle?.end).toBeLessThanOrEqual(4.2)
  })

  it('rejects an oversized alignment before allocating its matrix', () => {
    expect(() => narrationSubtitleLines([phrase(0, 1, 't '.repeat(1999))],
      Array.from({ length: 2100 }, () => ({ text: 't', start: 0, end: 0.1 })), 1))
      .toThrow('phrase alignment is too large')
  })

  it('bounds total alignment work across many phrases', () => {
    const phrases = Array.from({ length: 5 }, (_, index) => phrase(index, index + 1, 't '.repeat(1998)))
    const raw = phrases.flatMap((item) => Array.from({ length: 1999 }, () => ({ text: 't', start: item.start, end: item.start + 0.1 })))
    expect(() => narrationSubtitleLines(phrases, raw, 5)).toThrow('total subtitle alignment is too large')
  })

  it('keeps a missed word inside a line without inventing a long pause', () => {
    expect(narrationSubtitleLines([phrase(0, 3, 'Please wait here.')],
      words([0.2, 0.5, 'Please'], [0.9, 1.1, 'here.']), 3)).toEqual([
      { start: 0.2, end: 1.1, text: 'Please wait here.' }
    ])
  })

  it('omits blank reviewed phrases and retains their anchors as window boundaries', () => {
    const lines = narrationSubtitleLines([
      phrase(0, 1, 'First.'), phrase(1, 1.5, ' \t'), phrase(1.5, 3, 'Third.')
    ], words([0.1, 0.3, 'First.'], [1.1, 1.3, 'hallucination'], [1.6, 1.9, 'Third.']), 3)
    expect(lines).toEqual([
      { start: 0.1, end: 0.3, text: 'First.' },
      { start: 1.6, end: 1.9, text: 'Third.' }
    ])
  })

  it('returns no subtitles when every reviewed phrase is blank, including with no words', () => {
    expect(narrationSubtitleLines([phrase(0, 1, ' '), phrase(1, 2, '\t')], [], 2)).toEqual([])
    expect(() => narrationSubtitleLines([phrase(0, 1, ' ')], [{ start: 0.5, end: 0.4, text: 'bad' }], 1))
      .toThrow('Narration subtitle alignment error')
  })

  it('uses generated-speech anchors and preserves English punctuation', () => {
    const lines = narrationSubtitleLines(
      [phrase(0, 3, 'Hello, world! This is a test.')],
      words([0.2, 0.5, 'Hello,'], [0.55, 0.8, 'world!'], [1.1, 1.3, 'This'],
        [1.35, 1.5, 'is'], [1.55, 1.7, 'a'], [1.75, 2.1, 'test.']),
      3
    )
    expect(lines).toEqual([
      { start: 0.2, end: 0.8, text: 'Hello, world!' },
      { start: 1.1, end: 2.1, text: 'This is a test.' }
    ])
  })

  it('keeps leading and trailing display punctuation', () => {
    const lines = narrationSubtitleLines(
      [phrase(0, 1, '“Wait!”')],
      words([0.1, 0.4, 'Wait!']),
      1
    )
    expect(lines).toEqual([{ start: 0.1, end: 0.4, text: '“Wait!”' }])
  })

  it('removes combining stress marks while retaining Russian display text', () => {
    const lines = narrationSubtitleLines(
      [phrase(0, 2, 'Гло́хла машина.')],
      words([0.1, 0.5, 'Гло́хла'], [0.55, 0.9, 'машина.']),
      2
    )
    expect(lines).toEqual([{ start: 0.1, end: 0.9, text: 'Глохла машина.' }])
  })

  it('uses measured generated speech when recognition misses an entire phrase', () => {
    const phrases = [phrase(1, 2, 'Check the fit.')]
    const generated = placeNarration([{ id: phrases[0]?.id ?? '', start: 1, end: 10, generatedDuration: 1 }], 10)
    const lines = narrationSubtitleLines(phrases, [], 10, 44, generated)
    expect(lines).toEqual([{ start: 1, end: 2, text: 'Check the fit.' }])
    expect(() => narrationSubtitleLines(phrases, [], 10)).toThrow('alignment')
    expect(() => narrationSubtitleLines(phrases, [], 10, 44,
      generated.map((take) => ({ ...take, generatedSamples: Infinity })))).toThrow('invalid subtitle timing')
  })

  it('keeps captions inside actual generated speech rather than its unused pause', () => {
    const phrases = [phrase(0, 8, 'Hello there.')]
    const generated = placeNarration([{ id: phrases[0]?.id ?? '', start: 0, end: 10, generatedDuration: 1 }], 10)
    const lines = narrationSubtitleLines(phrases, words([0.1, 0.3, 'Hello'], [0.4, 8, 'there.']), 10, 44, generated)
    expect(lines).toEqual([{ start: 0.1, end: 1, text: 'Hello there.' }])
  })

  it('retains a word whose ASR midpoint falls just before its fixed phrase start', () => {
    const lines = narrationSubtitleLines([
      phrase(85.28, 86.54, 'Nothing even broke.'), phrase(90.98, 91.38, 'Okay.')
    ], words([85.4, 85.68, 'Nothing'], [85.68, 86.04, 'even'], [86.04, 86.48, 'broke.'],
      [90.64, 91.24, 'Okay,']), 93)
    expect(lines.at(-1)).toEqual({ start: 90.98, end: 91.24, text: 'Okay.' })
  })

  it('ignores zero-duration ASR tokens while retaining reviewed caption words', () => {
    const lines = narrationSubtitleLines([phrase(0, 2, "It's loose now.")], words(
      [0, 0, 'Dan'], [0, 0, 'Bothells,'], [0.1, 0.4, "It's"], [0.4, 0.8, 'loose'], [0.8, 0.8, 'now.']
    ), 2)
    expect(lines.map((line) => line.text).join(' ')).toBe("It's loose now.")
    expect(lines.every((line) => line.end > line.start && line.end <= 2)).toBe(true)
    expect(() => narrationSubtitleLines([phrase(0, 2, 'Wait.')], words([0, 0, 'Wait.']), 2)).toThrow('alignment')
  })

  it('filters a hallucinated prefix instead of using it as the subtitle start', () => {
    const lines = narrationSubtitleLines(
      [phrase(0, 2, 'Today we test.')],
      words([0, 0.1, 'ko'], [0.2, 0.45, 'Today'], [0.5, 0.7, 'we'], [0.75, 1, 'test.']),
      2
    )
    expect(lines).toEqual([{ start: 0.2, end: 1, text: 'Today we test.' }])
  })

  it('breaks at a long generated pause without extending the first line through silence', () => {
    const lines = narrationSubtitleLines(
      [phrase(0, 4, 'First part, then final.')],
      words([0.1, 0.35, 'First'], [0.4, 0.65, 'part,'], [2, 2.25, 'then'], [2.3, 2.7, 'final.']),
      4
    )
    expect(lines).toEqual([
      { start: 0.1, end: 0.65, text: 'First part,' },
      { start: 2, end: 2.7, text: 'then final.' }
    ])
  })

  it('uses generated timings when they differ from the source phrase anchors', () => {
    const lines = narrationSubtitleLines(
      [phrase(0, 2, 'One two three.')],
      words([0.7, 0.9, 'One'], [1, 1.2, 'two'], [1.25, 1.6, 'three.']),
      2
    )
    expect(lines[0]).toEqual({ start: 0.7, end: 1.6, text: 'One two three.' })
    expect(lines[0]?.start).not.toBe(0)
  })

  it('wraps long text at readable word boundaries and allows a long word', () => {
    const text = 'This is a reasonably long caption line that wraps cleanly.'
    const raw = words(
      [0.1, 0.2, 'This'], [0.25, 0.35, 'is'], [0.4, 0.5, 'a'], [0.55, 0.75, 'reasonably'],
      [0.8, 1, 'long'], [1.05, 1.25, 'caption'], [1.3, 1.5, 'line'], [1.55, 1.75, 'that'],
      [1.8, 2, 'wraps'], [2.05, 2.25, 'cleanly.']
    )
    const lines = narrationSubtitleLines([phrase(0, 3, text)], raw, 3, 24)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((line) => line.text.length <= 24)).toBe(true)
    expect(lines.map((line) => line.text).join(' ')).toBe(text)
    expect(() => narrationSubtitleLines([phrase(0, 1, 'Supercalifragilisticexpialidocious.')],
      words([0.1, 0.3, 'Supercalifragilisticexpialidocious.']), 1, 10)).not.toThrow()
  })

  it.each([
    ['bad duration', [phrase(0, 1, 'Wait.')], words([0, 0.2, 'Wait.']), 0],
    ['bad raw shape', [phrase(0, 1, 'Wait.')], null, 1],
    ['bad raw timestamps', [phrase(0, 1, 'Wait.')], words([0.5, 0.4, 'Wait.']), 1],
    ['no matching anchors', [phrase(0, 1, 'Wait.')], words([0, 0.2, 'ko']), 1],
    ['bad phrase timing', [phrase(0, 1, 'Wait.'), phrase(0.5, 1.2, 'Again.')], words([0, 0.2, 'Wait.']), 2]
  ])('rejects %s with a clear alignment error', (_name, phrases, raw, duration) => {
    expect(() => narrationSubtitleLines(phrases, raw, duration)).toThrow('Narration subtitle alignment error')
  })
})
