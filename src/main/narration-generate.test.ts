import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NarrationDraft } from './narration-analysis'
import type { NarrationWorker } from './narration-worker'
import { generateNarrationAudio } from './narration-generate'
import { NarrationTimingError } from '../narration'

vi.mock('./binaries', () => ({ ffmpegPath: () => join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg') }))
const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

function tone(path: string, duration: number, volume = 0.1): void {
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${volume}:s=48000:d=${duration}`,
    '-c:a', 'pcm_f32le', path])
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'otc-narration-assembly-'))
  directories.push(directory)
  const speechPath = join(directory, 'speech.wav')
  const backgroundPath = join(directory, 'background.wav')
  tone(speechPath, 4, 0.3)
  tone(backgroundPath, 4, 0.02)
  const draft: NarrationDraft = { approved: true, contentKey: 'original-audio', range: [10, 14], language: 'en', strength: 'balanced',
    originalPath: speechPath, speechPath, backgroundPath,
    phrases: [{ id: 'p1', text: 'Original reference.', revisedText: 'Clear narration.', start: 1, end: 3, needsTimingReview: false }] }
  const subtitleInputs: string[] = []
  const subtitleSnapshots: { format: number; channels: number; sampleRate: number; leadingRms: number; voiceRms: number; trailingRms: number }[] = []
  const request = vi.fn((value: Record<string, unknown>): Promise<unknown> => {
    if (value.action === 'transcribe') {
      const input = value.input
      if (typeof input !== 'string') throw new Error('Missing subtitle input')
      subtitleInputs.push(input)
      const header = readFileSync(input)
      const samples = new Float32Array(Uint8Array.from(execFileSync(ffmpeg,
        ['-v', 'error', '-i', input, '-f', 'f32le', '-ac', '1', 'pipe:1'], { maxBuffer: 16 * 1024 ** 2 })).buffer)
      const rms = (start: number, end: number): number => {
        const first = Math.floor(start * 48000)
        const last = Math.min(samples.length, Math.ceil(end * 48000))
        return Math.sqrt(samples.slice(first, last).reduce((sum, sample) => sum + sample * sample, 0) / (last - first))
      }
      subtitleSnapshots.push({ format: header.readUInt16LE(20), channels: header.readUInt16LE(22), sampleRate: header.readUInt32LE(24),
        leadingRms: rms(0, 0.9), voiceRms: rms(1.2, 1.8), trailingRms: rms(3.1, 3.9) })
      return Promise.resolve([{ start: 1, end: 2, text: 'Clear' }])
    }
    const phrases = value.phrases as { output: string }[]
    for (const phrase of phrases) if (!existsSync(phrase.output)) tone(phrase.output, 1, 0.1)
    return Promise.resolve(phrases.map(() => 1))
  })
  const worker = { request } as unknown as NarrationWorker
  return { directory, draft, worker, request, subtitleInputs, subtitleSnapshots }
}

describe('Narration assembly', () => {
  it('transcribes the assembled speech-only PCM before background mixing', async () => {
    const { directory, draft, worker, request, subtitleInputs, subtitleSnapshots } = await fixture()
    const stages: string[] = []
    let words: unknown
    const output = await generateNarrationAudio(draft, directory, worker, new AbortController().signal,
      (stage, fraction) => { stages.push(`${stage}:${fraction}`) }, (value) => { words = value })
    expect(output).toMatch(/-mix\.wav$/)
    expect(words).toEqual([{ start: 1, end: 2, text: 'Clear' }])
    expect(request.mock.calls.map(([value]) => value.action)).toEqual(['synthesize', 'transcribe'])
    expect(request.mock.calls[1]?.[0]).toMatchObject({ action: 'transcribe', language: 'auto' })
    const subtitleInput = subtitleInputs[0]
    if (!subtitleInput) throw new Error('Missing subtitle input')
    const snapshot = subtitleSnapshots[0]
    if (!snapshot) throw new Error('Missing subtitle audio snapshot')
    expect(snapshot.format).toBe(3) // IEEE float PCM
    expect(snapshot.channels).toBe(1)
    expect(snapshot.sampleRate).toBe(48000)
    expect(snapshot.leadingRms).toBeLessThan(0.001)
    expect(snapshot.voiceRms).toBeGreaterThan(0.03)
    expect(snapshot.trailingRms).toBeLessThan(0.001)
    expect(stages).toContain('Checking narration:0')
    expect(stages).toContain('Checking narration:1')
    expect(existsSync(subtitleInput)).toBe(false)
  })

  it('checks narration even when no subtitle callback is supplied', async () => {
    const { directory, draft, worker, request, subtitleInputs } = await fixture()
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    expect(request.mock.calls.map(([value]) => value.action)).toEqual(['synthesize', 'transcribe'])
    expect(subtitleInputs).toHaveLength(1)
    expect((await readdir(directory)).some((name) => name.endsWith('-speech-check.wav'))).toBe(false)
  })

  it('reports the actual applied speed only after a successful mix', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.phrases = [{ ...draft.phrases[0], id: 'speed', start: 0, end: 4,
      text: 'Original.', revisedText: 'Generated.', needsTimingReview: false }]
    request.mockImplementation((value: Record<string, unknown>) => {
      if (value.action === 'transcribe') return Promise.resolve([])
      const phrases = value.phrases as { output: string }[]
      for (const phrase of phrases) tone(phrase.output, 4.4)
      return Promise.resolve([4.4])
    })
    const report = vi.fn()
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal, undefined, undefined, report)
    expect(report).toHaveBeenCalledWith('speed', 1.1)
    expect(draft.phrases[0]?.generatedTempo).toBeUndefined()
    request.mockResolvedValueOnce([5])
    report.mockClear()
    await expect(generateNarrationAudio(draft, directory, worker, new AbortController().signal,
      undefined, undefined, report)).rejects.toThrow('does not fit')
    expect(report).not.toHaveBeenCalled()
  })

  it('skips a blank middle phrase without extending the previous fixed window', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.slowdown = 0.15
    draft.backgroundVolume = 0
    draft.phrases = [
      { id: 'p1', text: 'First original.', revisedText: 'First.', start: 0.5, end: 1.4, needsTimingReview: false },
      { id: 'p2', text: 'Omitted original.', revisedText: '  ', start: 1.5, end: 2.4, needsTimingReview: false },
      { id: 'p3', text: 'Third original.', revisedText: 'Third.', start: 2.5, end: 3.4, needsTimingReview: false }
    ]
    const output = await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    expect(request.mock.calls.map(([value]) => value.action)).toEqual(['synthesize', 'transcribe'])
    const synthesis = request.mock.calls.find(([value]) => value.action === 'synthesize')?.[0]
    expect((synthesis?.phrases as { text: string }[]).map((phrase) => phrase.text)).toEqual(['First.', 'Third.'])
    expect((await readdir(directory)).filter((name) => name.startsWith('reference-'))).toHaveLength(1)
    const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'f32le', '-ac', '2', 'pipe:1'], { maxBuffer: 4 * 1024 ** 2 })
    const audio = new Float32Array(Uint8Array.from(pcm).buffer)
    const maxAbs = (start: number, end: number): number => {
      const first = Math.floor(start * 48000 * 2)
      const last = Math.ceil(end * 48000 * 2)
      let maximum = 0
      for (const sample of audio.subarray(first, last)) maximum = Math.max(maximum, Math.abs(sample))
      return maximum
    }
    expect(maxAbs(1.52, 2.45)).toBeLessThan(0.001)
    expect(maxAbs(2.6, 3.3)).toBeGreaterThan(0.03)
  })

  it('uses the first suitable reference for edited words in an uncertain long ASR slot', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.range = [0, 24]
    draft.phrases = [
      { id: 'first', start: 0, end: 1, text: 'First reference.', revisedText: '', needsTimingReview: false },
      { id: 'stretched', start: 3, end: 21, text: 'так', revisedText: "It's loose now.", needsTimingReview: false },
      { id: 'last', start: 21, end: 23, text: 'Later reference.', revisedText: '', needsTimingReview: false }
    ]
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    const phrases = request.mock.calls[0]?.[0].phrases as { text: string; referenceText: string }[]
    expect(phrases).toMatchObject([{ text: "It's loose now.", referenceText: 'First reference.' }])
    expect(draft.phrases[1]).toMatchObject({ start: 3, end: 21 })
    const stretched = draft.phrases[1]
    if (!stretched) throw new Error('Missing stretched phrase')
    draft.phrases = [stretched]
    await expect(generateNarrationAudio(draft, directory, worker, new AbortController().signal)).rejects.toThrow('Review phrase timing')
  })

  it('does not request a voice reference for an omitted stretched word', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.range = [10, 30]
    draft.phrases = [{ id: 'uncertain', start: 1, end: 19, text: 'так', revisedText: '', needsTimingReview: false }]
    await expect(generateNarrationAudio(draft, directory, worker, new AbortController().signal)).resolves.toMatch(/-mix\.wav$/)
    expect(request).not.toHaveBeenCalled()
    expect((await readdir(directory)).some((name) => name.startsWith('reference-'))).toBe(false)
  })

  it('renders an all-blank draft as background-only audio without worker calls', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.phrases = [
      { id: 'p1', text: 'First original.', revisedText: ' ', start: 0.5, end: 1.4, needsTimingReview: false },
      { id: 'p2', text: 'Second original.', revisedText: '\t', start: 2, end: 2.8, needsTimingReview: false }
    ]
    let words: unknown
    const output = await generateNarrationAudio(draft, directory, worker, new AbortController().signal,
      () => undefined, (value) => { words = value })
    expect(request).not.toHaveBeenCalled()
    expect(words).toEqual([])
    expect((await readdir(directory)).filter((name) => name.startsWith('reference-') || name.includes('-speech-check'))).toEqual([])
    const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'f32le', '-ac', '2', 'pipe:1'], { maxBuffer: 4 * 1024 ** 2 })
    const audio = new Float32Array(Uint8Array.from(pcm).buffer)
    expect(audio.length).toBe(4 * 48000 * 2)
    expect(audio[96_000]).toBeGreaterThan(0.005)
    expect(audio[96_000]).toBeLessThan(0.03)
  })

  it('leaves a marker-only phrase as background without invoking synthesis', async () => {
    const { directory, draft, worker, request } = await fixture()
    const phrase = draft.phrases[0]
    if (!phrase) throw new Error('Missing phrase fixture')
    draft.phrases = [{ ...phrase, revisedText: '[500ms][1s]', start: 0, end: 3 }]
    const output = await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    expect(request).not.toHaveBeenCalled()
    expect((await readdir(directory)).filter((name) => name.startsWith('reference-') || name.startsWith('utterance-'))).toEqual([])
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'f32le', '-ac', '2', 'pipe:1'], { maxBuffer: 4 * 1024 ** 2 })
    const audio = new Float32Array(Uint8Array.from(raw).buffer)
    expect(audio.length).toBe(4 * 48000 * 2)
    for (const second of [0.5, 1.5, 2.5, 3.5]) {
      const sample = audio[Math.round(second * 48000 * 2)]
      expect(sample).toBeGreaterThan(0.005)
      expect(sample).toBeLessThan(0.03)
    }
  })

  it('places leading, middle, and trailing pauses exactly and reuses their cached audio', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.backgroundVolume = 0
    const phrase = draft.phrases[0]
    if (!phrase) throw new Error('Missing phrase fixture')
    draft.phrases = [{ ...phrase, id: 'pause', revisedText: '[500ms]Lead[1s]Middle[500ms]Tail[500ms]', start: 0, end: 3 }]
    const synthesized: string[] = []
    request.mockImplementation((value: Record<string, unknown>) => {
      if (value.action === 'transcribe') return Promise.resolve([])
      const phrases = value.phrases as { text: string; output: string }[]
      for (const phrase of phrases) {
        if (!existsSync(phrase.output)) {
          tone(phrase.output, 0.25)
          synthesized.push(phrase.text)
        }
      }
      return Promise.resolve(phrases.map(() => 0.25))
    })
    const firstOutput = await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', firstOutput, '-f', 'f32le', '-ac', '1', 'pipe:1'], { maxBuffer: 4 * 1024 ** 2 })
    const audio = new Float32Array(Uint8Array.from(raw).buffer)
    expect(audio.length).toBe(4 * 48000)
    const peak = (start: number, end: number): number => {
      let maximum = 0
      for (const sample of audio.subarray(Math.floor(start * 48000), Math.ceil(end * 48000))) maximum = Math.max(maximum, Math.abs(sample))
      return maximum
    }
    expect(peak(0.1, 0.4)).toBeLessThan(0.001)
    expect(peak(0.55, 0.7)).toBeGreaterThan(0.03)
    expect(peak(0.85, 1.65)).toBeLessThan(0.001)
    expect(peak(1.8, 1.95)).toBeGreaterThan(0.03)
    expect(peak(2.1, 2.4)).toBeLessThan(0.001)
    expect(peak(2.55, 2.7)).toBeGreaterThan(0.03)
    expect(peak(2.85, 3.15)).toBeLessThan(0.001)
    expect(peak(3.35, 3.9)).toBeLessThan(0.001)
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    expect(synthesized).toEqual(['Lead', 'Middle', 'Tail'])
    const synthesis = request.mock.calls.filter(([value]) => value.action === 'synthesize')
    expect(synthesis).toHaveLength(2)
    expect(synthesis[1]?.[0].phrases).toEqual(synthesis[0]?.[0].phrases)
    expect((await readdir(directory)).filter((name) => name.startsWith('reference-'))).toHaveLength(1)
    expect((await readdir(directory)).filter((name) => name.startsWith('utterance-pause-') && !name.startsWith('utterance-pause-part-'))).toHaveLength(1)
  })

  it('cleans an interrupted pause assembly while retaining reusable part audio', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.backgroundVolume = 0
    const phrase = draft.phrases[0]
    if (!phrase) throw new Error('Missing phrase fixture')
    draft.phrases = [{ ...phrase, id: 'cancel-pause', revisedText: '[500ms]Lead[1s]Tail', start: 0, end: 3 }]
    const controller = new AbortController()
    request.mockImplementation((value: Record<string, unknown>) => {
      if (value.action === 'transcribe') return Promise.resolve([])
      const phrases = value.phrases as { output: string }[]
      for (const phrase of phrases) tone(phrase.output, 0.25)
      controller.abort()
      return Promise.resolve(phrases.map(() => 0.25))
    })
    await expect(generateNarrationAudio(draft, directory, worker, controller.signal)).rejects.toThrow()
    const entries = await readdir(directory)
    expect(entries.some((name) => name.includes('-pause-assembly'))).toBe(false)
    expect(entries.some((name) => name.startsWith('utterance-pause-') && !name.startsWith('utterance-pause-part-'))).toBe(false)
    expect(entries.filter((name) => name.startsWith('utterance-pause-part-'))).toHaveLength(2)
    expect(entries.some((name) => name.endsWith('-voice.f32le') || name.endsWith('-mix.wav'))).toBe(false)
  })

  it('cleans the subtitle source when word alignment fails', async () => {
    const { directory, draft, worker, request, subtitleInputs } = await fixture()
    request.mockImplementation((value: Record<string, unknown>) => {
      if (value.action === 'transcribe') {
        const input = value.input
        if (typeof input === 'string') subtitleInputs.push(input)
        return Promise.reject(new Error('Whisper alignment failed'))
      }
      const phrases = value.phrases as { output: string }[]
      for (const phrase of phrases) if (!existsSync(phrase.output)) tone(phrase.output, 1, 0.1)
      return Promise.resolve(phrases.map(() => 1))
    })
    await expect(generateNarrationAudio(draft, directory, worker, new AbortController().signal,
      () => undefined, () => undefined)).rejects.toThrow('Whisper alignment failed')
    const subtitleInput = subtitleInputs[0]
    if (!subtitleInput) throw new Error('Missing subtitle input')
    expect(existsSync(subtitleInput)).toBe(false)
    expect((await readdir(directory)).some((name) => name.endsWith('-voice.f32le') || name.endsWith('-speech-check.wav') || name.endsWith('-mix.wav'))).toBe(false)
    expect(request.mock.calls.map(([value]) => value.action)).toEqual(['synthesize', 'transcribe'])
  })

  it('remixes cached speech at the selected slowdown without extending the fragment', async () => {
    const { directory, draft, worker, request } = await fixture()
    const normal = await generateNarrationAudio({ ...draft, slowdown: 0, backgroundVolume: 0 }, directory, worker, new AbortController().signal)
    const slow = await generateNarrationAudio({ ...draft, slowdown: 0.5, backgroundVolume: 0 }, directory, worker, new AbortController().signal)
    const decode = (path: string): Float32Array => new Float32Array(Uint8Array.from(execFileSync(ffmpeg,
      ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', 'pipe:1'], { maxBuffer: 4 * 1024 ** 2 })).buffer)
    const originalPace = decode(normal)
    const slowerPace = decode(slow)
    expect(originalPace.length).toBe(4 * 48000 * 2)
    expect(slowerPace.length).toBe(originalPace.length)
    expect(originalPace[240_000]).toBe(0)
    expect(slowerPace[240_000]).toBeGreaterThan(0.05)
    const synthesis = request.mock.calls.filter(([value]) => value.action === 'synthesize')
    expect(synthesis[1]?.[0].phrases).toEqual(synthesis[0]?.[0].phrases)
  })

  it('remixes cached speech after a mix change without regenerating its utterances', async () => {
    const { directory, draft, worker, request } = await fixture()
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    const synthesis = (): Record<string, unknown>[] => request.mock.calls
      .filter(([value]) => value.action === 'synthesize').map(([value]) => value)
    const first = synthesis()[0]?.phrases as { output: string }[]
    const output = await generateNarrationAudio({ ...draft, levelVoice: true, backgroundVolume: 0 }, directory, worker, new AbortController().signal)
    const second = synthesis()[1]?.phrases as { output: string }[]
    expect(second).toEqual(first)
    const audio = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'f32le', '-ac', '2', 'pipe:1'], { maxBuffer: 4 * 1024 ** 2 })
    const samples = new Float32Array(Uint8Array.from(audio).buffer)
    expect(samples.length).toBe(4 * 48000 * 2)
    expect(samples[48_000]).toBe(0)
  })
  it('cleans failed mix temporaries while retaining successful output and cached speech', async () => {
    const { directory, draft, worker, request } = await fixture()
    const successful = await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    const cached = request.mock.calls.find(([value]) => value.action === 'synthesize')?.[0].phrases as { output: string; reference: string }[]
    const missingBackground = join(directory, 'missing-background.wav')
    await expect(generateNarrationAudio({ ...draft, backgroundPath: missingBackground }, directory, worker,
      new AbortController().signal)).rejects.toThrow()
    const entries = await readdir(directory)
    expect(entries.some((entry) => entry.endsWith('-voice.f32le'))).toBe(false)
    expect(entries.filter((entry) => entry.endsWith('-mix.wav'))).toEqual([basename(successful)])
    expect(existsSync(successful)).toBe(true)
    for (const phrase of cached) {
      expect(existsSync(phrase.output)).toBe(true)
      expect(existsSync(phrase.reference)).toBe(true)
    }
  })
  it('synthesizes a long sentence with a short original reference and unchanged video duration', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.range = [10, 35]
    const phrase = draft.phrases[0]
    if (!phrase) throw new Error('Missing phrase fixture')
    draft.phrases = [{ ...phrase, start: 0, end: 25, referenceEnd: 2, referenceText: 'Short original reference.' }]
    const output = await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    const generated = request.mock.calls.find(([value]) => value.action === 'synthesize')?.[0].phrases as { reference: string; referenceText: string }[]
    expect(generated[0]?.referenceText).toBe('Short original reference.')
    const reference = generated[0]?.reference
    if (!reference) throw new Error('Missing audio reference')
    const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', reference, '-f', 'f32le', '-ac', '1', 'pipe:1'])
    expect(pcm.length / 4 / 48000).toBeCloseTo(2.2, 4)
    const referenceSamples = new Float32Array(Uint8Array.from(pcm).buffer)
    expect(Math.max(...referenceSamples.subarray(-9600).map(Math.abs))).toBe(0)
    expect(referenceSamples[48000]).toBeGreaterThan(0)
    const final = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'f32le', '-ac', '2', 'pipe:1'], { maxBuffer: 12 * 1024 ** 2 })
    expect(final.length / 8 / 48000).toBe(25)
  })
  it('removes raw alignment audio on cancellation while keeping reusable speech', async () => {
    const { directory, draft, worker, request } = await fixture()
    const controller = new AbortController()
    await expect(generateNarrationAudio(draft, directory, worker, controller.signal, (stage) => {
      if (stage === 'Aligning narration') controller.abort()
    })).rejects.toThrow()
    const entries = await readdir(directory)
    expect(entries.some((name) => name.endsWith('-voice.f32le') || name.endsWith('-mix.wav'))).toBe(false)
    const phrase = (request.mock.calls.find(([value]) => value.action === 'synthesize')?.[0].phrases as { output: string }[])[0]
    expect(phrase && existsSync(phrase.output)).toBe(true)
  })
  it('keeps exact timing and environment-only gaps without mixing the original voice', async () => {
    const { directory, draft, worker, request } = await fixture()
    const output = await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'synthesize', phrases: [expect.objectContaining({ referenceText: 'Original reference.', text: 'Clear narration.' })] }))
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'f32le', '-ac', '2', 'pipe:1'], { maxBuffer: 4 * 1024 ** 2 })
    const audio = new Float32Array(Uint8Array.from(raw).buffer)
    expect(audio.length).toBe(4 * 48000 * 2)
    expect(audio[48000]).toBeCloseTo(0.02 * Math.SQRT1_2, 4)
    expect(audio[144000]).toBeGreaterThan(0.08)
    expect(audio[336000]).toBeCloseTo(0.02 * Math.SQRT1_2, 4)
    expect(audio.every((value) => Number.isFinite(value) && value < 0.2)).toBe(true)
    await expect(readFile(output)).resolves.toBeInstanceOf(Buffer)
  })

  it('rejects overlong speech without truncating or shifting video', async () => {
    const { directory, draft, worker, request } = await fixture()
    request.mockImplementation((value: Record<string, unknown>) => {
      if (value.action === 'transcribe') return Promise.resolve([])
      for (const phrase of value.phrases as { output: string }[]) tone(phrase.output, 4)
      return Promise.resolve([4])
    })
    await expect(generateNarrationAudio(draft, directory, worker, new AbortController().signal)).rejects.toThrow('does not fit')
    const error = await generateNarrationAudio(draft, directory, worker, new AbortController().signal).catch((reason: unknown) => reason)
    if (!(error instanceof NarrationTimingError)) throw new Error('Missing timing feedback')
    expect(error.overruns).toMatchObject([{ id: 'p1', text: 'Clear narration.' }])
    expect(error.overruns[0]?.extraSeconds).toBeCloseTo(4 / 1.15 - 3, 8)
  })

  it('reports every overrun, using the pause before the next fixed start', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.phrases = [
      { id: 'p1', text: 'One.', revisedText: 'First.', start: 0, end: 1, needsTimingReview: false },
      { id: 'p2', text: 'Two.', revisedText: 'Second.', start: 2, end: 3, needsTimingReview: false }
    ]
    request.mockImplementation((value: Record<string, unknown>) => {
      if (value.action === 'transcribe') return Promise.resolve([])
      for (const [index, phrase] of (value.phrases as { output: string }[]).entries()) tone(phrase.output, index + 3)
      return Promise.resolve([3, 4])
    })
    const error = await generateNarrationAudio(draft, directory, worker, new AbortController().signal).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(NarrationTimingError)
    if (!(error instanceof NarrationTimingError)) throw new Error('Missing timing feedback')
    expect(error).toMatchObject({ overruns: [
      { id: 'p1', text: 'First.' },
      { id: 'p2', text: 'Second.' }
    ] })
    expect(error.overruns[0]?.extraSeconds).toBeCloseTo(3 / 1.15 - 2, 8)
    expect(error.overruns[1]?.extraSeconds).toBeCloseTo(4 / 1.15 - 2, 8)
  })

  it('rejects invalid model results and uncertain reference timing', async () => {
    const { directory, draft, worker, request } = await fixture()
    request.mockImplementation((value: Record<string, unknown>) => value.action === 'transcribe' ? Promise.resolve([]) : Promise.resolve([NaN]))
    await expect(generateNarrationAudio(draft, directory, worker, new AbortController().signal)).rejects.toThrow('invalid phrase')
    draft.phrases = draft.phrases.map((phrase) => ({ ...phrase, needsTimingReview: true }))
    await expect(generateNarrationAudio(draft, directory, worker, new AbortController().signal)).rejects.toThrow('Review phrase timing')
  })

  it('shares one original reference across phrases and keeps unchanged cached speech', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.phrases = [
      { id: 'p1', text: 'Excited original!', revisedText: 'Exciting!', start: 1, end: 2, needsTimingReview: false },
      { id: 'p2', text: 'Quiet original.', revisedText: 'Quiet.', start: 2, end: 3, needsTimingReview: false }
    ]
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    interface Phrase { reference: string; referenceText: string; output: string }
    const first = request.mock.calls.find(([value]) => value.action === 'synthesize')?.[0].phrases as Phrase[]
    expect(first.map((phrase) => phrase.referenceText)).toEqual([
      'Excited original! Quiet original.', 'Excited original! Quiet original.'
    ])
    expect(first[0]?.reference).toBe(first[1]?.reference)
    for (const phrase of first) {
      const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', phrase.reference, '-f', 'f32le', 'pipe:1'])
      // The exact shared reference plus its silent ending.
      expect(raw.length / 4).toBe(Math.round(2.2 * 48000))
    }
    draft.phrases = draft.phrases.map((phrase, index) => index === 0 ? { ...phrase, revisedText: 'Amazing!' } : phrase)
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    const second = request.mock.calls.filter(([value]) => value.action === 'synthesize')[1]?.[0].phrases as Phrase[]
    expect(second[0]?.reference).toBe(first[0]?.reference)
    expect(second[0]?.output).not.toBe(first[0]?.output)
    expect(second[1]?.output).toBe(first[1]?.output)
  })

  it('uses an exact short original reference without unrelated speech', async () => {
    const { directory, draft, worker, request } = await fixture()
    draft.phrases = draft.phrases.map((phrase) => ({ ...phrase, start: 1, end: 1.2, text: 'Wow!', revisedText: 'Wow!' }))
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    const phrases = request.mock.calls.find(([value]) => value.action === 'synthesize')?.[0].phrases as { reference: string; referenceText: string }[]
    const phrase = phrases[0]
    if (!phrase) throw new Error('Missing test phrase')
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', phrase.reference, '-f', 'f32le', 'pipe:1'])
    expect(phrase.referenceText).toBe('Wow!')
    expect(raw.length / 4).toBe(0.4 * 48000)
  })

  it('invalidates synthesized speech, but not original references, after a voice-style change', async () => {
    const { directory, draft, worker, request } = await fixture()
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    draft.voiceStyle = 'cosy'
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    const synthesis = request.mock.calls.filter(([value]) => value.action === 'synthesize')
    const before = synthesis[0]?.[0]
    const after = synthesis[1]?.[0]
    expect(after?.voiceStyle).toBe('cosy')
    const first = (before?.phrases as { reference: string; output: string }[])[0]
    const second = (after?.phrases as { reference: string; output: string }[])[0]
    expect(second?.reference).toBe(first?.reference)
    expect(second?.output).not.toBe(first?.output)
  })

  it('cancels before rendering or inference when already aborted', async () => {
    const { directory, draft, worker, request } = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(generateNarrationAudio(draft, directory, worker, controller.signal)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})
