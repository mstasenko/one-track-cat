import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NarrationReview } from '../narration-api'
import type { AudioOverlay, ExportRequest } from '../types'
import { narrationContentKey } from './narration-analysis'
import { narrationInputArgs } from './narration-input'
import { prepareNarrationSlice } from './narration-slice'
import * as audio from './narration-audio'

vi.mock('./binaries', () => ({ ffmpegPath: () => join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg') }))
const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
let directory: string
let draft: NarrationReview
let request: ExportRequest
let overlay: AudioOverlay
const signal = new AbortController().signal
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'otc-narration-slice-'))
  const original = join(directory, 'original.wav')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-ac', '2', '-c:a', 'pcm_f32le', original])
  draft = { id: 'parent', stage: 'cleaned', approved: true, contentKey: 'parent', range: [0, 3], language: 'en', strength: 'balanced',
    originalPath: original, speechPath: original, backgroundPath: original,
    phrases: [0, 1, 2].map((start) => ({ id: `p${start}`, start, end: start + 0.8,
      text: `Original ${start}.`, revisedText: `Revised ${start}.`, needsTimingReview: false })) }
  overlay = { id: 'piece', type: 'audio', path: original, name: 'Re-voice', sourceIn: 2, start: 1, duration: 1,
    volume: 1, zIndex: 0, narration: { draftId: draft.id, enabled: true } }
  request = { outputPath: '', canvas: { width: 64, height: 36, fps: 30, fit: 'contain' }, overlays: [overlay],
    sources: [{ id: 's', metadata: { path: original, name: 'original', size: 1, modifiedAt: 1,
      width: 64, height: 36, fps: 30, duration: 3, videoCodec: 'h264', hasAudio: true } }],
    segments: [{ id: 'left', sourceId: 's', sourceStart: 0, sourceEnd: 1 },
      { id: 'right', sourceId: 's', sourceStart: 2, sourceEnd: 3 }] }
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('Narration pieces', () => {
  it('reuses a verified recording for narration-only splits instead of independently decoding it again', async () => {
    request.segments = [{ id: 'whole', sourceId: 's', sourceStart: 0, sourceEnd: 3 }]
    overlay = { ...overlay, start: 1, sourceIn: 1 }
    draft.contentKey = narrationContentKey(request, draft.range, 'models')
    const render = vi.spyOn(audio, 'narrationFfmpeg')
    try {
      const piece = await prepareNarrationSlice(draft, request, overlay, 'models', directory, signal)
      expect(piece.phrases.map((p) => p.id)).toEqual(['p1'])
      expect(piece.contentKey).toBe(narrationContentKey(request, [1, 2], 'models'))
      expect(render).toHaveBeenCalledTimes(3)
      expect(render.mock.calls.every(([args]) => args.includes('-af') && !args.includes('-filter_complex'))).toBe(true)
    } finally { render.mockRestore() }
  })
  it('keeps the whole edited phrase when a piece clips its acoustic tail', async () => {
    request.segments = [{ id: 'whole', sourceId: 's', sourceStart: 0, sourceEnd: 3 }]
    const original = draft.phrases[2]
    if (!original) throw new Error('Missing phrase')
    const phrase = { ...original, start: 2, end: 2.8,
      text: 'Original whole phrase.', revisedText: "We'll try to fix this sticking now. [1s] I'll apply throttle-body cleaner here.",
      referenceEnd: 2.25, referenceText: 'Original whole phrase.' }
    draft = { ...draft, phrases: [phrase], voiceReference: {
      path: draft.speechPath, start: 0, end: 3, text: 'Global speaker sample.'
    }, contentKey: narrationContentKey(request, draft.range, 'models') }
    const piece = await prepareNarrationSlice(draft, request,
      { ...overlay, start: 2.5, sourceIn: 2.5, duration: 0.5 }, 'models', directory, signal)
    expect(piece.voiceReference).toEqual(draft.voiceReference)
    expect(piece.phrases).toEqual([{ id: phrase.id, start: 0, end: 0.2999999999999998,
      text: phrase.text, revisedText: phrase.revisedText, needsTimingReview: phrase.needsTimingReview }])
  })
  it('does not reuse a recording whose source recipe changed', async () => {
    request.segments = [{ id: 'whole', sourceId: 's', sourceStart: 0, sourceEnd: 3 }]
    overlay = { ...overlay, start: 1, sourceIn: 1 }
    draft.contentKey = narrationContentKey(request, draft.range, 'models')
    const altered = join(directory, 'changed.wav')
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
      '-ac', '2', '-c:a', 'pcm_f32le', altered])
    const source = request.sources[0]
    if (!source) throw new Error('Missing source')
    source.metadata.path = altered
    await expect(prepareNarrationSlice(draft, request, overlay, 'models', directory, signal)).rejects.toThrow('audio')
  })
  it('accepts independent one-sample source-seek jitter without losing the transcript', async () => {
    const shiftedRequest = { ...request, segments: [
      { kind: 'freeze' as const, id: 'gap', sourceId: 's', sourceTime: 0, duration: 1 },
      { id: 'first', sourceId: 's', sourceStart: 0, sourceEnd: 1 },
      { id: 'second', sourceId: 's', sourceStart: 1, sourceEnd: 2 }
    ] }
    const current = join(directory, 'rendered-current.wav')
    execFileSync(ffmpeg, narrationInputArgs(shiftedRequest, [1, 3], current))
    const cached = join(directory, 'shifted-cache.wav')
    execFileSync(ffmpeg, ['-v', 'error', '-i', current, '-filter_complex',
      '[0:a]asplit=2[firstInput][secondInput];' +
      '[firstInput]atrim=start_sample=1,asetpts=PTS-STARTPTS,apad=whole_len=48000,atrim=end_sample=48000[first];' +
      '[secondInput]atrim=start_sample=48000,asetpts=PTS-STARTPTS,apad=whole_len=48000,atrim=end_sample=48000[second];' +
      '[first][second]concat=n=2:v=0:a=1,asetpts=PTS-STARTPTS[output]',
      '-map', '[output]', '-map_metadata', '-1', '-c:a', 'pcm_f32le', '-n', cached])
    const cachedDraft = { ...draft, range: [0, 2] as [number, number], phrases: draft.phrases.slice(0, 2),
      originalPath: cached, speechPath: cached, backgroundPath: cached, contentKey: 'stale' }
    const piece = await prepareNarrationSlice(cachedDraft, shiftedRequest,
      { ...overlay, start: 1, duration: 2, sourceIn: 0 }, 'models', directory, signal)
    expect(piece.phrases.map(({ id }) => id)).toEqual(['p0', 'p1'])
    expect(piece.range).toEqual([1, 3])
  })
  it('forks a cut piece with local stems and transcript without touching its parent', async () => {
    const piece = await prepareNarrationSlice(draft, request, overlay, 'models', directory, signal)
    expect(piece.range).toEqual([1, 2])
    expect(piece.phrases).toEqual([{ ...draft.phrases[2], start: 0, end: 0.7999999999999998 }])
    expect(piece.contentKey).toBe(narrationContentKey(request, [1, 2], 'models'))
    expect(piece.originalPath).not.toBe(draft.originalPath)
    for (const path of [piece.originalPath, piece.speechPath, piece.backgroundPath]) expect((await stat(path)).size).toBeGreaterThan(0)
    expect(await readdir(dirname(piece.originalPath))).toEqual(['background.wav', 'original.wav', 'speech.wav'])
    expect(draft.phrases).toHaveLength(3)
    const probe = execFileSync(ffmpeg, ['-v', 'error', '-i', piece.speechPath, '-f', 'f32le', '-'], { maxBuffer: 1_000_000 })
    expect(probe.length).toBe(48000 * 8)
  })
  it('handles a full piece shifted by an insertion elsewhere', async () => {
    request.segments = [{ kind: 'freeze', id: 'gap', sourceId: 's', sourceTime: 0, duration: 1 },
      { id: 'whole', sourceId: 's', sourceStart: 0, sourceEnd: 3 }]
    const piece = await prepareNarrationSlice(draft, request, { ...overlay, sourceIn: 0, duration: 3 }, 'models', directory, signal)
    expect(piece.range).toEqual([1, 4])
    expect(piece.phrases).toEqual(draft.phrases)
  })
  it('rejects changed audio and removes its incomplete files', async () => {
    const altered = join(directory, 'different.wav')
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
      '-ac', '2', '-c:a', 'pcm_f32le', altered])
    const source = request.sources[0]
    if (!source) throw new Error('Missing test source')
    source.metadata.path = altered
    await expect(prepareNarrationSlice(draft, request, overlay, 'models', directory, signal)).rejects.toThrow('audio')
    expect(await readdir(directory)).toEqual(['different.wav', 'original.wav'])
  })
  it('keeps uncut pieces and rejects speed-invalidated pieces', async () => {
    expect(await prepareNarrationSlice(draft, request, { ...overlay, start: 0, sourceIn: 0, duration: 3 },
      'models', directory, signal)).toBe(draft)
    await expect(prepareNarrationSlice(draft, request, { ...overlay,
      narration: { draftId: draft.id, enabled: false, invalidated: true } }, 'models', directory, signal)).rejects.toThrow('speed')
  })
})
