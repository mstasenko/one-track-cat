import { randomUUID } from 'node:crypto'
import { rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { narrationSpeechTailRanges } from '../narration-subtitles'
import { narrationSampleRate, type NarrationPlacement } from '../narration'
import { parseNarrationPauses } from '../narration-pauses'
import type { NarrationLanguage } from '../narration-cleanup'
import { narrationFfmpeg, silenceNarrationTails } from './narration-audio'
import type { NarrationWorker } from './narration-worker'

interface FitPhrase { id: string; revisedText: string; output: string; generatedDuration?: number; language?: NarrationLanguage }

/** Repair only failed fits, keeping reviewed words and timeline anchors unchanged. */
export async function fitNarrationOverruns(phrases: FitPhrase[], placements: readonly NarrationPlacement[],
  directory: string, worker: NarrationWorker, signal: AbortSignal, language: NarrationLanguage,
  progress: (fraction: number) => void): Promise<string[]> {
  const outputs: string[] = []
  try {
    for (const [index, placement] of placements.entries()) {
      signal.throwIfAborted()
      const phrase = phrases[index]
      if (!placement.needsReview || !phrase?.generatedDuration) continue
      progress(0)
      const fit = await fitNarrationTail({ ...phrase, language }, directory, worker, signal)
      if (fit) { Object.assign(phrase, fit); outputs.push(fit.output) }
      progress(1)
    }
    return outputs
  } catch (error) {
    await Promise.all(outputs.map((path) => rm(path, { force: true })))
    throw error
  }
}

/** Verify and publish only an acoustically quiet tail trim; the model cache stays immutable. */
export async function fitNarrationTail(phrase: FitPhrase, directory: string, worker: NarrationWorker,
  signal: AbortSignal): Promise<{ output: string; generatedDuration: number } | undefined> {
  if (!phrase.id || !phrase.revisedText.trim() || !phrase.generatedDuration ||
      !Number.isFinite(phrase.generatedDuration) || phrase.generatedDuration <= 0) return undefined
  // Explicit pauses consume time intentionally; do not make them fit by dropping silence.
  if (parseNarrationPauses(phrase.revisedText).hasMarkers) return undefined
  const token = randomUUID()
  const raw = join(directory, `narration-fit-${token}.f32le`)
  const mono = join(directory, `narration-fit-${token}.wav`)
  const output = join(directory, `narration-fit-${token}-checked.wav`)
  const temporary = `${output}.tmp.wav`
  let published = false
  try {
    signal.throwIfAborted()
    await narrationFfmpeg(['-i', phrase.output, '-ac', '2', '-ar', String(narrationSampleRate), '-f', 'f32le', raw], signal)
    signal.throwIfAborted()
    await narrationFfmpeg(['-f', 'f32le', '-ar', String(narrationSampleRate), '-ac', '2', '-i', raw,
      '-ac', '1', '-ar', String(narrationSampleRate), '-c:a', 'pcm_f32le', mono], signal)
    signal.throwIfAborted()
    const bytes = (await stat(raw)).size
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % 8 !== 0) return undefined
    const duration = bytes / 8 / narrationSampleRate
    const source = { id: phrase.id, text: phrase.revisedText, revisedText: phrase.revisedText,
      start: 0, end: duration, needsTimingReview: false }
    const placement: NarrationPlacement = { id: phrase.id, startSample: 0, windowSamples: bytes / 8,
      generatedSamples: bytes / 8, tempo: 1, needsReview: false }
    const candidates = narrationSpeechTailRanges([source], await worker.request({ action: 'transcribe', input: mono,
      language: phrase.language ?? 'auto' }), duration, [placement])
    if (!candidates.length) return undefined
    signal.throwIfAborted()
    const applied = await silenceNarrationTails(raw, candidates, signal)
    const cut = applied.find(([start, end]) => Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
      start > 0 && end === bytes / 8)
    if (!cut) return undefined
    const generatedDuration = cut[0] / narrationSampleRate
    if (!Number.isFinite(generatedDuration) || generatedDuration <= 0 || generatedDuration >= duration) return undefined
    signal.throwIfAborted()
    await narrationFfmpeg(['-f', 'f32le', '-ar', String(narrationSampleRate), '-ac', '2', '-i', raw,
      '-t', generatedDuration.toFixed(9), '-ac', '2', '-ar', String(narrationSampleRate), '-c:a', 'pcm_f32le', temporary], signal)
    signal.throwIfAborted()
    await rename(temporary, output)
    signal.throwIfAborted()
    published = true
    return { output, generatedDuration }
  } finally {
    await Promise.all([rm(raw, { force: true }), rm(mono, { force: true }), rm(temporary, { force: true }),
      ...(published ? [] : [rm(output, { force: true })])])
  }
}
