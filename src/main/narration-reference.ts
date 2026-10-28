import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ExportRequest } from '../types'
import { timelineDuration } from '../segment-time'
import { narrationMaxVoiceReferenceSeconds } from '../narration'
import { narrationHasOnlyFillers } from '../narration-cleanup'
import { narrationPhrases } from '../narration-transcript'
import type { NarrationDraft } from './narration-analysis'
import { narrationFfmpeg } from './narration-audio'
import { narrationInputArgs } from './narration-input'
import type { NarrationWorker } from './narration-worker'

/** Make one shared prompt from immutable original audio; wording edits never enter this path. */
export async function prepareNarrationVoiceReference(request: ExportRequest, draft: NarrationDraft,
  worker: NarrationWorker, signal: AbortSignal): Promise<NonNullable<NarrationDraft['voiceReference']>> {
  const start = draft.range[0]
  const duration = timelineDuration(request.segments)
  const end = Math.min(start + narrationMaxVoiceReferenceSeconds, duration)
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) {
    throw new Error('Narration reference range is outside the timeline')
  }
  signal.throwIfAborted()
  const directory = await mkdtemp(join(dirname(draft.originalPath), '.narration-reference-'))
  const original = join(directory, 'original.wav')
  const speech = join(directory, 'speech.wav')
  const background = join(directory, 'background.wav')
  let kept = false
  try {
    await narrationFfmpeg(narrationInputArgs(request, [start, end], original), signal)
    signal.throwIfAborted()
    const separated = await worker.request({ action: 'separate', input: original, speech, background }) as { speechPath?: unknown } | null
    signal.throwIfAborted()
    if (separated?.speechPath !== speech) throw new Error('Narration separation did not return its speech output')
    const words = await worker.request({ action: 'transcribe', input: original, vadInput: speech, language: 'auto' })
    signal.throwIfAborted()
    const phrases = narrationPhrases(words, end - start)
    const usable = phrases.filter((phrase) => !phrase.needsTimingReview && !narrationHasOnlyFillers(phrase.text))
    const first = usable[0]
    const last = usable.at(-1)
    if (!first || !last) throw new Error('No usable original speech was recognized')
    // The helper deliberately spans the complete captured window. This sample
    // is the original speaker prompt, so real pauses between usable sentences
    // must not trigger the shorter generation-reference heuristics.
    const text = phrases.slice(phrases.indexOf(first), phrases.indexOf(last) + 1)
      .map((phrase) => phrase.text.trim()).filter(Boolean).join(' ').trim()
    const referenceStart = first.start
    const referenceEnd = last.end
    if (!text || narrationHasOnlyFillers(text) || referenceEnd <= referenceStart ||
        referenceEnd - referenceStart > narrationMaxVoiceReferenceSeconds) {
      throw new Error('No usable original speech was recognized')
    }
    await Promise.all([rm(original, { force: true }), rm(background, { force: true })])
    signal.throwIfAborted()
    kept = true
    return { path: speech, start: referenceStart, end: referenceEnd, text }
  } finally {
    if (!kept) await rm(directory, { recursive: true, force: true })
  }
}
