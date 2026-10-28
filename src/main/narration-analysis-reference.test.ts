import { describe, expect, it } from 'vitest'
import { narrationVoiceReference, type NarrationDraft } from './narration-analysis'

function voiceDraft(phrases: NarrationDraft['phrases'], voiceReference?: NarrationDraft['voiceReference']): NarrationDraft {
  return { contentKey: 'key', range: [0, 20], language: 'en', strength: 'balanced', originalPath: '/original.wav',
    speechPath: '/speech.wav', backgroundPath: '/background.wav', phrases, approved: true,
    ...(voiceReference === undefined ? {} : { voiceReference }) }
}

describe('Narration voice reference', () => {
  it('skips an unreliable long fragment and invalid candidates', () => {
    const draft = voiceDraft([
      { id: 'long', start: 0, end: 13, text: 'Long.', revisedText: 'Long.', needsTimingReview: false },
      { id: 'flagged', start: 13, end: 14, text: 'Flagged.', revisedText: 'Flagged.', needsTimingReview: true },
      { id: 'corrupt', start: 14, end: 16, referenceEnd: 17, text: '', revisedText: 'Corrupt.', needsTimingReview: false },
      { id: 'valid', start: 16, end: 18, text: 'First valid.', revisedText: 'Edited.', needsTimingReview: false }
    ])
    expect(narrationVoiceReference(draft)).toEqual({ path: '/speech.wav', start: 16, end: 18, text: 'First valid.' })
  })

  it('uses the complete original phrase instead of its short anchor', () => {
    const draft = voiceDraft([{ id: 'merged', start: 1, end: 20, referenceEnd: 2, referenceText: 'Short original',
      text: 'Original complete sentence.', revisedText: 'Edited complete sentence.', needsTimingReview: false }])
    expect(narrationVoiceReference(draft)).toEqual({ path: '/speech.wav', start: 1, end: 20, text: 'Original complete sentence.' })
  })

  it('keeps a trusted short anchor for a long one-word fragment', () => {
    const draft = { ...voiceDraft([{ id: 'uncertain', start: 3, end: 21, referenceEnd: 4, referenceText: 'так',
      text: 'так', revisedText: "It's loose now.", needsTimingReview: false }]), range: [0, 30] as [number, number] }
    expect(narrationVoiceReference(draft)).toEqual({ path: '/speech.wav', start: 3, end: 4, text: 'так' })
  })

  it('merges adjacent original phrases toward the target without revised wording', () => {
    const draft = { ...voiceDraft([
      { id: 'one', start: 0, end: 11, text: 'Original first.', revisedText: 'Edited first.', needsTimingReview: false },
      { id: 'two', start: 11.5, end: 23, text: 'Original second.', revisedText: 'Edited second.', needsTimingReview: false },
      { id: 'three', start: 24, end: 35, text: 'Original third.', revisedText: 'Edited third.', needsTimingReview: false }
    ]), range: [0, 60] as [number, number] }
    expect(narrationVoiceReference(draft)).toEqual({ path: '/speech.wav', start: 0, end: 35,
      text: 'Original first. Original second. Original third.' })
    expect(draft.phrases.map(({ text, revisedText }) => [text, revisedText])).toEqual([
      ['Original first.', 'Edited first.'], ['Original second.', 'Edited second.'], ['Original third.', 'Edited third.']
    ])
  })

  it('keeps all contiguous safe audio when the recording is shorter than the target', () => {
    const draft = { ...voiceDraft([
      { id: 'one', start: 0, end: 3, text: 'Original first.', revisedText: 'Edited first.', needsTimingReview: false },
      { id: 'two', start: 3.5, end: 7, text: 'Original second.', revisedText: 'Edited second.', needsTimingReview: false }
    ]), range: [0, 8] as [number, number] }
    expect(narrationVoiceReference(draft)).toEqual({ path: '/speech.wav', start: 0, end: 7,
      text: 'Original first. Original second.' })
  })

  it('does not bridge invalid timing or a gap over two seconds', () => {
    const draft = { ...voiceDraft([
      { id: 'first', start: 0, end: 10, text: 'Safe first.', revisedText: 'Safe first.', needsTimingReview: false },
      { id: 'flagged', start: 10.5, end: 20, text: 'Flagged.', revisedText: 'Flagged.', needsTimingReview: true },
      { id: 'gapped', start: 23, end: 35, text: 'Too far.', revisedText: 'Too far.', needsTimingReview: false }
    ]), range: [0, 60] as [number, number] }
    expect(narrationVoiceReference(draft)).toEqual({ path: '/speech.wav', start: 0, end: 10, text: 'Safe first.' })
    const gappedDraft = { ...voiceDraft([
      { id: 'first', start: 0, end: 10, text: 'Safe first.', revisedText: 'Safe first.', needsTimingReview: false },
      { id: 'gapped', start: 13, end: 35, text: 'Too far.', revisedText: 'Too far.', needsTimingReview: false }
    ]), range: [0, 60] as [number, number] }
    expect(narrationVoiceReference(gappedDraft)).toEqual({ path: '/speech.wav', start: 0, end: 10, text: 'Safe first.' })
  })

  it('reuses a valid stored reference and falls back from malformed stored data', () => {
    const phrase = { id: 'phrase', start: 3, end: 4, text: 'Phrase.', revisedText: 'Phrase.', needsTimingReview: false }
    const stored = { path: '/shared-speech.wav', start: 1, end: 2, text: 'Stored.' }
    const selected = narrationVoiceReference(voiceDraft([phrase], stored))
    expect(selected).toEqual(stored)
    expect(selected).not.toBe(stored)
    expect(narrationVoiceReference(voiceDraft([phrase], { ...stored, end: 61 }))).toEqual({ ...stored, end: 61 })
    expect(narrationVoiceReference(voiceDraft([phrase], { ...stored, path: '' }))).toEqual({ path: '/speech.wav', start: 3,
      end: 4, text: 'Phrase.' })
    expect(narrationVoiceReference(voiceDraft([phrase], { ...stored, end: 62 }))).toEqual({ path: '/speech.wav', start: 3,
      end: 4, text: 'Phrase.' })
  })

  it('keeps a safe shorter reference instead of exceeding the 60-second bound', () => {
    const draft = { ...voiceDraft([
      { id: 'first', start: 0, end: 25, text: 'First original phrase.', revisedText: 'First edited.', needsTimingReview: false },
      { id: 'second', start: 25.5, end: 61, text: 'Would exceed the bound.', revisedText: 'Edited.', needsTimingReview: false }
    ]), range: [0, 70] as [number, number] }
    expect(narrationVoiceReference(draft)).toEqual({ path: '/speech.wav', start: 0, end: 25, text: 'First original phrase.' })
  })

  it('returns no reference when neither stored nor original voice references are usable', () => {
    expect(narrationVoiceReference(voiceDraft([], { path: '', start: 0, end: 1, text: 'bad' }))).toBeUndefined()
  })
})
