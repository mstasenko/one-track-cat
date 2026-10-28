import { describe, expect, it } from 'vitest'
import type { NarrationReview } from './narration-api'
import { sliceNarrationReview } from './narration-slice'

const draft: NarrationReview = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  stage: 'cleaned',
  approved: true,
  contentKey: 'audio-v2:test',
  range: [10, 20],
  language: 'en',
  strength: 'balanced',
  originalPath: '/original.wav',
  speechPath: '/speech.wav',
  backgroundPath: '/background.wav',
  phrases: [
    { id: 'phrase-0', start: 1, end: 3, text: 'alpha beta gamma', revisedText: 'A B C', needsTimingReview: false,
      referenceEnd: 2, referenceText: 'alpha beta' },
    { id: 'phrase-1', start: 4, end: 7, text: 'delta epsilon zeta', revisedText: '', needsTimingReview: false },
    { id: 'phrase-2', start: 8, end: 9, text: 'eta theta', revisedText: 'ETA THETA', needsTimingReview: false }
  ],
  overruns: [
    { id: 'phrase-0', text: 'A B C', extraSeconds: 0.2 },
    { id: 'phrase-2', text: 'ETA THETA', extraSeconds: 0.3 },
    { id: 'missing', text: 'Missing', extraSeconds: 0.4 }
  ]
}

describe('sliceNarrationReview', () => {
  it('leaves an uncut full review unchanged while accepting a new timeline range', () => {
    const result = sliceNarrationReview(draft, [30, 40], 0)
    expect(result).toEqual({ ...draft, range: [30, 40], overruns: draft.overruns?.slice(0, 2) })
    expect(result.id).toBe(draft.id)
    expect(result.phrases).toEqual(draft.phrases)
    expect(result.overruns).toEqual(draft.overruns?.slice(0, 2))
  })

  it('keeps independent siblings and scopes their timing overruns', () => {
    const left = sliceNarrationReview(draft, [0, 4], 0)
    const right = sliceNarrationReview(draft, [4, 10], 4)
    expect(left.phrases.map(({ id }) => id)).toEqual(['phrase-0'])
    expect(left.phrases[0]).toMatchObject({ start: 1, end: 3, text: 'alpha beta gamma', revisedText: 'A B C' })
    expect(left.overruns).toEqual([draft.overruns?.[0]])
    expect(right.phrases.map(({ id }) => id)).toEqual(['phrase-1', 'phrase-2'])
    expect(right.phrases[0]).toMatchObject({ start: 0, end: 3, text: 'delta epsilon zeta', revisedText: '' })
    expect(right.phrases[1]).toMatchObject({ start: 4, end: 5, text: 'eta theta', revisedText: 'ETA THETA' })
    expect(right.overruns).toEqual([draft.overruns?.[1]])
    expect(left.phrases[0]?.id).not.toBe(right.phrases[0]?.id)
  })

  it('keeps the whole text for every positively overlapping acoustic piece', () => {
    const result = sliceNarrationReview(draft, [0, 4], 2)
    expect(result.range).toEqual([0, 4])
    expect(result.phrases.map(({ id }) => id)).toEqual(['phrase-0', 'phrase-1'])
    expect(result.phrases[0]).toMatchObject({ start: 0, end: 1, text: 'alpha beta gamma', revisedText: 'A B C' })
    expect(result.phrases[1]).toMatchObject({ start: 2, end: 4, text: 'delta epsilon zeta', revisedText: '' })
    expect(result.overruns).toEqual([])

    const first = sliceNarrationReview({ ...draft, range: [0, 4], phrases: draft.phrases.slice(0, 1) }, [0, 2], 0)
    const second = sliceNarrationReview({ ...draft, range: [0, 4], phrases: draft.phrases.slice(0, 1) }, [2, 4], 2)
    expect(first.phrases[0]).toMatchObject({ start: 1, end: 2, text: 'alpha beta gamma', revisedText: 'A B C' })
    expect(second.phrases[0]).toMatchObject({ start: 0, end: 1, text: 'alpha beta gamma', revisedText: 'A B C' })
  })

  it('preserves an empty revised phrase instead of forcing original words into it', () => {
    const result = sliceNarrationReview(draft, [0, 6], 4)
    expect(result.phrases[0]?.revisedText).toBe('')
  })

  it('does not duplicate words when splitting a long review at its original phrase anchors', () => {
    const start = 433.746966666666
    const first = draft.phrases[0]
    if (!first) throw new Error('Missing phrase')
    const phrase = { ...first, start: 201.58, end: 227.49200009536744,
      revisedText: "Keep my wording. [1s] And this pause.", referenceEnd: undefined, referenceText: undefined }
    const long = { ...draft, range: [start, 1777.399492333332] as [number, number], phrases: [phrase] }
    const points = [start, start + phrase.start, start + phrase.end, long.range[1]]
    const pieces = points.slice(0, -1).map((point, index) => {
      const end = points[index + 1]
      if (end === undefined) throw new Error('Missing endpoint')
      return sliceNarrationReview(long, [point, end], point - start)
    })
    expect(pieces.map((piece) => piece.phrases.length)).toEqual([0, 1, 0])
    expect(pieces[1]?.phrases[0]).toMatchObject({ id: phrase.id, text: phrase.text, revisedText: phrase.revisedText })
    const middle = pieces[1]?.phrases[0]
    const middleStart = points[1]
    if (!middle || middleStart === undefined) throw new Error('Missing middle phrase')
    expect(middle.start + middleStart).toBeCloseTo(start + phrase.start, 8)
    expect(middle.end + middleStart).toBeCloseTo(start + phrase.end, 8)
  })

  it('keeps a whole edited phrase when the retained piece ends inside its audio', () => {
    const original = draft.phrases[0]
    if (!original) throw new Error('Missing phrase')
    const phrase = { ...original, start: 201.58, end: 227.49200009536744,
      revisedText: "We'll try to fix this sticking now. [1s] I'll apply throttle-body cleaner here.",
      referenceEnd: undefined, referenceText: undefined }
    const voiceReference = { path: '/speech.wav', start: 0, end: 30, text: 'Global speaker sample.' }
    const long = { ...draft, range: [0, 300] as [number, number], voiceReference, phrases: [phrase] }
    const result = sliceNarrationReview(long, [0, 12.10315], 201.58)
    expect(result.voiceReference).toEqual(voiceReference)
    expect(result.phrases).toEqual([{ ...phrase, start: 0, end: 12.10315 }])
  })

  it('preserves wording through repeated cuts and timeline relocation', () => {
    const phrase = { id: 'edited', start: 2, end: 8, text: 'Original sentence.',
      revisedText: 'My edited sentence. [1s] Keep its ending.', needsTimingReview: false }
    const original = { ...draft, phrases: [phrase] }
    // Retain the middle of the acoustic window, then cut it again after an insertion.
    const first = sliceNarrationReview(original, [30, 35], 1)
    const second = sliceNarrationReview(first, [50, 52], 2)
    expect(second.phrases).toEqual([{ ...phrase, start: 0, end: 2 }])
    expect(first.phrases).toEqual([{ ...phrase, start: 1, end: 5 }])
    expect(original.phrases).toEqual([phrase])
  })

  it('retains trusted references only while their anchors stay in the piece', () => {
    const retained = sliceNarrationReview(draft, [0, 4], 0)
    expect(retained.phrases[0]).toMatchObject({ referenceEnd: 2, referenceText: 'alpha beta' })

    const original = draft.phrases[1]
    if (!original) throw new Error('Missing phrase')
    const phraseWithReference = { ...original, referenceEnd: 5, referenceText: 'delta' }
    const clipped = sliceNarrationReview({ ...draft, phrases: [phraseWithReference] }, [0, 1.5], 4)
    expect(clipped.phrases[0]).toMatchObject({ start: 0, end: 1.5, text: 'delta epsilon zeta', referenceEnd: 1, referenceText: 'delta' })

    const textOnlyAnchor = sliceNarrationReview({ ...draft, phrases: [{ ...original, referenceText: 'delta' }] }, [0, 3], 4)
    expect(textOnlyAnchor.phrases[0]).toMatchObject({ start: 0, end: 3, referenceText: 'delta' })

    const anchorOutside = sliceNarrationReview({ ...draft, phrases: [phraseWithReference] }, [0, 0.75], 4)
    expect(anchorOutside.phrases[0]).not.toHaveProperty('referenceEnd')
    expect(anchorOutside.phrases[0]).not.toHaveProperty('referenceText')
    expect(anchorOutside.phrases[0]?.text).toBe('delta epsilon zeta')

    const leftCut = sliceNarrationReview({ ...draft, phrases: [phraseWithReference] }, [0, 1], 4.5)
    expect(leftCut.phrases[0]?.text).toBe('delta epsilon zeta')
    expect(leftCut.phrases[0]).not.toHaveProperty('referenceEnd')
    expect(leftCut.phrases[0]).not.toHaveProperty('referenceText')

    const long: NarrationReview = { ...draft, range: [0, 30], phrases: draft.phrases.slice(0, 1).map((phrase) => ({
      ...phrase, start: 5, end: 25, referenceEnd: 7, referenceText: 'alpha'
    })) }
    const bounded = sliceNarrationReview(long, [0, 20], 5).phrases[0]
    expect(bounded?.referenceEnd).toBeLessThanOrEqual(12)
  })

  it('drops a measured tempo when a cut changes the phrase window', () => {
    const phrase = draft.phrases[0]
    if (!phrase) throw new Error('Missing phrase')
    const reviewed = { ...draft, phrases: [{ ...phrase, generatedTempo: 1.08 }] }
    expect(sliceNarrationReview(reviewed, [0, 1.5], 0).phrases[0]).not.toHaveProperty('generatedTempo')
    expect(sliceNarrationReview(reviewed, [0, 3], 0).phrases[0]?.generatedTempo).toBe(1.08)
  })

  it('preserves a measured tempo when a complete phrase is shifted', () => {
    const phrase = draft.phrases[1]
    if (!phrase) throw new Error('Missing phrase')
    const reviewed = { ...draft, phrases: [{ ...phrase, generatedTempo: 1.08 }] }
    const result = sliceNarrationReview(reviewed, [20, 28], 2)
    expect(result.phrases[0]).toMatchObject({ start: 2, end: 5, generatedTempo: 1.08 })
  })

  it.each([
    ['negative source offset', [0, 1] as const, -0.01],
    ['non-finite source offset', [0, 1] as const, Number.NaN],
    ['empty range', [2, 2] as const, 0],
    ['range too long', [0, 10.01] as const, 0],
    ['source window too long', [0, 5] as const, 6]
  ])('rejects %s', (_name, range, sourceIn) => {
    expect(() => sliceNarrationReview(draft, range, sourceIn)).toThrow('Invalid narration slice')
  })

  it('accepts one-sample endpoint rounding but rejects a larger overflow', () => {
    const tolerance = 1 / 48_000
    expect(sliceNarrationReview(draft, [0, 10 + tolerance], 0).range).toEqual([0, 10 + tolerance])
    expect(() => sliceNarrationReview(draft, [0, 10 + tolerance * 2], 0)).toThrow('Invalid narration slice')
  })
})
