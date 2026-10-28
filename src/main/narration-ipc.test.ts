import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { NarrationReview } from '../narration-api'
import type { ExportRequest, AudioOverlay } from '../types'
import { SessionPathRegistry } from './path-registry'
import { registerNarrationIpc } from './narration-ipc'
import { NarrationTimingError } from '../narration'

const mock = vi.hoisted(() => ({ directory: '', handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  start: vi.fn(), request: vi.fn<(value: Record<string, unknown>) => Promise<unknown>>(), close: vi.fn(), stopped: vi.fn(), pack: vi.fn(), render: vi.fn(), generate: vi.fn(), models: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => mock.directory }, ipcMain: {
  handle: (name: string, callback: (...args: unknown[]) => Promise<unknown>) => mock.handlers.set(name, callback)
} }))
vi.mock('./narration-worker', () => ({ requireVoicePack: mock.pack, NarrationWorker: class {
  start = mock.start; request = mock.request; close = mock.close; stopped = mock.stopped
} }))
vi.mock('./narration-audio', () => ({ narrationFfmpeg: mock.render }))
vi.mock('./narration-generate', () => ({ generateNarrationAudio: mock.generate }))
vi.mock('./narration-models', () => ({ ensureNarrationModels: mock.models }))
const event = { sender: { send: vi.fn() } }
const project: ExportRequest = { canvas: { width: 64, height: 36, fps: 30, fit: 'contain' }, outputPath: '/renderer-choice.mp4', overlays: [],
  sources: [{ id: 's', metadata: { path: '/source.mp4', name: 'source', size: 1, modifiedAt: 1, width: 64, height: 36,
    duration: 10, fps: 30, videoCodec: 'h264', hasAudio: true } }], segments: [{ id: 'v', sourceId: 's', sourceStart: 0, sourceEnd: 10 }] }
let paths: SessionPathRegistry
let trusted: ReturnType<typeof vi.fn<(value: unknown) => Promise<ExportRequest>>>
async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  const handler = mock.handlers.get(`narration:${name}`)
  if (!handler) throw new Error('Missing handler')
  return handler(event, ...args)
}
beforeEach(async () => {
  vi.clearAllMocks()
  mock.directory = await mkdtemp(join(tmpdir(), 'otc-narration-ipc-'))
  paths = new SessionPathRegistry()
  trusted = vi.fn((value: unknown) => Promise.resolve(value as ExportRequest))
  mock.pack.mockResolvedValue('/pack')
  mock.models.mockResolvedValue('/model-cache')
  mock.start.mockResolvedValue(undefined)
  mock.stopped.mockResolvedValue(undefined)
  mock.render.mockImplementation((args: string[]) => writeFile(args.at(-1) ?? '', 'audio'))
  mock.request.mockImplementation((value: Record<string, unknown>) => {
    if (value.action === 'separate') return Promise.resolve({ speechPath: value.speech, backgroundPath: value.background })
    if (value.action === 'transcribe') return Promise.resolve([{ start: 1, end: 3, text: 'Um, please wait.' }])
    return Promise.resolve([JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please wait.' }] })])
  })
  mock.generate.mockImplementation(async () => {
    const output = join(mock.directory, 'generated.wav')
    await writeFile(output, 'generated')
    return output
  })
  registerNarrationIpc(paths, trusted)
})
afterEach(async () => { await rm(mock.directory, { recursive: true, force: true }) })

describe('Narration IPC', () => {
  it('loads valid saved phrase windows without obsolete word-level timing blocks', async () => {
    const draft = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    const flagged = { ...draft, phrases: draft.phrases.map((phrase) => ({ ...phrase, needsTimingReview: true })) }
    await writeFile(join(mock.directory, 'narration', draft.id, 'draft.json'), JSON.stringify(flagged))
    expect(await invoke('load', draft.id)).toMatchObject({ phrases: [{ needsTimingReview: false }] })
    const text = JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please wait.' }] })
    await expect(invoke('generate', project, draft.id, text, 'original')).resolves.toMatchObject({ type: 'audio' })
  })
  it('opens and regenerates a saved review with an unaligned filler left empty', async () => {
    const current = { ...project, segments: [{ id: 'v', sourceId: 's', sourceStart: 0, sourceEnd: 20 }] }
    const draft = await invoke('analyze', current, [0, 20], 'auto') as NarrationReview
    const bad = { id: 'uncertain', start: 4, end: 19, text: 'так', revisedText: 'так', needsTimingReview: true }
    await writeFile(join(mock.directory, 'narration', draft.id, 'draft.json'),
      JSON.stringify({ ...draft, phrases: [...draft.phrases, bad] }))
    expect(await invoke('load', draft.id)).toMatchObject({ phrases: [...draft.phrases,
      { ...bad, revisedText: '', needsTimingReview: false }] })
    await expect(invoke('generate', current, draft.id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please wait.' }, { id: 'uncertain', text: '' }] })))
      .resolves.toMatchObject({ type: 'audio' })
  })
  it('keeps an empty reviewed block and its fixed anchors after generation and reload', async () => {
    const saved = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    const phrases = [0, 1, 2].map((index) => ({ id: `phrase-${index}`, text: `Original ${index}.`,
      revisedText: `Revised ${index}.`, start: index * 3, end: index * 3 + 2, needsTimingReview: false }))
    await writeFile(join(mock.directory, 'narration', saved.id, 'draft.json'), JSON.stringify({ ...saved, phrases }))
    const review = JSON.stringify({ segments: phrases.map((phrase, index) => ({ id: phrase.id,
      text: index === 1 ? '   ' : phrase.revisedText, originalText: phrase.text })) })
    const generated = await invoke('generate', project, saved.id, review, 'original') as AudioOverlay
    const expected = phrases.map((phrase, index) => ({ ...phrase, revisedText: index === 1 ? '' : phrase.revisedText }))
    expect(mock.generate.mock.calls[0]?.[0]).toMatchObject({ phrases: expected })
    expect(await invoke('load', generated.narration?.draftId)).toMatchObject({ phrases: expected })
    expect(generated).toMatchObject({ start: 0, duration: 10, narration: { enabled: true } })
    await expect(invoke('generate', project, generated.narration?.draftId, review, 'original'))
      .resolves.toMatchObject({ duration: 10 })
  })

  it('recognizes automatically and persists validated mix settings with the generated revision', async () => {
    const draft = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'transcribe', language: 'auto' }))
    const mix = { levelVoice: true, backgroundVolume: 0.25 }
    const text = JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Wait.' }] })
    const overlay = await invoke('generate', project, draft.id, text, 'original', mix) as AudioOverlay
    expect(mock.generate.mock.calls[0]?.[0]).toMatchObject({ ...mix, slowdown: 0 })
    expect(overlay.narration).toMatchObject({ ...mix, slowdown: 0 })
    expect(await invoke('load', overlay.narration?.draftId)).toMatchObject({ ...mix, slowdown: 0 })
    const configuredMix = { ...mix, slowdown: 0.3 }
    const configuredOverlay = await invoke('generate', project, draft.id, text, 'original', configuredMix) as AudioOverlay
    expect(mock.generate.mock.calls.at(-1)?.[0]).toMatchObject(configuredMix)
    expect(configuredOverlay.narration).toMatchObject(configuredMix)
    expect(await invoke('load', configuredOverlay.narration?.draftId)).toMatchObject(configuredMix)
    await expect(invoke('generate', project, draft.id, text, 'original', { backgroundVolume: 2 })).rejects.toThrow('mix settings')
    await expect(invoke('generate', project, draft.id, text, 'original', { slowdown: 0.51 })).rejects.toThrow('mix settings')
  })
  it('forwards default and selected recognition settings to transcription and persists them', async () => {
    const ordinary = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    const ordinaryRequest = mock.request.mock.calls.find(([value]) => value.action === 'transcribe')?.[0]
    expect(ordinaryRequest).toMatchObject({ input: ordinary.originalPath, vadInput: ordinary.speechPath, speechDetection: true, vadThreshold: 0.5 })
    expect(ordinary.recognition).toEqual({ speechDetection: 'balanced', audio: 'original' })

    mock.request.mockClear()
    const sensitive = await invoke('analyze', project, [0, 10], 'auto', false,
      { speechDetection: 'sensitive', audio: 'speech' }) as NarrationReview
    const sensitiveRequest = mock.request.mock.calls.find(([value]) => value.action === 'transcribe')?.[0]
    expect(sensitiveRequest).toMatchObject({ input: sensitive.speechPath, speechDetection: true, vadThreshold: 0.35 })
    expect(sensitiveRequest).not.toHaveProperty('vadInput')
    expect(sensitive.recognition).toEqual({ speechDetection: 'sensitive', audio: 'speech' })
  })
  it('saves applied per-phrase speed in the generated review', async () => {
    const saved = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    mock.generate.mockImplementationOnce(async (...args: unknown[]) => {
      const report = args[6] as (id: string, tempo: number) => void
      report('phrase-0', 1.085)
      const output = join(mock.directory, 'tempo.wav')
      await writeFile(output, 'audio')
      return output
    })
    const result = await invoke('generate', project, saved.id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please wait.' }] })) as AudioOverlay
    expect(await invoke('load', result.narration?.draftId)).toMatchObject({ phrases: [{ generatedTempo: 1.085 }] })
    expect((await invoke('load', saved.id) as NarrationReview).phrases[0]?.generatedTempo).toBeUndefined()
  })

  it('does not request subtitle words when subtitles are opted out', async () => {
    const draft = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    const overlay = await invoke('generate', project, draft.id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please wait.' }] }), 'original', { subtitles: false }) as AudioOverlay
    expect(mock.generate.mock.calls[0]?.[5]).toBeUndefined()
    expect(overlay).not.toHaveProperty('subtitleLines')
  })
  it.each([
    { name: 'ordinary speech', text: 'Please wait.',
      words: [{ start: 1.1, end: 1.5, text: 'Please' }, { start: 1.55, end: 2, text: 'wait.' }],
      lines: [{ start: 1.1, end: 2, text: 'Please wait.' }] },
    { name: 'an unrecognized repeated word', text: 'Please. Please. Wait.',
      words: [{ start: 1.1, end: 1.5, text: 'Please' }, { start: 1.5, end: 2, text: 'wait.' }],
      lines: [{ start: 1.1, end: 1.5, text: 'Please.' }, { start: 1.5, end: 1.75, text: 'Please.' },
        { start: 1.75, end: 2, text: 'Wait.' }] }
  ])('aligns $name to reviewed text and keeps lines out of the saved draft', async ({ text, words, lines }) => {
    const draft = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    const reviewed = JSON.stringify({ segments: [{ id: 'phrase-0', text }] })
    let received: unknown
    mock.generate.mockImplementationOnce(async (...args: unknown[]) => {
      const callback = args[5] as ((value: unknown) => void) | undefined
      if (!callback) throw new Error('Missing subtitle callback')
      received = words
      callback(words)
      const output = join(mock.directory, 'generated-with-subtitles.wav')
      await writeFile(output, 'generated')
      return output
    })
    const overlay = await invoke('generate', project, draft.id, reviewed, 'original', { subtitles: true }) as AudioOverlay & {
      subtitleLines?: { start: number; end: number; text: string }[]
    }
    expect(received).toEqual(words)
    expect(overlay.narration).toMatchObject({ subtitles: true })
    expect(overlay.subtitleLines).toEqual(lines)
    const saved = await invoke('load', overlay.narration?.draftId) as NarrationReview
    expect(saved).not.toHaveProperty('subtitleLines')
  })
  it('persists translated English revisions across loading and a timing-review retry', async () => {
    mock.request.mockImplementation((value: Record<string, unknown>) => {
      if (value.action === 'separate') return Promise.resolve({ speechPath: value.speech, backgroundPath: value.background })
      if (value.action === 'transcribe') return Promise.resolve([
        { start: 1, end: 2, text: 'Поверните' }, { start: 2.8, end: 3.5, text: 'влево.' }
      ])
      return Promise.resolve([JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Turn left.' }] })])
    })
    const draft = await invoke('analyze', project, [0, 10], 'auto', true) as NarrationReview
    const reviewed = JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Turn left.' }] })
    expect(draft).toMatchObject({ language: 'auto', translateToEnglish: true,
      phrases: [{ id: 'phrase-0', text: 'Поверните влево.', revisedText: 'Turn left.', start: 1, end: 3.5,
        referenceEnd: 2, referenceText: 'Поверните' }] })
    expect(await invoke('load', draft.id)).toEqual(draft)

    mock.generate.mockRejectedValueOnce(new NarrationTimingError([{ id: 'phrase-0', text: 'Turn left.', extraSeconds: 0.24 }]))
    const failed = await invoke('generate', project, draft.id, reviewed) as { review: NarrationReview }
    expect(failed.review).toMatchObject({ approved: false, translateToEnglish: true,
      phrases: [{ id: 'phrase-0', text: 'Поверните влево.', revisedText: 'Turn left.', start: 1, end: 3.5,
        referenceEnd: 2, referenceText: 'Поверните' }] })
    expect(await invoke('load', failed.review.id)).toEqual(failed.review)

    const overlay = await invoke('generate', project, failed.review.id, reviewed) as AudioOverlay
    expect(await invoke('load', overlay.narration?.draftId)).toMatchObject({ translateToEnglish: true,
      phrases: [{ id: 'phrase-0', text: 'Поверните влево.', revisedText: 'Turn left.', start: 1, end: 3.5,
        referenceEnd: 2, referenceText: 'Поверните' }] })
  })
  it('rejects a malformed translation flag before trusting input or loading models', async () => {
    for (const invalid of ['true', 1, null, { enabled: true }]) {
      await expect(invoke('analyze', project, [0, 10], 'auto', invalid)).rejects.toThrow('translation setting')
    }
    expect(trusted).not.toHaveBeenCalled()
    expect(mock.pack).not.toHaveBeenCalled()
    expect(mock.models).not.toHaveBeenCalled()
    expect(mock.start).not.toHaveBeenCalled()
  })
  it('rejects malformed recognition settings before trusting input or loading models', async () => {
    for (const invalid of [null, [], 'true', { speechDetection: true }, { speechDetection: 'unknown' },
      { audio: true }, { audio: 'cleaned' }, { extra: true }]) {
      await expect(invoke('analyze', project, [0, 10], 'auto', false, invalid)).rejects.toThrow('recognition settings')
    }
    expect(trusted).not.toHaveBeenCalled()
    expect(mock.pack).not.toHaveBeenCalled()
    expect(mock.models).not.toHaveBeenCalled()
    expect(mock.start).not.toHaveBeenCalled()
  })
  it('cancels a first-use download before starting any model worker', async () => {
    mock.models.mockImplementation((_pack: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Download cancelled')), { once: true })
    }))
    const task = invoke('analyze', project, [0, 10], 'en')
    await vi.waitFor(() => expect(mock.models).toHaveBeenCalled())
    await invoke('cancel')
    await expect(task).rejects.toThrow('Download cancelled')
    expect(mock.start).not.toHaveBeenCalled()
    mock.models.mockResolvedValue('/model-cache')
    await invoke('analyze', project, [0, 10], 'en')
    expect(mock.start).toHaveBeenCalledWith('/pack', false, '/model-cache')
  })
  it('returns editable post-cleanup timing failures without approving or replacing audio', async () => {
    const draft = await invoke('analyze', project, [0, 10], 'en') as NarrationReview
    const overruns = [{ id: 'phrase-0', text: 'Please wait.', extraSeconds: 0.24 }]
    mock.generate.mockRejectedValue(new NarrationTimingError(overruns))
    const result = await invoke('generate', project, draft.id, JSON.stringify({ segments: [
      { id: 'phrase-0', text: 'Please wait.' }
    ] })) as { review: NarrationReview }
    expect(result.review).toMatchObject({ approved: false, stage: 'cleaned', overruns,
      phrases: [{ revisedText: 'Please wait.' }] })
    expect(result.review.id).not.toBe(draft.id)
    expect(await invoke('load', result.review.id)).toEqual(result.review)
    expect(mock.close).toHaveBeenCalledTimes(2)
  })

  it('recognizes and cleans in one worker, then synthesizes reviewed text without rewriting it', async () => {
    const draft = await invoke('analyze', project, [0, 10], 'en') as NarrationReview
    expect(draft).toMatchObject({ stage: 'cleaned', strength: 'balanced', phrases: [{ revisedText: 'Please wait.' }] })
    expect(mock.request.mock.calls.map(([value]) => value.action)).toEqual(['separate', 'transcribe', 'rewrite'])
    const rewrite = mock.request.mock.calls.find(([value]) => value.action === 'rewrite')?.[0]
    expect(JSON.stringify(rewrite)).toContain('correct grammar, and improve sentence flow')
    mock.request.mockClear()
    mock.start.mockClear()
    mock.close.mockClear()
    const overlay = await invoke('generate', project, draft.id, JSON.stringify({ segments: [
      { id: 'phrase-0', text: 'Please wait here!' }
    ] }), 'cosy') as AudioOverlay
    expect(mock.start).toHaveBeenCalledTimes(1)
    expect(mock.close).toHaveBeenCalledTimes(1)
    expect(mock.request.mock.calls.map(([value]) => value.action)).toEqual(['separate', 'transcribe'])
    expect(mock.generate.mock.calls[0]?.[0]).toMatchObject({ approved: true, stage: 'cleaned', strength: 'balanced', voiceStyle: 'cosy',
      phrases: [{ text: 'Um, please wait.', revisedText: 'Please wait here!' }] })
    expect(await invoke('load', overlay.narration?.draftId)).toMatchObject({ approved: true, stage: 'cleaned' })
    expect(await invoke('load', draft.id)).toEqual(draft)
    expect(overlay.narration?.voiceStyle).toBe('cosy')
    await expect(invoke('generate', project, draft.id, '{}', 'unknown')).rejects.toThrow('voice style')
  })

  it('retains trusted drafts, authorizes audio, and saves immutable reviewed revisions', async () => {
    expect(await invoke('status')).toMatchObject({ available: true })
    const draft = await invoke('analyze', project, [0, 10], 'en') as NarrationReview
    expect(trusted.mock.calls[0]?.[0]).toMatchObject({ outputPath: join(mock.directory, 'narration', 'unused.mp4') })
    expect(paths.canRead(draft.originalPath)).toBe(true)
    expect(await invoke('load', draft.id)).toEqual(draft)
    expect(mock.request.mock.calls.some(([value]) => value.action === 'rewrite')).toBe(true)
    const revised = JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Wait here.' }] })
    const overlay = await invoke('generate', project, draft.id, revised) as AudioOverlay
    expect(overlay.narration?.draftId).not.toBe(draft.id)
    expect(paths.canRead(overlay.path)).toBe(true)
    expect(await invoke('load', overlay.narration?.draftId)).toMatchObject({ approved: true, phrases: [{ revisedText: 'Wait here.' }] })
    expect(await invoke('load', draft.id)).toEqual(draft)
    expect(mock.close).toHaveBeenCalledTimes(2)
  })

  it('authorizes only the original needed to save and retry a restored narration review', async () => {
    const draft = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    const reviewed = JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Wait here.' }] })
    const generated = await invoke('generate', project, draft.id, reviewed, 'original') as AudioOverlay
    paths = new SessionPathRegistry()
    await paths.allowRead(generated.path)
    expect(paths.canRead(draft.originalPath)).toBe(false)
    trusted.mockImplementation((value: unknown) => {
      const input = value as ExportRequest
      input.overlays.forEach((overlay) => { if (overlay.type !== 'text') paths.assertReadable(overlay.path) })
      return Promise.resolve(input)
    })
    registerNarrationIpc(paths, trusted)
    mock.generate.mockRejectedValueOnce(new NarrationTimingError([{ id: 'phrase-0', text: 'Wait here.', extraSeconds: 0.1 }]))
    const current = { ...project, overlays: [generated] }
    const pending = await invoke('generate', current, generated.narration?.draftId, reviewed, 'original') as { review: NarrationReview }
    const original = { ...generated, path: pending.review.originalPath,
      narration: { draftId: pending.review.id, enabled: false } }
    expect(() => paths.assertReadable(original.path)).not.toThrow()
    await expect(invoke('generate', { ...project, overlays: [original] }, pending.review.id, reviewed, 'original'))
      .resolves.toMatchObject({ type: 'audio' })
    expect(() => paths.assertReadable('/unrelated.wav')).toThrow('not authorized')
    await expect(invoke('generate', { ...project, overlays: [{ ...original, path: '/unrelated.wav' }] },
      pending.review.id, reviewed, 'original')).rejects.toThrow('not authorized')
  })

  it.each([true, false])('checks selected audio before migrating a legacy draft: identical=%s', async (identical) => {
    const draft = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    await writeFile(join(mock.directory, 'narration', draft.id, 'draft.json'),
      JSON.stringify({ ...draft, contentKey: 'a'.repeat(64) }))
    if (!identical) mock.render.mockImplementation((args: string[]) => writeFile(args.at(-1) ?? '', 'changed audio'))
    const generate = invoke('generate', project, draft.id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please wait.' }] }))
    if (identical) {
      const overlay = await generate as AudioOverlay
      expect(await invoke('load', overlay.narration?.draftId)).toMatchObject({ contentKey: draft.contentKey })
    } else {
      await expect(generate).rejects.toThrow('changed')
      expect(mock.generate).not.toHaveBeenCalled()
    }
    expect((await readdir(join(mock.directory, 'narration'))).some((name) => name.endsWith('-verify.wav'))).toBe(false)
  })

  it.each([{ style: 'calm', levelVoice: true }, { style: 'conversational', levelVoice: false }])(
    'keeps the first generated reference when an earlier section is added ($style)', async ({ style, levelVoice }) => {
      const current = { ...project, segments: [{ id: 'v', sourceId: 's', sourceStart: 0, sourceEnd: 20 }] }
      const earlier = await invoke('analyze', current, [0, 10], 'auto') as NarrationReview
      const first = await invoke('analyze', current, [10, 20], 'auto') as NarrationReview
      const overlay = (draft: NarrationReview): AudioOverlay => ({ id: draft.id, type: 'audio', name: 'Re-voice',
        path: draft.originalPath, start: draft.range[0], duration: 10, sourceIn: 0, volume: 1, zIndex: 0,
        narration: { draftId: draft.id, enabled: false } })
      const mix = { levelVoice, backgroundVolume: 0.2, subtitles: true, slowdown: 0 }
      const text = JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please wait.' }] })
      const generated = await invoke('generate', { ...current, overlays: [overlay(earlier), overlay(first)] },
        first.id, text, style, mix, first.id) as AudioOverlay
      if (!generated.narration) throw new Error('Missing generated narration')
      const reference = (await invoke('load', generated.narration.draftId) as NarrationReview).voiceReference
      expect(reference).toMatchObject({ start: 1, end: 3, text: 'Um, please wait.' })
      expect(reference?.path).toContain(join(dirname(first.originalPath), '.narration-reference-'))
      const recognized = mock.request.mock.calls.filter(([value]) => value.action === 'transcribe').length
      // Original/AI preview choice and overlay order must not change the speaker.
      const request = { ...current, overlays: [overlay(earlier), { ...generated,
        narration: { ...generated.narration, enabled: false } }] }
      const result = await invoke('generate', request, earlier.id, text, style, mix, earlier.id) as AudioOverlay
      expect(mock.generate.mock.calls[1]?.[0]).toMatchObject({ voiceStyle: style, ...mix, voiceReference: reference })
      expect(mock.request.mock.calls.filter(([value]) => value.action === 'transcribe')).toHaveLength(recognized)
      expect(await invoke('load', result.narration?.draftId)).toMatchObject({ voiceStyle: style, ...mix,
        voiceReference: reference })
      expect(result.narration).toMatchObject({ voiceStyle: style, ...mix })
    })

  it('retains the established sample when all words in its section are cleared', async () => {
    const draft = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    const first = await invoke('generate', project, draft.id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please wait.' }] })) as AudioOverlay
    const reference = (await invoke('load', first.narration?.draftId) as NarrationReview).voiceReference
    const empty = await invoke('generate', { ...project, overlays: [first] }, first.narration?.draftId,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: '' }] }), 'original', {}, first.id) as AudioOverlay
    expect((await invoke('load', empty.narration?.draftId) as NarrationReview).voiceReference).toEqual(reference)
    expect(mock.generate.mock.calls[1]?.[0]).toMatchObject({ voiceReference: reference, phrases: [{ revisedText: '' }] })
  })

  it.each(['missing', 'malformed'])('does not derive a new speaker from an unrelated %s anchor', async (kind) => {
    const earlier = await invoke('analyze', project, [0, 5], 'auto') as NarrationReview
    const selected = await invoke('analyze', project, [5, 10], 'auto') as NarrationReview
    const anchorId = kind === 'missing' ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : earlier.id
    if (kind === 'malformed') await writeFile(join(mock.directory, 'narration', earlier.id, 'draft.json'),
      JSON.stringify({ ...earlier, voiceReference: { path: '', start: 1, end: 3, text: 'Wrong anchor.' } }))
    const pending: AudioOverlay = { id: 'earlier', type: 'audio', name: 'Re-voice', path: earlier.originalPath,
      start: 0, duration: 5, sourceIn: 0, volume: 1, zIndex: 0, narration: { draftId: anchorId, enabled: false } }
    const result = await invoke('generate', { ...project, overlays: [pending] }, selected.id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please wait.' }] })) as AudioOverlay
    const reference = (await invoke('load', result.narration?.draftId) as NarrationReview).voiceReference
    expect(reference?.path).toContain(join(dirname(selected.originalPath), '.narration-reference-'))
  })

  it('generates only a selected cut piece and preserves its parent draft', async () => {
    const saved = await invoke('analyze', project, [0, 10], 'auto') as NarrationReview
    const phrases = [1, 7].map((start, index) => ({ id: `p${index}`, start, end: start + 2,
      text: `Original ${index}.`, revisedText: `Revised ${index}.`, needsTimingReview: false }))
    const parent = { ...saved, phrases }
    await writeFile(join(mock.directory, 'narration', saved.id, 'draft.json'), JSON.stringify(parent))
    const piece: AudioOverlay = { id: 'right', type: 'audio', name: 'Re-voice', path: '/mix.wav',
      start: 5, duration: 4, sourceIn: 6, zIndex: 0, volume: 1, narration: { draftId: saved.id, enabled: true } }
    const current = { ...project, segments: [{ id: 'left', sourceId: 's', sourceStart: 0, sourceEnd: 5 },
      { id: 'right', sourceId: 's', sourceStart: 6, sourceEnd: 10 }], overlays: [piece] }
    const reviewed = JSON.stringify({ segments: [{ id: 'p1', text: 'Edited right.', originalText: 'Original 1.' }] })
    const result = await invoke('generate', current, saved.id, reviewed, 'original', {}, piece.id) as AudioOverlay
    expect(result).toMatchObject({ start: 5, duration: 4, sourceIn: 0 })
    expect(mock.generate.mock.calls[0]?.[0]).toMatchObject({ range: [5, 9],
      phrases: [{ id: 'p1', start: 1, end: 3, text: 'Original 1.', revisedText: 'Edited right.' }] })
    expect(await invoke('load', saved.id)).toEqual(parent)
    expect(await invoke('load', result.narration?.draftId)).toMatchObject({ range: [5, 9] })
    await expect(invoke('generate', current, saved.id, reviewed, 'original', {}, 'missing')).rejects.toThrow('section changed')
  })

  it('rejects path traversal and stale source audio before starting synthesis', async () => {
    await expect(invoke('load', '../outside')).rejects.toThrow('Invalid narration')
    const draft = await invoke('analyze', project, [0, 10], 'en') as NarrationReview
    const changed = { ...project, sources: project.sources.map((source) => ({ ...source, metadata: { ...source.metadata, size: 2 } })) }
    await expect(invoke('generate', changed, draft.id, JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Wait.' }] }))).rejects.toThrow('changed')
    expect(mock.generate).not.toHaveBeenCalled()
    mock.pack.mockRejectedValue(new Error('Install voice-pack'))
    expect(await invoke('status')).toMatchObject({ available: false })
  })

  it('requires a fresh Recognize for older recognition-only drafts', async () => {
    const draft = await invoke('analyze', project, [0, 10], 'en') as NarrationReview
    await writeFile(join(mock.directory, 'narration', draft.id, 'draft.json'), JSON.stringify({ ...draft, stage: 'recognized' }))
    await expect(invoke('generate', project, draft.id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Wait.' }] }))).rejects.toThrow('Recognize again')
    expect(mock.generate).not.toHaveBeenCalled()
  })

  it('keeps ownership until a cancelled worker has actually released its models', async () => {
    let reject: ((error: Error) => void) | undefined
    mock.request.mockImplementation(() => new Promise((_resolve, failed) => { reject = failed }))
    const pending = invoke('analyze', project, [0, 10], 'en')
    await vi.waitFor(() => { expect(mock.request).toHaveBeenCalled() })
    await expect(invoke('analyze', project, [0, 10], 'en')).rejects.toThrow('Another narration')
    await invoke('cancel')
    expect(mock.close).toHaveBeenCalledWith(true)
    reject?.(new Error('Narration cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(mock.stopped).toHaveBeenCalled()
  })
})
