import { describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
import { analyzeNarration, recognizeNarration, cleanNarrationDraft, approveNarrationDraft, narrationContentKey, requireCurrentNarration,
  type NarrationAnalysisWorkers } from './narration-analysis'

function project(): ExportRequest {
  return {
    canvas: { width: 64, height: 36, fps: 30, fit: 'contain' }, outputPath: '/unused.mp4', overlays: [],
    sources: [{ id: 's1', metadata: { path: '/source.mp4', name: 'source', size: 12, modifiedAt: 1,
      width: 64, height: 36, fps: 30, videoCodec: 'h264', duration: 20, hasAudio: true } }],
    segments: [{ id: 'v1', sourceId: 's1', sourceStart: 0, sourceEnd: 20 }]
  }
}

const words = [{ start: 1, end: 2, text: 'Um, wait.' }]
const settings = { language: 'en', strength: 'balanced' } as const
const range = [3, 13] as const
const models = 'whisper-large-v3-fp16/qwen-int8/moss-f32/v1'
const reviewed = JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please wait.' }] })

function workers(events: string[] = [], cancelAt?: string, controller?: AbortController): NarrationAnalysisWorkers {
  const record = (stage: string): void => {
    events.push(stage)
    if (stage === cancelAt) controller?.abort()
  }
  return {
    renderAudio: vi.fn(() => { record('render'); return Promise.resolve('/original.wav') }),
    separate: vi.fn(() => { record('separate'); return Promise.resolve({ speechPath: '/speech.wav', backgroundPath: '/bed.wav' }) }),
    transcribe: vi.fn(() => { record('transcribe'); return Promise.resolve(words) }),
    rewrite: vi.fn<NarrationAnalysisWorkers['rewrite']>((batches) => {
      record('rewrite')
      return Promise.resolve(batches.map((messages) => {
        const user = messages[1]
        if (!user) throw new Error('Missing cleanup input')
        const input = JSON.parse(user.content) as { segments: { id: string; text: string }[] }
        return JSON.stringify({ segments: input.segments.map((segment) => ({ ...segment, text: 'Wait.' })) })
      }))
    })
  }
}

function analyze(worker = workers(), controller = new AbortController()) {
  return analyzeNarration(project(), range, settings, models, worker, controller.signal)
}

function sentenceWorker(words: readonly { start: number; end: number; text: string }[], boundaryResponse: string | readonly string[],
  calls: { kind: 'boundary' | 'cleanup'; payload: unknown }[], controller?: AbortController, cancelAfterBoundary = false,
  boundaryResponses: readonly (string | readonly string[])[] = [], cancelOnBoundaryAttempt = cancelAfterBoundary ? 0 : undefined): NarrationAnalysisWorkers {
  const worker = workers()
  let boundaryAttempt = 0
  worker.transcribe = vi.fn().mockResolvedValue(words)
  worker.rewrite = vi.fn<NarrationAnalysisWorkers['rewrite']>((batches) => {
    const first = batches[0]?.[1]
    if (!first) throw new Error('Missing narration rewrite input')
    const input = JSON.parse(first.content) as Record<string, unknown>
    if (typeof input.transcript === 'string') {
      calls.push({ kind: 'boundary', payload: input })
      if (boundaryAttempt === cancelOnBoundaryAttempt) controller?.abort()
      const response = boundaryResponses[boundaryAttempt] ?? boundaryResponse
      boundaryAttempt += 1
      return Promise.resolve(typeof response === 'string' ? [response] : [...response])
    }
    calls.push(...batches.map((messages) => {
      const user = messages[1]
      if (!user) throw new Error('Missing cleanup input')
      const payload = JSON.parse(user.content) as Record<string, unknown>
      return { kind: 'cleanup' as const, payload }
    }))
    return Promise.resolve(batches.map((messages) => {
      const user = messages[1]
      if (!user) throw new Error('Missing cleanup input')
      const value = JSON.parse(user.content) as { segments: { id: string }[] }
      return JSON.stringify({ segments: value.segments.map((segment) => ({ id: segment.id, text: `Clean ${segment.id}.` })) })
    }))
  })
  return worker
}

describe('Narration analysis', () => {
  it('uses automatic recognition and preserves the source language during cleanup', async () => {
    const worker = workers()
    worker.transcribe = vi.fn().mockResolvedValue([{ start: 1, end: 3, text: 'Пожалуйста, подождите.' }])
    const controller = new AbortController()
    const result = await analyzeNarration(project(), range, { ...settings, language: 'auto' }, models, worker, controller.signal)
    expect(worker.transcribe).toHaveBeenCalledWith('/speech.wav', 'auto', controller.signal)
    expect(result.language).toBe('auto')
    expect(vi.mocked(worker.rewrite).mock.calls[0]?.[0][0]?.[0]?.content).toContain('Keep the original language of each segment')
  })
  it('translates cleanup while retaining automatic Whisper language and application-owned anchors', async () => {
    const worker = workers()
    worker.transcribe = vi.fn().mockResolvedValue([
      { start: 1, end: 2, text: 'Поверните' }, { start: 2.8, end: 3.5, text: 'влево.' },
      { start: 5, end: 6, text: 'Стоп.' }
    ])
    worker.rewrite = vi.fn<NarrationAnalysisWorkers['rewrite']>((batches) => Promise.resolve(batches.map((messages) => {
      const user = messages[1]
      if (!user) throw new Error('Missing cleanup input')
      const input = JSON.parse(user.content) as { segments: { id: string; text: string }[] }
      return JSON.stringify({ segments: input.segments.map((segment) => ({
        id: segment.id, text: segment.id === 'phrase-0' ? 'Turn left.' : 'Stop.'
      })) })
    })))
    const controller = new AbortController()
    const result = await analyzeNarration(project(), range,
      { ...settings, language: 'auto', translateToEnglish: true }, models, worker, controller.signal)
    const prompt = vi.mocked(worker.rewrite).mock.calls[0]?.[0][0]?.[0]?.content ?? ''

    expect(worker.transcribe).toHaveBeenCalledWith('/speech.wav', 'auto', controller.signal)
    expect(result).toMatchObject({ language: 'auto', translateToEnglish: true })
    expect(prompt).toContain('Translate speech transcripts into natural English spoken narration')
    expect(prompt).toContain('Translate faithfully without adding or omitting information')
    expect(prompt).not.toContain('Do not translate')
    expect(prompt).not.toContain('Keep the original language of each segment')
    expect(prompt).not.toContain('When uncertain, leave the wording unchanged')
    expect(result.phrases).toEqual([
      { id: 'phrase-0', start: 1, end: 3.5, text: 'Поверните влево.', revisedText: 'Turn left.', needsTimingReview: false,
        referenceEnd: 2, referenceText: 'Поверните' },
      { id: 'phrase-2', start: 5, end: 6, text: 'Стоп.', revisedText: 'Stop.', needsTimingReview: false }
    ])
  })
  it('rewrites complete sentence fragments together without inventing timestamps', async () => {
    const worker = workers()
    worker.transcribe = vi.fn().mockResolvedValue([
      { start: 0, end: 1, text: 'Use the wrench' }, { start: 2, end: 3, text: 'to tighten it.' }
    ])
    const draft = await analyze(worker)
    const batches = vi.mocked(worker.rewrite).mock.calls[0]?.[0]
    expect(batches?.[0]?.[1]?.content).toContain('Use the wrench to tighten it.')
    expect(draft.phrases).toEqual([
      { id: 'phrase-0', start: 0, end: 3, text: 'Use the wrench to tighten it.', revisedText: 'Wait.', needsTimingReview: false,
        referenceEnd: 1, referenceText: 'Use the wrench' }
    ])
  })
  it('uses model boundaries to split an unpunctuated stream before cleanup', async () => {
    const originalWords = [
      { start: 0, end: 0.2, text: 'This' }, { start: 0.25, end: 0.45, text: 'is' },
      { start: 0.5, end: 0.7, text: 'the' }, { start: 0.75, end: 0.95, text: 'first' },
      { start: 1, end: 1.2, text: 'sentence' }, { start: 1.25, end: 1.45, text: 'Here' },
      { start: 1.5, end: 1.7, text: 'is' }, { start: 1.75, end: 1.95, text: 'the' },
      { start: 2, end: 2.2, text: 'second' }, { start: 2.25, end: 2.45, text: 'thought' }
    ]
    const calls: { kind: 'boundary' | 'cleanup'; payload: unknown }[] = []
    const worker = sentenceWorker(originalWords, JSON.stringify({ sentences: ['This is the first sentence', 'Here is the second thought'] }), calls)
    const draft = await analyze(worker)
    const cleanup = calls.filter((call) => call.kind === 'cleanup').flatMap(({ payload }) =>
      (payload as { segments: { id: string; text: string }[] }).segments)
    expect(calls.map(({ kind }) => kind)).toEqual(['boundary', 'cleanup', 'cleanup'])
    expect(cleanup.map(({ id, text }) => [id, text])).toEqual([
      ['phrase-0', 'This is the first sentence'], ['phrase-1', 'Here is the second thought']
    ])
    expect(draft.phrases).toEqual([
      { id: 'phrase-0', start: 0, end: 1.2, text: 'This is the first sentence', revisedText: 'Clean phrase-0.', needsTimingReview: false },
      { id: 'phrase-1', start: 1.25, end: 2.45, text: 'Here is the second thought', revisedText: 'Clean phrase-1.', needsTimingReview: false }
    ])
  })
  it.each([
    JSON.stringify({ sentences: ['word0 word1 word2 word3'] }),
    JSON.stringify({ sentences: ['word0 word1 word2 word3 word4 word5 word6 word7 word8 word9'], text: 'injected' })
  ])('ignores missing or injected model boundaries before cleanup %#', async (boundaryResponse) => {
    const originalWords = Array.from({ length: 10 }, (_, index) => ({ start: index * 0.2, end: index * 0.2 + 0.1, text: `word${index}` }))
    const calls: { kind: 'boundary' | 'cleanup'; payload: unknown }[] = []
    const worker = sentenceWorker(originalWords, boundaryResponse, calls)
    const draft = await analyze(worker)
    expect(draft.phrases.map(({ text }) => text).join(' ')).toBe(originalWords.map(({ text }) => text).join(' '))
    expect(calls.map(({ kind }) => kind)).toEqual(['boundary', 'boundary', 'cleanup'])
  })
  it('repairs only invalid sentence batches once before wording cleanup', async () => {
    const originalWords = Array.from({ length: 130 }, (_, index) => ({ start: index * 0.1, end: index * 0.1 + 0.05,
      text: index === 119 ? `word${index}.` : `word${index}` }))
    const transcript = (start: number, end: number): string => originalWords.slice(start, end).map(({ text }) => text).join(' ')
    const badFirst = JSON.stringify({ sentences: [transcript(0, 119), transcript(120, 128)] })
    const goodFirst = JSON.stringify({ sentences: [transcript(0, 120), transcript(120, 128)] })
    const goodSecond = JSON.stringify({ sentences: [transcript(112, 120), transcript(120, 130)] })
    const calls: { kind: 'boundary' | 'cleanup'; payload: unknown }[] = []
    const worker = sentenceWorker(originalWords, [badFirst, goodSecond], calls, undefined, false, [[badFirst, goodSecond], [goodFirst]])
    const draft = await analyzeNarration(project(), [0, 20], settings, models, worker, new AbortController().signal)
    expect(vi.mocked(worker.rewrite)).toHaveBeenCalledTimes(3)
    expect(vi.mocked(worker.rewrite).mock.calls[1]?.[0]).toHaveLength(1)
    expect(calls.map(({ kind }) => kind)).toEqual(['boundary', 'boundary', 'cleanup', 'cleanup'])
    expect(draft.phrases).toHaveLength(2)
    expect(draft.phrases[0]?.text).toContain('word119.')
  })

  it('keeps original word anchors when punctuation proposals remain invalid', async () => {
    const originalWords = [
      { start: 0, end: 0.2, text: 'Не' }, { start: 0.3, end: 0.5, text: 'включайте.' },
      { start: 1, end: 1.2, text: 'Теперь' }, { start: 1.3, end: 1.6, text: 'наживляем.' },
      { start: 2, end: 2.2, text: 'Затем' }, { start: 2.3, end: 2.6, text: 'ждем' },
      { start: 2.7, end: 2.9, text: 'немного' }
    ]
    const calls: { kind: 'boundary' | 'cleanup'; payload: unknown }[] = []
    const worker = sentenceWorker(originalWords, JSON.stringify({ sentences: ['Включайте. Теперь нажи. Затем ждем.'] }), calls)
    const draft = await analyzeNarration(project(), [0, 20], settings, models, worker, new AbortController().signal)
    expect(draft.phrases.map(({ text, start, end }) => ({ text, start, end }))).toEqual([
      { text: 'Не включайте.', start: 0, end: 0.5 },
      { text: 'Теперь наживляем.', start: 1, end: 1.6 },
      { text: 'Затем ждем немного', start: 2, end: 2.9 }
    ])
    expect(calls.map(({ kind }) => kind)).toEqual(['boundary', 'boundary', 'cleanup', 'cleanup', 'cleanup'])
  })

  it('honors cancellation during an automatic boundary repair', async () => {
    const originalWords = Array.from({ length: 10 }, (_, index) => ({ start: index * 0.2, end: index * 0.2 + 0.1, text: `word${index}` }))
    const bad = JSON.stringify({ sentences: ['word0 word1 word2 word3'] })
    const good = JSON.stringify({ sentences: ['word0 word1 word2 word3 word4 word5 word6 word7 word8 word9'] })
    const calls: { kind: 'boundary' | 'cleanup'; payload: unknown }[] = []
    const controller = new AbortController()
    const worker = sentenceWorker(originalWords, bad, calls, controller, false, [bad, good], 1)
    await expect(analyze(worker, controller)).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.mocked(worker.rewrite)).toHaveBeenCalledTimes(2)
    expect(calls.map(({ kind }) => kind)).toEqual(['boundary', 'boundary'])
  })

  it('repairs only invalid wording batches once', async () => {
    const originalWords = Array.from({ length: 9 }, (_, index) => ({ start: index, end: index + 0.2, text: `Word${index}.` }))
    const ids = originalWords.map((_, index) => `phrase-${index}`)
    const response = (segmentIds: readonly string[]): string => JSON.stringify({ segments: segmentIds.map((id) => ({ id, text: `Clean ${id}.` })) })
    const responses = [JSON.stringify({ segments: [{ id: 'wrong', text: 'bad' }] }), ...ids.slice(1).map((id) => response([id]))]
    const calls: number[] = []
    let attempt = 0
    const worker = workers()
    worker.transcribe = vi.fn().mockResolvedValue(originalWords)
    worker.rewrite = vi.fn<NarrationAnalysisWorkers['rewrite']>((batches) => {
      calls.push(batches.length)
      return Promise.resolve(attempt++ === 0 ? responses : [response(ids.slice(0, 1))])
    })
    const draft = await analyzeNarration(project(), [0, 20], settings, models, worker, new AbortController().signal)
    expect(calls).toEqual([9, 1])
    expect(draft.phrases.map(({ revisedText }) => revisedText)).toEqual(ids.map((id) => `Clean ${id}.`))
  })

  it('honors cancellation between boundary detection and wording cleanup', async () => {
    const originalWords = Array.from({ length: 10 }, (_, index) => ({ start: index * 0.2, end: index * 0.2 + 0.1, text: `word${index}` }))
    const calls: { kind: 'boundary' | 'cleanup'; payload: unknown }[] = []
    const controller = new AbortController()
    const worker = sentenceWorker(originalWords, JSON.stringify({ sentences: ['word0 word1 word2 word3 word4', 'word5 word6 word7 word8 word9'] }), calls,
      controller, true)
    await expect(analyze(worker, controller)).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls.map(({ kind }) => kind)).toEqual(['boundary'])
  })
  it('does not send an invalid filler word to wording cleanup after sentence detection', async () => {
    const originalWords = [
      { start: 0, end: 15, text: 'так' }, { start: 16, end: 16.2, text: 'Continue' },
      { start: 16.25, end: 16.45, text: 'with' }, { start: 16.5, end: 16.7, text: 'the' },
      { start: 16.75, end: 16.95, text: 'work' }
    ]
    const calls: { kind: 'boundary' | 'cleanup'; payload: unknown }[] = []
    const worker = sentenceWorker(originalWords, [
      JSON.stringify({ sentences: ['так. Continue with the work.'] }),
      JSON.stringify({ sentences: ['так Continue with the work.'] })
    ], calls)
    const draft = await analyzeNarration(project(), [0, 20], settings, models, worker, new AbortController().signal)
    const cleanup = calls.find((call) => call.kind === 'cleanup')?.payload as { segments: { id: string; text: string }[] } | undefined
    expect(cleanup?.segments).toEqual([{ id: 'phrase-1', text: 'Continue with the work' }])
    expect(draft.phrases[0]).toMatchObject({ text: 'так', revisedText: '', needsTimingReview: false })
  })
  it('repairs small phrase overlaps before cleanup and approval without moving starts', async () => {
    const draft = await analyze(workers())
    draft.phrases = [
      { id: 'p1', start: 1, end: 4, text: 'First original.', revisedText: 'First original.', needsTimingReview: false },
      { id: 'p2', start: 3.9, end: 6, text: 'Second original.', revisedText: 'Second original.', needsTimingReview: true }
    ]
    const segments = [{ id: 'p1', text: 'First.' }, { id: 'p2', text: 'Second.' }]
    const rewrite = vi.fn().mockResolvedValue(segments.map((segment) => JSON.stringify({ segments: [segment] })))
    const cleaned = await cleanNarrationDraft(draft, rewrite, new AbortController().signal)
    expect(cleaned.phrases.map((phrase) => phrase.revisedText)).toEqual(['First.', 'Second.'])
    expect(cleaned.phrases.map((phrase) => phrase.start)).toEqual([1, 3.9])
    expect(cleaned.phrases[0]?.end).toBe(3.9)
    const approved = approveNarrationDraft(draft, JSON.stringify({ segments }))
    expect(approved.phrases.every((phrase) => !phrase.needsTimingReview)).toBe(true)
    expect(approved.phrases.map((phrase) => phrase.start)).toEqual([1, 3.9])
    expect(draft.phrases[0]?.end).toBe(4)
  })

  it('stops after recognition for human corrections before any LLM processing', async () => {
    const worker = workers()
    const draft = await recognizeNarration(project(), range, settings, models, worker, new AbortController().signal)
    expect(draft).toMatchObject({ stage: 'recognized', approved: false, phrases: [{ text: 'Um, wait.', revisedText: 'Um, wait.' }] })
    expect(worker.rewrite).not.toHaveBeenCalled()
    const corrected = approveNarrationDraft(draft, JSON.stringify({ segments: [{ id: 'phrase-0', originalText: 'Please wait.', text: 'Please wait here.' }] }))
    expect(corrected.phrases[0]).toMatchObject({ start: 1, end: 2, text: 'Please wait.', revisedText: 'Please wait here.' })
    expect(draft.phrases[0]?.text).toBe('Um, wait.')
  })
  it('runs stages sequentially and returns an unapproved, selection-relative draft', async () => {
    const events: string[] = []
    const worker = workers(events)
    const draft = await analyze(worker)
    expect(events).toEqual(['render', 'separate', 'transcribe', 'rewrite'])
    expect(worker.separate).toHaveBeenCalledWith('/original.wav', expect.any(AbortSignal))
    expect(worker.transcribe).toHaveBeenCalledWith('/speech.wav', 'en', expect.any(AbortSignal))
    expect(draft).toMatchObject({ approved: false, range: [3, 13], backgroundPath: '/bed.wav',
      phrases: [{ start: 1, end: 2, text: 'Um, wait.', revisedText: 'Wait.' }] })
  })

  it('propagates empty filler revisions while retaining useful short speech and anchors', async () => {
    const worker = workers()
    worker.transcribe = vi.fn().mockResolvedValue([
      { start: 1, end: 2, text: 'Um.' }, { start: 2.5, end: 3.5, text: 'Warning.' }
    ])
    worker.rewrite = vi.fn<NarrationAnalysisWorkers['rewrite']>((batches) => Promise.resolve(batches.map((messages, index) => {
      const user = messages[1]
      if (!user) throw new Error('Missing cleanup input')
      const { segments } = JSON.parse(user.content) as { segments: { id: string }[] }
      return JSON.stringify({ segments: [{ id: segments[0]?.id, text: index ? 'Warning!' : '' }] })
    })))
    const draft = await analyze(worker)
    expect(draft.phrases).toEqual([
      { id: 'phrase-0', start: 1, end: 2, text: 'Um.', revisedText: '', needsTimingReview: false },
      { id: 'phrase-1', start: 2.5, end: 3.5, text: 'Warning.', revisedText: 'Warning!', needsTimingReview: false }
    ])
  })

  it('does not start another stage until the preceding stage finishes', async () => {
    const events: string[] = []
    const worker = workers(events)
    let release: ((value: string) => void) | undefined
    worker.renderAudio = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
    const result = analyze(worker)
    expect(events).toEqual([])
    if (!release) throw new Error('Render did not start')
    release('/original.wav')
    await result
    expect(events).toEqual(['separate', 'transcribe', 'rewrite'])
  })

  it.each(['render', 'separate', 'transcribe', 'rewrite'])('stops after cancellation during %s', async (stage) => {
    const events: string[] = []
    const controller = new AbortController()
    const worker = workers(events, stage, controller)
    await expect(analyze(worker, controller)).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.at(-1)).toBe(stage)
  })

  it('never starts work if already cancelled', async () => {
    const worker = workers()
    const controller = new AbortController()
    controller.abort()
    await expect(analyze(worker, controller)).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.renderAudio).not.toHaveBeenCalled()
  })

  it('does not invent speech or call cleanup for silence', async () => {
    const worker = workers()
    worker.transcribe = vi.fn().mockResolvedValue([])
    const draft = await analyze(worker)
    expect(draft.phrases).toEqual([])
    expect(worker.rewrite).not.toHaveBeenCalled()
    expect(() => approveNarrationDraft(draft, reviewed)).toThrow('No speech')
  })

  it('continues cleanup without a single unaligned filler word', async () => {
    const worker = workers()
    worker.transcribe = vi.fn().mockResolvedValue([
      { start: 0, end: 15, text: 'так' }, { start: 16, end: 17, text: 'Continue.' }
    ])
    const draft = await analyzeNarration(project(), [0, 20], settings, models, worker, new AbortController().signal)
    expect(draft.phrases).toHaveLength(2)
    expect(draft.phrases[0]).toMatchObject({ text: 'так', revisedText: '', needsTimingReview: false })
    expect(draft.phrases[1]).toMatchObject({ start: 16, end: 17, text: 'Continue.', needsTimingReview: false })
    expect(vi.mocked(worker.rewrite).mock.calls[0]?.[0][0]?.[1]?.content).not.toContain('так')
  })

  it('retains invalid alignments for review but never approves or rewrites them', async () => {
    const worker = workers()
    worker.transcribe = vi.fn().mockResolvedValue([{ start: 1, end: 1, text: 'Wait.' }])
    const draft = await analyze(worker)
    expect(draft.phrases[0]?.needsTimingReview).toBe(true)
    expect(worker.rewrite).not.toHaveBeenCalled()
    expect(() => approveNarrationDraft(draft, reviewed)).toThrow('timing')
  })

  it('sends one anchored phrase per prompt within a single rewrite worker lifetime', async () => {
    const worker = workers()
    worker.transcribe = vi.fn().mockResolvedValue(Array.from({ length: 20 }, (_, index) => ({
      start: index * 0.4, end: index * 0.4 + 0.2, text: 'Wait.'
    })))
    const draft = await analyze(worker)
    expect(worker.rewrite).toHaveBeenCalledTimes(1)
    const prompts = vi.mocked(worker.rewrite).mock.calls[0]?.[0] ?? []
    expect(prompts).toHaveLength(20)
    expect(prompts.map((messages) => {
      const user = messages[1]
      if (!user) throw new Error('Missing cleanup prompt')
      const { segments } = JSON.parse(user.content) as { segments: { id: string; text: string }[] }
      return { segments }
    })).toEqual(Array.from({ length: 20 }, (_, index) => ({ segments: [{ id: `phrase-${index}`, text: 'Wait.' }] })))
    expect(draft.phrases).toHaveLength(20)
  })

  it('rejects missing batches or model attempts to change anchors', async () => {
    const worker = workers()
    worker.rewrite = vi.fn().mockResolvedValue([])
    await expect(analyze(worker)).rejects.toThrow('incomplete batches')
    worker.rewrite = vi.fn().mockResolvedValue([JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Wait.', start: 0 }] })])
    await expect(analyze(worker)).rejects.toThrow('revise text only')
  })

  it('requires explicit text approval before synthesis', async () => {
    const draft = await analyze()
    expect(() => requireCurrentNarration(draft, project(), models)).toThrow('approve')
    const approved = approveNarrationDraft(draft, reviewed)
    expect(approved.phrases[0]).toMatchObject({ start: 1, end: 2, text: 'Um, wait.', revisedText: 'Please wait.' })
    expect(() => requireCurrentNarration(approved, project(), models)).not.toThrow()
    expect(draft.approved).toBe(false)
  })

  it('allows review of a complete selection containing more than one LLM-sized batch', async () => {
    const worker = workers()
    worker.transcribe = vi.fn().mockResolvedValue(Array.from({ length: 40 }, (_, index) => ({
      start: index * 0.2, end: index * 0.2 + 0.1, text: 'Wait.'
    })))
    const draft = await analyze(worker)
    const review = JSON.stringify({ segments: draft.phrases.map(({ id }) => ({ id, text: 'Wait.' })) })
    expect(approveNarrationDraft(draft, review).phrases).toHaveLength(40)
  })

  it('invalidates analysis after source, timeline, or model changes, not visual edits', async () => {
    const draft = approveNarrationDraft(await analyze(), reviewed)
    const edited = project()
    edited.focusZooms = [{ id: 'z', start: 0, duration: 2, zoom: 3, focusX: 0.5, focusY: 0.5 }]
    expect(() => requireCurrentNarration(draft, edited, models)).not.toThrow()
    edited.segments = [{ id: 'renamed', sourceId: 's1', sourceStart: 0, sourceEnd: 20,
      transition: { effect: 'fade', duration: 1 } }]
    expect(() => requireCurrentNarration(draft, edited, models)).not.toThrow()
    expect(() => requireCurrentNarration(draft, edited, 'different-model')).toThrow('changed')
    const original = edited.sources[0]
    if (!original) throw new Error('Missing test source')
    original.metadata.modifiedAt += 1
    expect(() => requireCurrentNarration(draft, edited, models)).toThrow('changed')
    edited.sources = project().sources
    edited.segments = [{ id: 'changed', sourceId: 's1', sourceStart: 1, sourceEnd: 19 }]
    expect(() => requireCurrentNarration(draft, edited, models)).toThrow('changed')
  })

  it('keeps earlier narration valid after later cuts and source changes', async () => {
    const current = project()
    const draft = approveNarrationDraft(await analyze(), reviewed)
    current.segments[0] = { id: 'split', sourceId: 's1', sourceStart: 0, sourceEnd: 14 }
    const source = current.sources[0]
    if (!source) throw new Error('Missing test source')
    current.sources.push({ id: 's2', metadata: { ...source.metadata, path: '/later.mp4' } })
    current.segments.push({ id: 'later', sourceId: 's2', sourceStart: 2, sourceEnd: 10 })
    expect(() => requireCurrentNarration(draft, current, models)).not.toThrow()
    current.segments[0] = { id: 'changed', sourceId: 's1', sourceStart: 1, sourceEnd: 14 }
    expect(() => requireCurrentNarration(draft, current, models)).toThrow('changed')
  })

  it('ignores unselected freezes and sources and validates settings before work', async () => {
    const original = project()
    const key = narrationContentKey(original, range, models)
    const source = original.sources[0]
    if (!source) throw new Error('Missing test source')
    original.sources.push({ id: 'unused', metadata: { ...source.metadata, path: '/unused.mp4' } })
    expect(narrationContentKey(original, range, models)).toBe(key)
    original.segments.push({ kind: 'freeze', id: 'f', sourceId: 's1', sourceTime: 1, duration: 2 })
    expect(narrationContentKey(original, range, models)).toBe(key)
    expect(() => narrationContentKey(project(), [0, 21], models)).toThrow('selection')
    expect(() => narrationContentKey(project(), range, '')).toThrow('model identity')
    const worker = workers()
    await expect(analyzeNarration(project(), range, { ...settings, language: 'de' as never }, models,
      worker, new AbortController().signal)).rejects.toThrow('settings')
    expect(worker.renderAudio).not.toHaveBeenCalled()
  })
})
