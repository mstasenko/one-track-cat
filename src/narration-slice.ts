import type { NarrationReview } from './narration-api'
import { narrationMaxReferenceSeconds, narrationSampleRate } from './narration'

const sampleTolerance = 1 / narrationSampleRate

function validate(draft: NarrationReview, range: readonly [number, number], sourceIn: number): number {
  const [draftStart, draftEnd] = draft.range
  const draftDuration = draftEnd - draftStart
  const [rangeStart, rangeEnd] = range
  const duration = rangeEnd - rangeStart
  if (!Number.isFinite(draftStart) || !Number.isFinite(draftEnd) || draftDuration <= 0 ||
      !Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || duration <= 0 ||
      !Number.isFinite(sourceIn) || sourceIn < 0 || duration > draftDuration + sampleTolerance ||
      sourceIn > draftDuration + sampleTolerance || sourceIn + duration > draftDuration + sampleTolerance) {
    throw new Error('Invalid narration slice')
  }

  for (const phrase of draft.phrases) {
    if (typeof phrase.id !== 'string' || typeof phrase.text !== 'string' ||
        typeof phrase.revisedText !== 'string' || !Number.isFinite(phrase.start) ||
        !Number.isFinite(phrase.end) || phrase.start < -sampleTolerance || phrase.end <= phrase.start ||
        phrase.end > draftDuration + sampleTolerance ||
        (phrase.referenceEnd !== undefined &&
          (!Number.isFinite(phrase.referenceEnd) || phrase.referenceEnd <= phrase.start ||
            phrase.referenceEnd > phrase.end || phrase.referenceEnd - phrase.start > narrationMaxReferenceSeconds)) ||
        (phrase.referenceText !== undefined && typeof phrase.referenceText !== 'string')) {
      throw new Error('Invalid narration slice')
    }
  }
  return draftDuration
}

/** Project a saved review onto one source-relative fragment without mutating it. */
export function sliceNarrationReview(
  draft: NarrationReview,
  range: readonly [number, number],
  sourceIn: number
): NarrationReview {
  const draftDuration = validate(draft, range, sourceIn)
  const duration = range[1] - range[0]
  const sourceStart = Math.min(sourceIn, draftDuration)
  const sourceEnd = Math.min(draftDuration, sourceStart + duration)
  const partialIds = new Set<string>()
  const phrases = draft.phrases.flatMap((phrase) => {
    // Physical cuts may retain either side of a phrase. Keep the complete
    // saved transcript for every positively overlapping acoustic window;
    // only the local timing is clipped. Mark-based start ownership is applied
    // separately by the panel before this source slicer is called.
    const overlapStart = Math.max(sourceStart, phrase.start)
    const overlapEnd = Math.min(sourceEnd, phrase.end)
    if (overlapEnd - overlapStart < sampleTolerance) return []
    if (overlapStart > phrase.start + sampleTolerance || overlapEnd < phrase.end - sampleTolerance) partialIds.add(phrase.id)
    const start = Math.max(0, phrase.start - sourceStart)
    const end = Math.min(sourceEnd - sourceStart, phrase.end - sourceStart)

    const { referenceEnd, referenceText, generatedTempo, ...withoutReference } = phrase
    // Keep a trusted short anchor only while its original endpoint remains in
    // this retained window. A text-only anchor has no bounded endpoint, so it
    // is retained only when the complete phrase remains in this piece. Never
    // invent a reference by proportionally slicing transcript text; the
    // draft's global voice sample is unchanged.
    const referenceInside = referenceEnd === undefined
      ? phrase.start >= sourceStart - sampleTolerance && sourceEnd >= phrase.end - sampleTolerance
      : phrase.start >= sourceStart - sampleTolerance && referenceEnd <= sourceEnd + sampleTolerance &&
        referenceEnd > sourceStart + sampleTolerance
    const reference = referenceInside
      ? {
          ...(referenceEnd === undefined ? {} : { referenceEnd: referenceEnd - sourceStart }),
          ...(referenceText === undefined ? {} : { referenceText })
        }
      : {}
    const generated = !partialIds.has(phrase.id) && generatedTempo !== undefined ? { generatedTempo } : {}
    return [{ ...withoutReference, start, end, ...reference, ...generated }]
  })
  const overruns = draft.overruns?.filter((issue) =>
    // The wording is preserved, but old fit estimates no longer describe a cut window.
    !partialIds.has(issue.id) && phrases.some((phrase) => phrase.id === issue.id))
  const slicedRange: [number, number] = [range[0], range[1]]
  return { ...draft, range: slicedRange, phrases, ...(overruns ? { overruns } : {}) }
}
