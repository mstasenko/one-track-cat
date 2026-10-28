import { describe, expect, it, vi } from 'vitest'
import { cleanNarrationDraft, type NarrationAnalysisWorkers, type NarrationDraft } from './narration-analysis'

describe('Narration analysis filler guard', () => {
  it('silences a filler-only model revision without changing useful speech or anchors', async () => {
    const draft: NarrationDraft = {
      contentKey: 'key', range: [0, 10], language: 'auto', strength: 'balanced', originalPath: '/original.wav',
      speechPath: '/speech.wav', backgroundPath: '/bed.wav', approved: false,
      phrases: [
        { id: 'filler', start: 1, end: 2, text: 'Ну, так...', revisedText: 'Ну, так...', needsTimingReview: false },
        { id: 'warning', start: 4.5, end: 5.5, text: 'Warning.', revisedText: 'Warning.', needsTimingReview: false },
        { id: 'well', start: 6.5, end: 7.5, text: 'Колодец.', revisedText: 'Колодец.', needsTimingReview: false }
      ]
    }
    const rewrite = vi.fn<NarrationAnalysisWorkers['rewrite']>((batches) => Promise.resolve(batches.map((messages) => {
      const user = messages[1]
      if (!user) throw new Error('Missing cleanup input')
      const { segments } = JSON.parse(user.content) as { segments: { id: string }[] }
      const id = segments[0]?.id
      if (!id) throw new Error('Missing cleanup segment')
      return JSON.stringify({ segments: [{ id, text: id === 'filler' ? 'Well...' : id === 'well' ? 'Well.' : 'Warning!' }] })
    })))

    const cleaned = await cleanNarrationDraft(draft, rewrite, new AbortController().signal)

    expect(cleaned.phrases).toEqual([
      { id: 'filler', start: 1, end: 2, text: 'Ну, так...', revisedText: '', needsTimingReview: false },
      { id: 'warning', start: 4.5, end: 5.5, text: 'Warning.', revisedText: 'Warning!', needsTimingReview: false },
      { id: 'well', start: 6.5, end: 7.5, text: 'Колодец.', revisedText: 'Well.', needsTimingReview: false }
    ])
  })
})
