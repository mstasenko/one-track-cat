import { describe, expect, it, vi } from 'vitest'
import { narrationPhrases } from '../narration-transcript'
import { cleanNarrationDraft, type NarrationAnalysisWorkers, type NarrationDraft } from './narration-analysis'

describe('Narration sentence gaps', () => {
  it('keeps a model sentence from spanning a long original ASR pause', async () => {
    const originalWords = [
      { start: 868.876, end: 869.476, text: 'Да' },
      { start: 869.636, end: 871.496, text: 'кайфует' },
      { start: 871.596, end: 872.096, text: 'здесь' },
      { start: 895.276, end: 895.616, text: 'А' }
    ]
    const draft: NarrationDraft = {
      contentKey: 'key', range: [0, 900], language: 'ru', strength: 'balanced',
      originalPath: '/original.wav', speechPath: '/speech.wav', backgroundPath: '/background.wav',
      phrases: narrationPhrases(originalWords, 900), approved: false, stage: 'recognized'
    }
    const rewrite = vi.fn<NarrationAnalysisWorkers['rewrite']>((batches) => Promise.resolve(batches.map((messages) => {
      const user = messages[1]
      if (!user) throw new Error('Missing narration rewrite input')
      const payload = JSON.parse(user.content) as Record<string, unknown>
      if ('transcript' in payload) return JSON.stringify({ sentences: ['Да кайфует здесь А.'] })
      const segments = payload.segments as { id: string; text: string }[]
      return JSON.stringify({ segments: segments.map((segment) => ({ id: segment.id, text: segment.text })) })
    })))
    const result = await cleanNarrationDraft(draft, rewrite, new AbortController().signal, originalWords)

    expect(result.phrases.map(({ text, start, end }) => ({ text, start, end }))).toEqual([
      { text: 'Да кайфует здесь', start: 868.876, end: 872.096 },
      { text: 'А', start: 895.276, end: 895.616 }
    ])
  })
})
