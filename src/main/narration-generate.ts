import { spawn } from 'node:child_process'
import { open, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { narrationVoiceReference, type NarrationDraft } from './narration-analysis'
import type { NarrationWorker } from './narration-worker'
import { ffmpegPath } from './binaries'
import { narrationFfmpeg, narrationMixGraph, narrationWindowFilter, silenceNarrationTails } from './narration-audio'
import { narrationSpeechTailRanges } from '../narration-subtitles'
import { placeNarration, narrationDurationSamples, narrationSampleRate, narrationMaxSentenceSeconds, NarrationTimingError, type NarrationPlacement } from '../narration'
import { parseNarrationPauses, type NarrationPauseText } from '../narration-pauses'
import { fitNarrationOverruns } from './narration-fit'

const referenceTailSeconds = 0.2
const voiceCacheVersion = 'voice-fp16-10steps-shared-reference-v6-context6'

interface GeneratedPart {
  text: string
  pauseBefore: number
  output: string
}

interface GeneratedPhrase {
  id: string
  text: string
  revisedText: string
  start: number
  end: number
  needsTimingReview: boolean
  referenceEnd?: number
  referenceText?: string
  generatedTempo?: number
  reference: string
  referenceTextForVoice: string
  output: string
  originalIndex: number
  pauseText?: NarrationPauseText
  parts?: GeneratedPart[]
  generatedDuration?: number
}

interface SynthesisPhrase {
  text: string
  reference: string
  referenceText: string
  output: string
}

function requirePhraseTiming(phrase: NarrationDraft['phrases'][number]): void {
  if (phrase.needsTimingReview || !Number.isFinite(phrase.start) || !Number.isFinite(phrase.end) ||
      phrase.start < 0 || phrase.end <= phrase.start || phrase.end - phrase.start > narrationMaxSentenceSeconds) {
    throw new Error('Review phrase timing before recreating its voice')
  }
}

async function assemblePauseAudio(parts: readonly GeneratedPart[], trailingPause: number, output: string,
  temporaryDirectory: string, version: string, signal: AbortSignal): Promise<void> {
  const inputs: string[] = []
  const filters: string[] = []
  const labels: string[] = []
  const addInput = (path: string, silenceSamples?: number): void => {
    const index = inputs.length
    inputs.push(path)
    const label = `part${index}`
    const trim = silenceSamples === undefined ? '' : `,atrim=end_sample=${silenceSamples}`
    filters.push(`[${index}:a]aresample=${narrationSampleRate},aformat=sample_fmts=fltp:channel_layouts=mono${trim},asetpts=PTS-STARTPTS[${label}]`)
    labels.push(`[${label}]`)
  }
  for (const part of parts) {
    const pauseSamples = Math.round(part.pauseBefore * narrationSampleRate)
    if (pauseSamples) addInput(`anullsrc=r=${narrationSampleRate}:cl=mono:d=${part.pauseBefore}`, pauseSamples)
    addInput(part.output)
  }
  const trailingSamples = Math.round(trailingPause * narrationSampleRate)
  if (trailingSamples) addInput(`anullsrc=r=${narrationSampleRate}:cl=mono:d=${trailingPause}`, trailingSamples)
  if (!labels.length) throw new Error('Narration pause marker has no audio parts')
  const temporary = join(temporaryDirectory, `${version}-pause-assembly.wav`)
  try {
    const graph = `${filters.join(';')};${labels.join('')}concat=n=${labels.length}:v=0:a=1,aresample=${narrationSampleRate},aformat=sample_fmts=fltp:channel_layouts=mono`
    const args: string[] = []
    for (const input of inputs) {
      if (input.startsWith('anullsrc=')) args.push('-f', 'lavfi', '-i', input)
      else args.push('-i', input)
    }
    await narrationFfmpeg([...args, '-filter_complex', graph, '-ac', '1', '-ar', String(narrationSampleRate),
      '-c:a', 'pcm_f32le', '-n', temporary], signal)
    await rename(temporary, output)
  } finally { await unlink(temporary).catch(() => undefined) }
}

/** Stream short synthesized windows into one PCM file; never allocate clip-length PCM. */
export async function generateNarrationAudio(draft: NarrationDraft, directory: string,
  worker: NarrationWorker, signal: AbortSignal,
  progress: (stage: string, fraction: number) => void = () => undefined,
  onSubtitleWords?: (words: unknown, placements: readonly NarrationPlacement[]) => void,
  onTempo?: (id: string, tempo: number) => void): Promise<string> {
  const version = randomUUID()
  const parsed = draft.phrases.map((phrase) => parseNarrationPauses(phrase.revisedText))
  const voice = parsed.some((value) => value.text.trim()) ? narrationVoiceReference(draft) : undefined
  const phrases: GeneratedPhrase[] = []
  progress('Preparing phrase voice references', 0)
  for (const [index, phrase] of draft.phrases.entries()) {
    signal.throwIfAborted()
    const pauseText = parsed[index]
    if (!pauseText?.text.trim()) {
      // Empty revised text leaves only background in this fixed window. Keep its
      // anchor in draft.phrases so a preceding utterance cannot borrow its pause.
      progress('Preparing phrase voice references', (index + 1) / draft.phrases.length)
      continue
    }
    requirePhraseTiming(phrase)
    if (!voice) throw new Error('Review phrase timing before recreating its voice')
    // All phrases and sections use one immutable, bounded speaker prompt. Only
    // the generated wording and placement change; the reference never follows cuts.
    const { start, end, text: referenceText } = voice
    const referenceKey = createHash('sha256').update(JSON.stringify([voice, referenceTailSeconds])).digest('hex')
    const reference = join(dirname(voice.path), `reference-${referenceKey}.wav`)
    if (!(await stat(reference).catch(() => undefined))?.isFile()) {
      const temporary = join(directory, `${version}-${index}-reference.wav`)
      try {
        // End the continuation prompt quietly so synthesis does not finish/repeat
        // its last syllable. This pads the reference, never the video or generated speech.
        await narrationFfmpeg(['-ss', String(start), '-t', String(end - start), '-i', voice.path,
          '-af', `apad=pad_dur=${referenceTailSeconds}`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_f32le', '-n', temporary], signal)
        await rename(temporary, reference)
      } finally { await unlink(temporary).catch(() => undefined) }
    }
    if (!pauseText.hasMarkers) {
      // Changing the shared prompt invalidates older phrase-local synthesis.
      // Editing another phrase still leaves this cached utterance reusable.
      const key = createHash('sha256').update(JSON.stringify([referenceKey, phrase.revisedText, draft.voiceStyle ?? 'original', `${voiceCacheVersion}-trimmed`])).digest('hex')
      phrases.push({ ...phrase, reference, referenceTextForVoice: referenceText, output: join(directory, `utterance-${key}.wav`), originalIndex: index })
    } else {
      const parts = pauseText.parts.map((part) => {
        const text = part.text.trim()
        const key = createHash('sha256').update(JSON.stringify([referenceKey, text, draft.voiceStyle ?? 'original', `${voiceCacheVersion}-pause-part-v1`])).digest('hex')
        return { ...part, text, output: join(directory, `utterance-pause-part-${key}.wav`) }
      })
      const compoundKey = createHash('sha256').update(JSON.stringify([
        referenceKey, parts.map(({ text, pauseBefore }) => ({ text, pauseBefore })), pauseText.trailingPause,
        draft.voiceStyle ?? 'original', `${voiceCacheVersion}-pause-compound-v1`
      ])).digest('hex')
      phrases.push({ ...phrase, reference, referenceTextForVoice: referenceText,
        output: join(directory, `utterance-pause-${compoundKey}.wav`), originalIndex: index, pauseText, parts })
    }
    progress('Preparing phrase voice references', (index + 1) / draft.phrases.length)
  }
  const synthesis: SynthesisPhrase[] = phrases.flatMap((phrase) => phrase.parts?.map((part) => ({
    text: part.text, reference: phrase.reference, referenceText: phrase.referenceTextForVoice, output: part.output
  })) ?? [{ text: phrase.revisedText, reference: phrase.reference, referenceText: phrase.referenceTextForVoice, output: phrase.output }])
  const rawDurations = synthesis.length ? await worker.request({ action: 'synthesize', voiceStyle: draft.voiceStyle ?? 'original',
    phrases: synthesis }) : []
  if (!Array.isArray(rawDurations) || rawDurations.length !== synthesis.length ||
    rawDurations.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
    throw new Error('Voice model returned invalid phrase durations')
  }
  let synthesisIndex = 0
  for (const phrase of phrases) {
    const parts = phrase.parts
    if (!parts) {
      phrase.generatedDuration = rawDurations[synthesisIndex++] as number
      continue
    }
    phrase.generatedDuration = 0
    for (const part of parts) {
      phrase.generatedDuration += (rawDurations[synthesisIndex++] as number) + part.pauseBefore
    }
    phrase.generatedDuration += phrase.pauseText?.trailingPause ?? 0
    if (!(await stat(phrase.output).catch(() => undefined))?.isFile()) {
      await assemblePauseAudio(parts, phrase.pauseText?.trailingPause ?? 0, phrase.output, directory, version, signal)
    }
  }
  const duration = draft.range[1] - draft.range[0]
  const place = (): NarrationPlacement[] => placeNarration(phrases.map((phrase) => ({ id: phrase.id, start: phrase.start,
    end: draft.phrases[phrase.originalIndex + 1]?.start ?? duration, generatedDuration: phrase.generatedDuration ?? 0 })), duration, draft.slowdown)
  let placements = place()
  const fittedFiles = await fitNarrationOverruns(phrases, placements, directory, worker, signal,
    draft.translateToEnglish ? 'en' : draft.language, (fraction) => progress('Checking phrase length', fraction))
  const clearFits = (): Promise<unknown[]> => Promise.all(fittedFiles.map((path) => unlink(path).catch(() => undefined)))
  if (fittedFiles.length) placements = place()
  const overruns = placements.flatMap((placement, index) => placement.needsReview ? [{
    id: placement.id,
    text: phrases[index]?.revisedText ?? '',
    extraSeconds: (placement.generatedSamples / 1.15 - placement.windowSamples) / narrationSampleRate
  }] : [])
  if (overruns.length) { await clearFits(); throw new NarrationTimingError(overruns) }
  const raw = join(directory, `${version}-voice.f32le`)
  const output = join(directory, `${version}-mix.wav`)
  const checkWav = join(directory, `${version}-speech-check.wav`)
  const file = await open(raw, 'wx', 0o600)
  const writeChunk = async (buffer: Buffer): Promise<void> => {
    for (let offset = 0; offset < buffer.length;) {
      const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset)
      if (!bytesWritten) throw new Error('Could not write narration audio')
      offset += bytesWritten
    }
  }
  let cursor = 0
  const zeros = Buffer.alloc(48000 * 8)
  const silence = async (samples: number): Promise<void> => {
    for (let remaining = samples * 8; remaining > 0; remaining -= Math.min(remaining, zeros.length)) {
      signal.throwIfAborted()
      await writeChunk(zeros.subarray(0, Math.min(remaining, zeros.length)))
    }
  }
  let mixed = false
  try {
    try {
      progress('Aligning narration', 0)
      for (const [index, placement] of placements.entries()) {
        const phrase = phrases[index]
        if (!phrase) throw new Error('Missing narration phrase')
        await silence(placement.startSample - cursor)
        const child = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', phrase.output,
          '-af', narrationWindowFilter(placement), '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
        { signal, stdio: ['ignore', 'pipe', 'pipe'] })
        let detail = ''
        child.stderr.on('data', (chunk: Buffer) => { detail = (detail + chunk.toString()).slice(-4096) })
        const completion = new Promise<void>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code) => code === 0 ? resolve() : reject(new Error(detail || 'Could not fit narration audio')))
        })
        // Observe failures immediately, including an aborted/failed spawn before the stream ends.
        void completion.catch(() => undefined)
        for await (const chunk of child.stdout) await writeChunk(chunk as Buffer)
        await completion
        cursor = placement.startSample + placement.windowSamples
        progress('Aligning narration', (index + 1) / placements.length)
      }
      await silence(narrationDurationSamples(duration) - cursor)
    } finally { await file.close() }
    // VoxCPM can continue speaking after the requested sentence. Check even
    // without captions; reuse this same recognition pass for subtitle timing.
    if (phrases.length) {
      progress('Checking narration', 0)
      await narrationFfmpeg(['-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', raw,
        '-ac', '1', '-ar', '48000', '-c:a', 'pcm_f32le', '-n', checkWav], signal)
      const words = await worker.request({ action: 'transcribe', input: checkWav, language: 'auto' })
      const tails = narrationSpeechTailRanges(draft.phrases, words, duration, placements)
      await silenceNarrationTails(raw, tails, signal)
      onSubtitleWords?.(words, placements)
      progress('Checking narration', 1)
    } else onSubtitleWords?.([], placements)
    progress('Mixing narration and environment', 0)
    await narrationFfmpeg(['-i', draft.backgroundPath, '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', raw,
      '-filter_complex', narrationMixGraph(duration, { levelVoice: draft.levelVoice, backgroundVolume: draft.backgroundVolume }),
      '-map', '[narrationout]', '-map_metadata', '-1', '-c:a', 'pcm_f32le', '-n', output], signal)
    // Once FFmpeg succeeds, preserve the completed mix even if final progress reporting fails.
    mixed = true
    for (const placement of placements) onTempo?.(placement.id, placement.tempo)
    progress('Mixing narration and environment', 1)
    return output
  } finally {
    await clearFits()
    await unlink(raw).catch(() => undefined)
    await unlink(checkWav).catch(() => undefined)
    if (!mixed) await unlink(output).catch(() => undefined)
  }
}
