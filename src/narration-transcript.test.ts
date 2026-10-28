import { describe, expect, it } from 'vitest'
import { narrationPhrases, sentenceNarrationPhrases, reviseNarrationPhrases, normalizeNarrationTiming, skipUnalignedNarrationWords } from './narration-transcript'

describe('Narration transcript', () => {
  it('keeps measured speed for unchanged wording and clears it after an edit', () => {
    const original = { id: 'p', start: 0, end: 2, text: 'Original.', revisedText: 'Generated.', needsTimingReview: false, generatedTempo: 1.1 }
    const unchanged = reviseNarrationPhrases([original], [{ id: 'p', text: 'Original.', revisedText: 'Generated.' }])
    expect(unchanged[0]?.generatedTempo).toBe(1.1)
    const edited = reviseNarrationPhrases([original], [{ id: 'p', text: 'Original.', revisedText: 'New words.' }])
    expect(edited[0]?.generatedTempo).toBeUndefined()
    expect(original.generatedTempo).toBe(1.1)
  })

  it('skips only unedited single words stretched across long uncertain windows', () => {
    const stretched = { id: 'bad', start: 30.64, end: 49.35999870300293, text: 'так',
      revisedText: 'так', needsTimingReview: true }
    const valid = { id: 'next', start: 49.35999870300293, end: 60, text: 'Next sentence.',
      revisedText: 'Next sentence.', needsTimingReview: false }
    expect(skipUnalignedNarrationWords([stretched, valid])).toEqual([{ ...stretched, revisedText: '', needsTimingReview: false }, valid])
    for (const keep of [
      { ...stretched, revisedText: 'A deliberate human correction.' },
      { ...stretched, text: 'A complete meaningful sentence.', revisedText: 'A complete meaningful sentence.' },
      { ...stretched, end: 31 }, { ...stretched, end: Infinity },
      { ...stretched, start: -1 }, { ...stretched, needsTimingReview: false }
    ]) expect(skipUnalignedNarrationWords([keep, valid])).toEqual([keep, valid])
    expect(stretched.needsTimingReview).toBe(true)
  })
  it('omits unreliable short fragments without cutting neighbouring speech anchors', () => {
    const previous = { id: 'previous', start: 1260, end: 1317.9799995422363, text: 'Retained original sentence.',
      revisedText: 'Retained cleaned sentence.', referenceEnd: 1271.579999923706, needsTimingReview: false }
    const bad = { id: 'bad', start: 1316, end: 1327.7799997329712, text: 'все', revisedText: 'все', needsTimingReview: true }
    const next = { id: 'next', start: 1330, end: 1332, text: 'Next.', revisedText: 'Next.', needsTimingReview: false }
    const repaired = skipUnalignedNarrationWords(normalizeNarrationTiming([previous, bad, next]))
    expect(repaired[0]).toEqual(previous)
    expect(repaired[1]).toMatchObject({ id: 'bad', start: previous.end, end: bad.end, revisedText: '', needsTimingReview: false })
    expect(repaired[2]).toEqual(next)
    expect(normalizeNarrationTiming(repaired).every((phrase) => !phrase.needsTimingReview)).toBe(true)
    const short = { ...bad, start: 10, end: 23.00000045776369, text: '-то так', revisedText: '-то так' }
    expect(skipUnalignedNarrationWords([short])[0]).toMatchObject({ start: 10, revisedText: '', needsTimingReview: false })
    const edited = { ...bad, revisedText: 'Keep my wording.' }
    expect(skipUnalignedNarrationWords([previous, edited, next])[1]).toEqual(edited)
    // Do not guess an empty slot inside an existing sentence or skip malformed anchors.
    const contained = { ...bad, start: 1261, end: 1263 }
    expect(skipUnalignedNarrationWords([previous, contained, next])[1]).toEqual(contained)
    const zero = { ...bad, end: bad.start }
    expect(skipUnalignedNarrationWords([zero])[0]).toEqual(zero)
  })

  it('joins mid-sentence pause fragments into one original timing window before cleanup', () => {
    const fragments = narrationPhrases([
      { start: 1, end: 2, text: 'Use the wrench' },
      { start: 3, end: 4, text: 'to tighten it.' },
      { start: 4.2, end: 5, text: 'Then stop.' }
    ], 10)
    const original = structuredClone(fragments)
    const sentences = sentenceNarrationPhrases(fragments)
    expect(sentences).toHaveLength(2)
    expect(sentences[0]).toMatchObject({ id: 'phrase-0', start: 1, end: 4,
      text: 'Use the wrench to tighten it.', revisedText: 'Use the wrench to tighten it.' })
    expect(sentences[1]).toMatchObject({ start: 4.2, end: 5, text: 'Then stop.' })
    expect(fragments).toEqual(original)
  })
  it('does not mistake a hesitant ellipsis for a complete sentence', () => {
    for (const pause of ['...', '…']) {
      const phrases = narrationPhrases([{ start: 0, end: 1, text: `Машина не${pause}` },
        { start: 2, end: 3, text: 'остановилась.' }], 4)
      expect(sentenceNarrationPhrases(phrases)).toHaveLength(1)
    }
  })

  it('keeps real silence, unsafe alignment, and model limits as sentence boundaries', () => {
    for (const words of [
      [{ start: 0, end: 1, text: 'First' }, { start: 3, end: 4, text: 'then' }],
      [{ start: 0, end: 1, text: 'First' }, { start: 2, end: 2, text: 'then' }],
      [{ start: 0, end: 1, text: 'First' }, { start: 2, end: 15, text: 'then' }]
    ]) expect(sentenceNarrationPhrases(narrationPhrases(words, 16))).toHaveLength(2)
  })
  it('joins a complete 25-second sentence while retaining a short voice reference', () => {
    const texts = ['Так, сейчас я скоро сделаю сервис на машине, чтобы заменить какую-то',
      'штуку, которую нужно поменять, чтобы машина не', 'сломалась.']
    const phrases = texts.map((text, index) => ({ id: `phrase-${index}`, start: [0, 11.13, 22.22][index] ?? 0,
      end: [11.13, 22.22, 25.18][index] ?? 0, text, revisedText: text, needsTimingReview: false }))
    expect(sentenceNarrationPhrases(phrases)).toEqual([{ ...phrases[0], end: 25.18,
      text: texts.join(' '), revisedText: texts.join(' '), referenceEnd: 11.13, referenceText: texts[0] }])
    const first = phrases[0]
    if (!first) throw new Error('Missing sentence fixture')
    expect(sentenceNarrationPhrases([{ ...first, end: 59 }, { ...first, start: 59, end: 61 }])).toHaveLength(2)
    expect(sentenceNarrationPhrases(phrases.map((phrase) => ({ ...phrase, text: 'x'.repeat(1100) })))).toHaveLength(3)
  })
  it('preserves sentence anchors, original text and silent pauses', () => {
    const phrases = narrationPhrases([
      { start: 1, end: 1.3, text: ' Can' }, { start: 1.3, end: 1.4, text: ' I' },
      { start: 1.4, end: 2, text: ' start?' }, { start: 5, end: 5.4, text: ' Not' },
      { start: 5.4, end: 6, text: ' yet.' }
    ], 10)
    expect(phrases).toEqual([
      { id: 'phrase-0', start: 1, end: 2, text: 'Can I start?', revisedText: 'Can I start?', needsTimingReview: false },
      { id: 'phrase-1', start: 5, end: 6, text: 'Not yet.', revisedText: 'Not yet.', needsTimingReview: false }
    ])
  })

  it('handles Russian words, separate punctuation and missing tokenizer spaces', () => {
    const phrases = narrationPhrases([
      { start: 0, end: 0.2, text: 'Не' }, { start: 0.2, end: 0.6, text: 'включайте' },
      { start: 0.6, end: 0.7, text: '!' }
    ], 1)
    expect(phrases[0]?.text).toBe('Не включайте!')
  })

  it('splits at substantial pauses without filling them with generated speech', () => {
    const phrases = narrationPhrases([{ start: 0, end: 1, text: 'First' }, { start: 2, end: 3, text: 'then' }], 5)
    expect(phrases).toHaveLength(2)
    expect(phrases[0]?.end).toBe(1)
    expect(phrases[1]?.start).toBe(2)
  })

  it('bounds utterance duration and text for sequential voice generation', () => {
    const long = narrationPhrases(Array.from({ length: 32 }, (_, index) => ({
      start: index * 0.4, end: (index + 1) * 0.4, text: ' word'
    })), 13)
    expect(long).toHaveLength(2)
    expect(long.every((phrase) => phrase.end - phrase.start <= 12)).toBe(true)
    const text = narrationPhrases([{ start: 0, end: 1, text: 'x'.repeat(100) },
      { start: 1, end: 2, text: 'x'.repeat(100) }], 3)
    expect(text).toHaveLength(2)
  })

  it('retains a disproportionately large overlap and zero-length alignment flags', () => {
    const phrases = narrationPhrases([{ start: 0, end: 0.5, text: 'No.' },
      { start: 0.4, end: 0.6, text: ' Wait' }, { start: 0.6, end: 0.6, text: ' here' }], 1)
    expect(phrases[1]).toMatchObject({ start: 0.4, end: 0.6, needsTimingReview: true })
    expect(narrationPhrases([{ start: 0.5, end: 0.5, text: 'last' }], 1)[0])
      .toMatchObject({ start: 0.5, end: 0.5, needsTimingReview: true })
    expect(narrationPhrases([{ start: 0, end: 15, text: 'long' }], 20)[0]?.needsTimingReview).toBe(true)
  })

  it('accepts harmless word alignment inside a positive phrase window', () => {
    const words = [{ start: 0, end: 0.5, text: 'Please' },
      { start: 0.5, end: 0.5, text: ' wait' }, { start: 0.48, end: 1, text: ' here.' }]
    expect(narrationPhrases(words, 2)).toMatchObject([
      { start: 0, end: 1, text: 'Please wait here.', needsTimingReview: false }
    ])
  })

  it('repairs saved word-level flags without changing text or anchors', () => {
    const phrase = { id: 'phrase-6', start: 50.31999969482422, end: 62.079999923706055,
      text: 'Wait here.', revisedText: 'Please wait.', needsTimingReview: true }
    expect(normalizeNarrationTiming([phrase])).toEqual([{ ...phrase, needsTimingReview: false }])
    expect(phrase.needsTimingReview).toBe(true)
    expect(normalizeNarrationTiming([{ ...phrase, end: 49 }])[0]?.needsTimingReview).toBe(true)
    expect(normalizeNarrationTiming([{ ...phrase, end: 120 }])[0]?.needsTimingReview).toBe(true)
  })

  it('repairs the real small phrase-boundary overlap at the preserved next start', () => {
    const phrases = [
      { id: 'phrase-previous', start: 54.419999, end: 77.7, referenceEnd: 65.94,
        text: 'Previous text.', revisedText: 'Previous revision.', needsTimingReview: false },
      { id: 'phrase-next', start: 77.6, end: 83.94,
        text: 'Next text.', revisedText: 'Next revision.', needsTimingReview: true }
    ]
    const original = structuredClone(phrases)
    const normalized = normalizeNarrationTiming(phrases)
    expect(normalized[0]?.end).toBeCloseTo(77.6)
    expect(normalized[1]?.start).toBeCloseTo(77.6)
    expect(normalized).toMatchObject([
      { id: 'phrase-previous', start: 54.419999, referenceEnd: 65.94, needsTimingReview: false },
      { id: 'phrase-next', end: 83.94, needsTimingReview: false }
    ])
    expect(normalized.map(({ text, revisedText }) => ({ text, revisedText })))
      .toEqual(original.map(({ text, revisedText }) => ({ text, revisedText })))
    expect(phrases).toEqual(original)
    expect(normalizeNarrationTiming(normalized)).toEqual(normalized)
  })

  it('repairs exactly the overlap threshold but leaves larger overlaps blocked', () => {
    const atThreshold = [
      { id: 'a', start: 0, end: 3, text: 'A', revisedText: 'A', needsTimingReview: false },
      { id: 'b', start: 2.8, end: 5, text: 'B', revisedText: 'B', needsTimingReview: true }
    ]
    const larger = [
      { id: 'a', start: 0, end: 3, text: 'A', revisedText: 'A', needsTimingReview: false },
      { id: 'b', start: 2.799999, end: 5, text: 'B', revisedText: 'B', needsTimingReview: true }
    ]
    const repaired = normalizeNarrationTiming(atThreshold)
    expect(repaired.map(({ start, end }) => [start, end])).toEqual([[0, 2.8], [2.8, 5]])
    expect(repaired[1]?.needsTimingReview).toBe(false)
    const unchanged = normalizeNarrationTiming(larger)
    expect(unchanged.map(({ start, end }) => [start, end])).toEqual([[0, 3], [2.799999, 5]])
    expect(unchanged[1]?.needsTimingReview).toBe(true)
  })

  it('repairs a chain without moving its broad outer anchors', () => {
    const phrases = [
      { id: 'a', start: 0, end: 1, text: 'A', revisedText: 'A', needsTimingReview: false },
      { id: 'b', start: 0.9, end: 2, text: 'B', revisedText: 'B', needsTimingReview: true },
      { id: 'c', start: 1.9, end: 3, text: 'C', revisedText: 'C', needsTimingReview: true }
    ]
    const normalized = normalizeNarrationTiming(phrases)
    expect(normalized.map(({ start, end }) => [start, end])).toEqual([[0, 0.9], [0.9, 1.9], [1.9, 3]])
    expect(normalized.every((phrase) => !phrase.needsTimingReview)).toBe(true)
    expect(normalized.map(({ id }) => id)).toEqual(['a', 'b', 'c'])
  })

  it('clears a long phrase flag when the repaired boundary explains it', () => {
    const normalized = normalizeNarrationTiming([
      { id: 'a', start: 0, end: 13, text: 'A', revisedText: 'A', needsTimingReview: false },
      { id: 'b', start: 12.9, end: 26, text: 'B', revisedText: 'B', needsTimingReview: true }
    ])
    expect(normalized.map(({ start, end, needsTimingReview }) => [start, end, needsTimingReview]))
      .toEqual([[0, 12.9, false], [12.9, 26, false]])
  })

  it('does not repair malformed, reversed, nonfinite, overlong, or short-invalid windows', () => {
    const cases = [
      [
        { id: 'bad', start: 2, end: 1.95, text: 'Bad', revisedText: 'Bad', needsTimingReview: false },
        { id: 'next', start: 1.9, end: 3, text: 'Next', revisedText: 'Next', needsTimingReview: true }
      ],
      [
        { id: 'bad', start: 0, end: Number.NaN, text: 'Bad', revisedText: 'Bad', needsTimingReview: false },
        { id: 'next', start: 0.1, end: 1, text: 'Next', revisedText: 'Next', needsTimingReview: true }
      ],
      [
        { id: 'bad', start: 0, end: 61, text: 'Bad', revisedText: 'Bad', needsTimingReview: false },
        { id: 'next', start: 60.9, end: 62, text: 'Next', revisedText: 'Next', needsTimingReview: true }
      ],
      [
        { id: 'bad', start: 2, end: 2.1, text: 'Bad', revisedText: 'Bad', needsTimingReview: false },
        { id: 'next', start: 1.95, end: 2.2, text: 'Next', revisedText: 'Next', needsTimingReview: true }
      ],
      [
        { id: 'bad', start: 0, end: 0.1, text: 'Bad', revisedText: 'Bad', needsTimingReview: false },
        { id: 'next', start: 0.05, end: 0.05, text: 'Next', revisedText: 'Next', needsTimingReview: true }
      ],
      [
        { id: 'bad', start: 0, end: 0.1, text: 'Bad', revisedText: 'Bad', needsTimingReview: false },
        { id: 'next', start: 0.05, end: 0.051, text: 'Next', revisedText: 'Next', needsTimingReview: true }
      ]
    ]
    for (const phrases of cases) {
      const original = structuredClone(phrases)
      const normalized = normalizeNarrationTiming(phrases)
      expect(normalized.map(({ start, end }) => [start, end]))
        .toEqual(original.map(({ start, end }) => [start, end]))
      expect(phrases).toEqual(original)
    }
  })

  it('preserves reference bounds while repairing only when safe', () => {
    const clamped = normalizeNarrationTiming([
      { id: 'a', start: 0, end: 1, referenceEnd: 0.85,
        text: 'A', revisedText: 'A', needsTimingReview: false },
      { id: 'b', start: 0.9, end: 2, text: 'B', revisedText: 'B', needsTimingReview: true }
    ])
    expect(clamped.map(({ start, end, referenceEnd }) => [start, end, referenceEnd]))
      .toEqual([[0, 0.9, 0.85], [0.9, 2, undefined]])
    const unsafe = normalizeNarrationTiming([
      { id: 'a', start: 0, end: 1, referenceEnd: 0.95, text: 'A', revisedText: 'A', needsTimingReview: false },
      { id: 'b', start: 0.9, end: 2, referenceEnd: 0.92,
        text: 'B', revisedText: 'B', needsTimingReview: true }
    ])
    expect(unsafe.map(({ start, end, referenceEnd }) => [start, end, referenceEnd]))
      .toEqual([[0, 1, 0.95], [0.9, 2, 0.92]])
    expect(unsafe[1]?.needsTimingReview).toBe(true)
  })

  it('accepts no detected speech without hallucinating a phrase', () => {
    expect(narrationPhrases([], 1)).toEqual([])
  })

  it.each([null, {}, [null], [{ start: 0, end: NaN, text: 'hi' }],
    [{ start: -1, end: 0.5, text: 'hi' }], [{ start: 1, end: 0.5, text: 'hi' }],
    [{ start: 0, end: 2, text: 'hi' }], [{ start: 0, end: 1, text: '' }],
    [{ start: 0, end: 1, text: 'x'.repeat(161) }]].map((words, index) => ({ words, index })))('rejects malformed word set $index', ({ words }) => {
    expect(() => narrationPhrases(words, 1)).toThrow('Narration')
  })

  it.each([0, -1, NaN, Infinity, 86401])('rejects invalid duration %s', (duration) => {
    expect(() => narrationPhrases([], duration)).toThrow('narration duration')
  })

  it('bounds transcript size', () => {
    expect(() => narrationPhrases(Array(100001).fill(null), 1)).toThrow('bounded array')
    expect(() => narrationPhrases(Array.from({ length: 10001 }, () => ({ start: 0, end: 1, text: 'x'.repeat(100) })), 1))
      .toThrow('transcript is too large')
  })

  it('merges text revisions without changing anchors or originals', () => {
    const phrases = narrationPhrases([{ start: 1, end: 2, text: 'Um, wait.' }], 3)
    const original = structuredClone(phrases)
    const revised = reviseNarrationPhrases(phrases, [{ id: 'phrase-0', text: 'Um, wait.', revisedText: ' Wait. ' }])
    expect(revised[0]).toEqual({ ...phrases[0], revisedText: 'Wait.' })
    expect(phrases).toEqual(original)
    expect(reviseNarrationPhrases(phrases, [{ id: 'phrase-0', text: 'Um, wait.', revisedText: 'x'.repeat(2048) }])[0]?.revisedText)
      .toHaveLength(2048)
  })

  it('rejects missing, mismatched or overlong revisions', () => {
    const phrases = narrationPhrases([{ start: 0, end: 1, text: 'Wait.' }], 2)
    expect(() => reviseNarrationPhrases(phrases, [])).toThrow('preserve every phrase')
    for (const patch of [{ id: 'other' }, { text: 'Changed original' }, { revisedText: 'x'.repeat(2049) }]) {
      expect(() => reviseNarrationPhrases(phrases, [{ id: 'phrase-0', text: 'Wait.', revisedText: 'Wait.', ...patch }]))
        .toThrow('change only short revised text')
    }
  })

  it('accepts blank human revisions without changing phrase anchors or original text', () => {
    const phrases = narrationPhrases([
      { start: 1, end: 2, text: 'Wait.' }, { start: 3, end: 4, text: 'Stop.' }
    ], 5)
    const original = structuredClone(phrases)
    const revised = reviseNarrationPhrases(phrases, phrases.map((phrase) => ({
      id: phrase.id, text: phrase.text, revisedText: ' \t'
    })))
    expect(revised).toEqual(phrases.map((phrase) => ({ ...phrase, revisedText: '' })))
    expect(revised.map(({ id, text, start, end }) => ({ id, text, start, end })))
      .toEqual(original.map(({ id, text, start, end }) => ({ id, text, start, end })))
    expect(phrases).toEqual(original)
  })
})
