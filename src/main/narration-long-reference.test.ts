import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NarrationDraft } from './narration-analysis'
import type { NarrationWorker } from './narration-worker'
import { generateNarrationAudio } from './narration-generate'

vi.mock('./binaries', () => ({ ffmpegPath: () => join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg') }))
const ffmpeg = join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg')
const directories: string[] = []

function tone(path: string, duration: number, volume = 0.2): void {
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${volume}:s=48000:d=${duration}`,
    '-c:a', 'pcm_f32le', path])
}

function pcmSeconds(path: string): number {
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', 'pipe:1'], { maxBuffer: 12 * 1024 ** 2 })
  return raw.length / 4 / 48000
}

describe('long shared narration references', () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('shares a padded 40-second reference and invalidates utterances when it changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-narration-long-reference-'))
    directories.push(directory)
    const speechPath = join(directory, 'speech.wav')
    const backgroundPath = join(directory, 'background.wav')
    tone(speechPath, 40)
    tone(backgroundPath, 5, 0.02)
    const referenceText = 'Так сегодня будем пробовать починить машину.'
    const draft: NarrationDraft = {
      approved: true, contentKey: 'long-reference', range: [10, 15], language: 'ru', strength: 'balanced',
      originalPath: speechPath, speechPath, backgroundPath, voiceStyle: 'conversational',
      levelVoice: false, backgroundVolume: 0.2, slowdown: 0, subtitles: false,
      voiceReference: { path: speechPath, start: 0, end: 40, text: referenceText },
      phrases: [
        { id: 'first', text: 'Первое исходное предложение.', revisedText: 'Первое предложение.', start: 0.25, end: 1.5, needsTimingReview: false },
        { id: 'second', text: 'Второе исходное предложение.', revisedText: 'Второе предложение.', start: 3, end: 4.5, needsTimingReview: false }
      ]
    }
    const before = JSON.parse(JSON.stringify(draft)) as NarrationDraft
    const calls: Record<string, unknown>[] = []
    const request = vi.fn((value: Record<string, unknown>) => {
      if (value.action === 'transcribe') return []
      calls.push(value)
      if (value.action !== 'synthesize') throw new Error(`Unexpected action: ${String(value.action)}`)
      const phrases = value.phrases as { output: string }[]
      const durations = [0.5, 0.6]
      phrases.forEach((phrase, index) => tone(phrase.output, durations[index] ?? 0.5, 0.1))
      return durations.slice(0, phrases.length)
    })
    const worker = { request } as unknown as NarrationWorker

    const output = await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    const firstRequest = calls[0]
    const firstPhrases = firstRequest?.phrases as { reference: string; referenceText: string; output: string }[]
    expect(firstRequest).toMatchObject({ action: 'synthesize', voiceStyle: 'conversational' })
    expect(firstPhrases).toHaveLength(2)
    expect(new Set(firstPhrases.map((phrase) => phrase.reference)).size).toBe(1)
    expect(firstPhrases.map((phrase) => phrase.referenceText)).toEqual([referenceText, referenceText])
    expect(existsSync(firstPhrases[0]?.reference ?? '')).toBe(true)
    expect(pcmSeconds(firstPhrases[0]?.reference ?? '')).toBeCloseTo(40.2, 3)
    expect(pcmSeconds(output)).toBeCloseTo(5, 3)
    expect(draft.range).toEqual(before.range)
    expect(draft.phrases.map(({ id, start, end }) => ({ id, start, end }))).toEqual(
      before.phrases.map(({ id, start, end }) => ({ id, start, end })))
    expect(draft.voiceReference).toEqual(before.voiceReference)

    const storedReference = draft.voiceReference
    if (!storedReference) throw new Error('Missing stored voice reference')
    draft.voiceReference = { ...storedReference, end: 39 }
    await generateNarrationAudio(draft, directory, worker, new AbortController().signal)
    const secondPhrases = calls[1]?.phrases as { reference: string; output: string }[]
    expect(secondPhrases[0]?.reference).not.toBe(firstPhrases[0]?.reference)
    expect(secondPhrases[0]?.output).not.toBe(firstPhrases[0]?.output)
  })
})
