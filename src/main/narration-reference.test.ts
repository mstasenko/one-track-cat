import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest } from '../types'
import type { NarrationDraft } from './narration-analysis'
import type { NarrationWorker } from './narration-worker'
import { prepareNarrationVoiceReference } from './narration-reference'
import { narrationFfmpeg } from './narration-audio'

vi.mock('./narration-audio', () => ({ narrationFfmpeg: vi.fn() }))

const render = vi.mocked(narrationFfmpeg)
let directory: string

function request(): ExportRequest {
  return { outputPath: '', canvas: { width: 64, height: 36, fps: 30, fit: 'contain' }, overlays: [],
    sources: [{ id: 'source', metadata: { path: '/source.mp4', name: 'source', size: 1, modifiedAt: 1,
      width: 64, height: 36, fps: 30, duration: 100, videoCodec: 'h264', hasAudio: true } }],
    segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 100 }] }
}

function draft(originalPath: string, range: [number, number] = [10, 12]): NarrationDraft {
  return { contentKey: 'draft', range, language: 'auto', strength: 'balanced', originalPath,
    speechPath: join(dirname(originalPath), 'speech.wav'), backgroundPath: join(dirname(originalPath), 'background.wav'),
    phrases: [{ id: 'phrase', start: 0, end: 1, text: 'Edited original.', revisedText: 'Edited.', needsTimingReview: false }], approved: true }
}

function worker(words: unknown[], controller?: AbortController): NarrationWorker {
  const request = vi.fn(async (value: Record<string, unknown>): Promise<unknown> => {
    if (value.action === 'separate') {
      await writeFile(String(value.speech), 'speech')
      await writeFile(String(value.background), 'background')
      return { speechPath: value.speech, backgroundPath: value.background }
    }
    if (value.action === 'transcribe') {
      controller?.abort()
      return words
    }
    throw new Error('Unexpected narration action')
  })
  return { request } as unknown as NarrationWorker
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'otc-narration-reference-'))
  render.mockImplementation(async (args) => { await writeFile(String(args.at(-1)), 'original') })
})

afterEach(async () => {
  render.mockReset()
  await rm(directory, { recursive: true, force: true })
})

describe('prepared shared narration references', () => {
  it('renders up to 60 seconds from a short selection and keeps original anchors', async () => {
    const original = join(directory, 'saved-original.wav')
    await writeFile(original, 'saved')
    const value = await prepareNarrationVoiceReference(request(), draft(original), worker([
      { start: 2, end: 2.5, text: 'Original' }, { start: 3, end: 4, text: 'meaning.' }
    ]), new AbortController().signal)
    expect(render.mock.calls[0]?.[0]).toContain('60.000000000')
    expect(value).toMatchObject({ start: 2, end: 4, text: 'Original meaning.' })
    expect(value.path).not.toBe(original)
    expect(await readdir(dirname(value.path))).toEqual(['speech.wav'])
  })

  it('keeps the complete 60-second speaker span across long pauses', async () => {
    const original = join(directory, 'saved-original.wav')
    await writeFile(original, 'saved')
    const value = await prepareNarrationVoiceReference(request(), draft(original), worker([
      { start: 1, end: 2, text: 'First sentence.' },
      { start: 8, end: 9, text: 'Second sentence.' },
      { start: 20, end: 21, text: 'Third sentence.' },
      { start: 40, end: 41, text: 'Fourth sentence.' },
      { start: 58, end: 59, text: 'Last sentence.' }
    ]), new AbortController().signal)
    expect(value).toMatchObject({ start: 1, end: 59,
      text: 'First sentence. Second sentence. Third sentence. Fourth sentence. Last sentence.' })
  })

  it('clamps the extra window at the timeline end', async () => {
    const original = join(directory, 'saved-original.wav')
    await writeFile(original, 'saved')
    const value = await prepareNarrationVoiceReference(request(), draft(original, [95, 98]), worker([
      { start: 1, end: 2, text: 'Near end.' }
    ]), new AbortController().signal)
    expect(render.mock.calls[0]?.[0]).toContain('5.000000000')
    expect(value.end).toBeLessThanOrEqual(5)
  })

  it('transcribes original audio with separated speech only as VAD input without editing the draft', async () => {
    const original = join(directory, 'saved-original.wav')
    await writeFile(original, 'saved')
    const before = structuredClone(draft(original))
    const voice = worker([{ start: 0.5, end: 1, text: 'Keep original.' }])
    await prepareNarrationVoiceReference(request(), before, voice, new AbortController().signal)
    const calls = (voice as unknown as { request: { mock: { calls: [Record<string, unknown>][] } } }).request.mock.calls
    const transcribe = calls.find(([value]) => value.action === 'transcribe')?.[0]
    expect(transcribe?.input).toEqual(expect.stringContaining('original.wav'))
    expect(transcribe?.vadInput).toEqual(expect.stringContaining('speech.wav'))
    expect(transcribe?.language).toBe('auto')
    expect(transcribe).not.toHaveProperty('translateToEnglish')
    expect(transcribe).not.toHaveProperty('rewrite')
    expect(before).toEqual(draft(original))
  })

  it.each([
    ['empty recognition', []],
    ['filler-only recognition', [{ start: 0, end: 1, text: 'um' }]]
  ])('removes the helper directory on %s', async (_label, words) => {
    const original = join(directory, 'saved-original.wav')
    await writeFile(original, 'saved')
    await expect(prepareNarrationVoiceReference(request(), draft(original), worker(words), new AbortController().signal))
      .rejects.toThrow('speech')
    expect((await readdir(directory)).filter((name) => name.startsWith('.narration-reference-'))).toEqual([])
  })

  it('removes the helper directory when cancellation arrives after recognition', async () => {
    const original = join(directory, 'saved-original.wav')
    await writeFile(original, 'saved')
    const controller = new AbortController()
    await expect(prepareNarrationVoiceReference(request(), draft(original), worker([
      { start: 0, end: 1, text: 'Cancelled.' }
    ], controller), controller.signal)).rejects.toThrow()
    expect((await readdir(directory)).filter((name) => name.startsWith('.narration-reference-'))).toEqual([])
  })

  it.each(['separate', 'transcribe'])('cleans up after worker %s failure and preserves saved media', async (stage) => {
    const original = join(directory, 'saved-original.wav')
    await writeFile(original, 'saved')
    const requestWorker = vi.fn(async (value: Record<string, unknown>): Promise<unknown> => {
      if (value.action === stage) throw new Error(`${stage} failed`)
      if (value.action === 'separate') {
        await writeFile(String(value.speech), 'speech')
        await writeFile(String(value.background), 'background')
        return { speechPath: value.speech, backgroundPath: value.background }
      }
      throw new Error('Unexpected narration action')
    })
    await expect(prepareNarrationVoiceReference(request(), draft(original),
      { request: requestWorker } as unknown as NarrationWorker, new AbortController().signal))
      .rejects.toThrow(`${stage} failed`)
    expect((await readdir(directory)).filter((name) => name.startsWith('.narration-reference-'))).toEqual([])
    expect(await readFile(original, 'utf8')).toBe('saved')
  })

  it('cleans up after malformed ASR timestamps and preserves saved media', async () => {
    const original = join(directory, 'saved-original.wav')
    await writeFile(original, 'saved')
    await expect(prepareNarrationVoiceReference(request(), draft(original), worker([
      { start: -0.1, end: 1, text: 'Invalid anchor.' }
    ]), new AbortController().signal)).rejects.toThrow('timeline timestamps')
    expect((await readdir(directory)).filter((name) => name.startsWith('.narration-reference-'))).toEqual([])
    expect(await readFile(original, 'utf8')).toBe('saved')
  })
})
