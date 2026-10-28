import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NarrationDraft } from './narration-analysis'
import type { NarrationWorker } from './narration-worker'
import { generateNarrationAudio } from './narration-generate'
import { silenceNarrationTails } from './narration-audio'
import { narrationSampleRate } from '../narration'
import { narrationSpeechTailRanges } from '../narration-subtitles'

vi.mock('./binaries', () => ({ ffmpegPath: () => join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg') }))
const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

function seconds(samples: number): number {
  return samples / narrationSampleRate
}

function tone(path: string, duration: number, volume: number, gap?: [number, number]): void {
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${volume}:s=48000:d=${duration}`,
    ...(gap ? ['-af', `volume=0:enable='between(t,${gap[0]},${gap[1]})'`] : []),
    '-c:a', 'pcm_f32le', path])
}

const targetWords = [
  { start: seconds(26_400), end: seconds(33_600), text: 'The' },
  { start: seconds(33_600), end: seconds(45_600), text: 'passage' },
  { start: seconds(45_600), end: seconds(50_400), text: 'is' },
  { start: seconds(50_400), end: seconds(52_800), text: 'private' },
  { start: seconds(52_800), end: seconds(57_600), text: 'cleaning' },
  { start: seconds(60_000), end: seconds(67_200), text: 'unexpected' },
  { start: seconds(69_600), end: seconds(76_800), text: 'tail' }
] as const

describe('Narration speech-tail cleanup', () => {
  it('returns stereo 48 kHz candidates only after a full target match', () => {
    const phrase = { id: 'p1', text: 'The passage is private cleaning', revisedText: 'The passage is private cleaning',
      start: seconds(24_000), end: seconds(96_000), needsTimingReview: false }
    const placement = { id: 'p1', startSample: 24_000, windowSamples: 168_000, generatedSamples: 72_000,
      tempo: 1, needsReview: false }
    expect(narrationSpeechTailRanges([phrase], targetWords, 4, [placement])).toEqual([[59_520, 96_000]])
  })

  it('fades only the requested raw stereo PCM range without changing its length', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-narration-tail-'))
    directories.push(directory)
    const path = join(directory, 'voice.f32le')
    const original = Buffer.alloc(96_000 * 8)
    for (let frame = 0; frame < 96_000; frame += 1) {
      original.writeFloatLE(0.5, frame * 8)
      original.writeFloatLE(-0.5, frame * 8 + 4)
    }
    original.fill(0, 48_000 * 8, 50_400 * 8)
    await writeFile(path, original)
    await silenceNarrationTails(path, [[48_000, 72_000]], new AbortController().signal)
    const trimmed = await readFile(path)
    expect(trimmed.length).toBe(original.length)
    expect(trimmed.readFloatLE(47_759 * 8)).toBeCloseTo(0.5, 5)
    expect(trimmed.readFloatLE(47_880 * 8)).toBeGreaterThan(0)
    expect(trimmed.subarray(0, 48_000 * 8)).toEqual(original.subarray(0, 48_000 * 8))
    expect(trimmed.readFloatLE(48_000 * 8)).toBe(0)
    expect(trimmed.readFloatLE(71_999 * 8)).toBe(0)
    expect(trimmed.readFloatLE(72_000 * 8)).toBeCloseTo(0.5, 5)
  })

  it('preserves the final syllable when ASR ends 200 ms before the acoustic pause', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-narration-tail-'))
    directories.push(directory)
    const path = join(directory, 'voice.f32le')
    const original = Buffer.alloc(96_000 * 8)
    for (let frame = 0; frame < 96_000; frame++) {
      const value = frame >= 57_600 && frame < 60_000 ? 0.001 : 0.2
      original.writeFloatLE(value, frame * 8)
      original.writeFloatLE(-value, frame * 8 + 4)
    }
    await writeFile(path, original)
    await silenceNarrationTails(path, [[48_000, 96_000]], new AbortController().signal)
    const trimmed = await readFile(path)
    expect(trimmed.subarray(0, 57_600 * 8)).toEqual(original.subarray(0, 57_600 * 8))
    expect(trimmed.readFloatLE(58_000 * 8)).toBeCloseTo(0.001)
    expect(trimmed.readFloatLE(60_000 * 8)).toBe(0)
    expect(trimmed.length).toBe(original.length)
  })

  it.each(['continuous speech', 'quiet speech', 'short pause', 'one quiet channel'])('leaves %s untouched without a safe pause', async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-narration-tail-'))
    directories.push(directory)
    const path = join(directory, 'voice.f32le')
    const original = Buffer.alloc(48_000 * 8)
    for (let frame = 0; frame < 48_000; frame++) {
      const shortPause = kind === 'short pause' && frame >= 12_000 && frame < 12_480
      const volume = kind === 'quiet speech' ? 0.004 : 0.1
      original.writeFloatLE(shortPause || kind === 'one quiet channel' ? 0 : volume, frame * 8)
      original.writeFloatLE(shortPause ? 0 : volume, frame * 8 + 4)
    }
    await writeFile(path, original)
    await silenceNarrationTails(path, [[9_600, 48_000]], new AbortController().signal)
    expect(await readFile(path)).toEqual(original)
  })

  it('finds a quiet decoder-noise gap without fading the preceding word', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-narration-tail-'))
    directories.push(directory)
    const path = join(directory, 'voice.f32le')
    const original = Buffer.alloc(96_000 * 8)
    for (let frame = 0; frame < 96_000; frame++) {
      const value = frame >= 57_600 && frame < 60_000 ? (frame % 17 ? 0.001 : 0.007) : 0.2
      original.writeFloatLE(value, frame * 8)
      original.writeFloatLE(-value, frame * 8 + 4)
    }
    await writeFile(path, original)
    const applied = await silenceNarrationTails(path, [[48_000, 96_000]], new AbortController().signal)
    expect(applied).toEqual([[59_040, 96_000]])
    const result = await readFile(path)
    expect(result.subarray(0, 57_600 * 8)).toEqual(original.subarray(0, 57_600 * 8))
    expect(result.readFloatLE(60_000 * 8)).toBe(0)
  })

  it('rejects invalid trim ranges before touching audio', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-narration-tail-'))
    directories.push(directory)
    const path = join(directory, 'voice.f32le')
    const original = Buffer.alloc(16 * 8, 0x3f)
    await writeFile(path, original)
    const invalid: [number, number][][] = [
      [[-1, 2]], [[1.5, 3]], [[2, 2]], [[0, 17]], [[NaN, 4]],
      [[4, 8], [6, 12]], [[10, 12], [2, 4]]
    ]
    for (const ranges of invalid) {
      await expect(silenceNarrationTails(path, ranges, new AbortController().signal)).rejects.toThrow('Invalid')
      expect(await readFile(path)).toEqual(original)
    }
    const controller = new AbortController()
    controller.abort()
    await expect(silenceNarrationTails(path, [[4, 8]], controller.signal)).rejects.toThrow()
    expect(await readFile(path)).toEqual(original)
  })

  it.each([true, false])('removes a vocal tail while retaining the environment bed (extra words recognized: %s)', async (recognized) => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-narration-tail-'))
    directories.push(directory)
    const speechPath = join(directory, 'speech.wav')
    const backgroundPath = join(directory, 'background.wav')
    tone(speechPath, 4, 0.25)
    tone(backgroundPath, 4, 0.02)
    const phraseText = 'The passage is private cleaning'
    const draft: NarrationDraft = { approved: true, contentKey: 'speech-tail-test', range: [0, 4], language: 'en', strength: 'balanced',
      originalPath: speechPath, speechPath, backgroundPath,
      phrases: [{ id: 'p1', text: phraseText, revisedText: phraseText, start: seconds(24_000), end: seconds(96_000), needsTimingReview: false }] }
    const request = vi.fn((value: Record<string, unknown>): Promise<unknown> => {
      if (value.action === 'transcribe') return Promise.resolve(recognized ? targetWords : targetWords.slice(0, 5))
      const phrases = value.phrases as { output: string }[]
      for (const item of phrases) if (!existsSync(item.output)) tone(item.output, 1.5, 0.1, [0.9, 1])
      return Promise.resolve(phrases.map(() => 1.5))
    })
    const output = await generateNarrationAudio(draft, directory, { request } as unknown as NarrationWorker,
      new AbortController().signal)
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'f32le', '-ac', '2', 'pipe:1'], { maxBuffer: 8 * 1024 ** 2 })
    const audio = new Float32Array(Uint8Array.from(raw).buffer)
    const peak = (start: number, end: number): number => {
      let maximum = 0
      for (const sample of audio.subarray(Math.floor(start * 48_000 * 2), Math.ceil(end * 48_000 * 2))) {
        maximum = Math.max(maximum, Math.abs(sample))
      }
      return maximum
    }
    expect(peak(0.75, 1.1)).toBeGreaterThan(0.05)
    expect(peak(1.3, 1.35)).toBeGreaterThan(0.05)
    expect(peak(1.7, 1.9)).toBeGreaterThan(0.005)
    expect(peak(1.7, 1.9)).toBeLessThan(0.04)
    expect(audio.length).toBe(4 * 48_000 * 2)
  })
})
