import { createHash } from 'node:crypto'
import type { ExportRequest } from '../types'
import { timelineDuration } from '../segment-time'
import { narrationMaxReferenceSeconds, narrationMaxVoiceReferenceSeconds } from '../narration'
import { narrationInputArgs } from './narration-input'
import { narrationCleanupMessages, narrationCleanupStrengths, narrationHasOnlyFillers, parseNarrationRevisions, parseNarrationReview,
  type NarrationCleanupStrength, type NarrationLanguage, type NarrationRevision } from '../narration-cleanup'
import { endsNarrationSentence, narrationPhrases, normalizeNarrationTiming, skipUnalignedNarrationWords, sentenceNarrationPhrases, reviseNarrationPhrases, type NarrationPhrase, type NarrationWord } from '../narration-transcript'
import { narrationSentenceBatches, narrationSentenceMessages, parseNarrationSentenceBoundaries,
  narrationPhrasesFromSentenceBoundaries, fallbackNarrationSentenceBoundaries } from '../narration-sentences'
import type { NarrationVoiceStyle, NarrationMixSettings, NarrationRecognitionSettings } from '../narration-api'

export interface NarrationVoiceReference { path: string; start: number; end: number; text: string }

export interface NarrationDraft extends NarrationMixSettings {
  translateToEnglish?: boolean
  recognition?: NarrationRecognitionSettings
  voiceStyle?: NarrationVoiceStyle
  voiceReference?: NarrationVoiceReference
  stage?: 'recognized' | 'cleaned'
  contentKey: string
  range: [number, number]
  language: NarrationLanguage
  strength: NarrationCleanupStrength
  originalPath: string
  speechPath: string
  backgroundPath: string
  phrases: NarrationPhrase[]
  approved: boolean
}

interface PhraseReference { reference: NarrationVoiceReference; extendable: boolean }

const referenceTargetSeconds = 30
const referenceMaxGapSeconds = 2
const referenceMinLongWords = 3

function validVoiceReference(value: unknown, maximumSeconds = narrationMaxVoiceReferenceSeconds): value is NarrationVoiceReference {
  if (!value || typeof value !== 'object') return false
  const reference = value as Partial<NarrationVoiceReference>
  const { path, text, start, end } = reference
  return typeof path === 'string' && path.trim().length > 0 && typeof text === 'string' && text.trim().length > 0 &&
    typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end) && start >= 0 &&
    end > start && end - start <= maximumSeconds
}

function phraseReference(draft: NarrationDraft, phrase: NarrationPhrase): PhraseReference | undefined {
  const selectionDuration = draft.range[1] - draft.range[0]
  const validTiming = !phrase.needsTimingReview && Number.isFinite(selectionDuration) && selectionDuration > 0 &&
    typeof phrase.start === 'number' && typeof phrase.end === 'number' && Number.isFinite(phrase.start) &&
    Number.isFinite(phrase.end) && phrase.start >= 0 && phrase.end > phrase.start && phrase.end <= selectionDuration
  if (!validTiming || typeof draft.speechPath !== 'string' || !draft.speechPath.trim()) return undefined
  const text = typeof phrase.text === 'string' ? phrase.text.trim() : ''
  const wordCount = text ? text.split(/\s+/u).length : 0
  const duration = phrase.end - phrase.start
  // A long uncertain slot can contain a single ASR fragment (for example a
  // one-word translation). It is not a stable speaker sample without the
  // application's short, trusted anchor.
  if (text && duration <= narrationMaxVoiceReferenceSeconds &&
      (duration <= narrationMaxReferenceSeconds || wordCount >= referenceMinLongWords)) {
    return { reference: { path: draft.speechPath, start: phrase.start, end: phrase.end, text }, extendable: true }
  }
  const anchorEnd = phrase.referenceEnd
  const anchorText = typeof phrase.referenceText === 'string' ? phrase.referenceText.trim() : ''
  if (anchorText && typeof anchorEnd === 'number' && Number.isFinite(anchorEnd) && anchorEnd > phrase.start &&
      anchorEnd <= phrase.end && anchorEnd - phrase.start <= narrationMaxReferenceSeconds) {
    return { reference: { path: draft.speechPath, start: phrase.start, end: anchorEnd, text: anchorText }, extendable: false }
  }
  return undefined
}

export function storedNarrationVoiceReference(draft: NarrationDraft): NarrationVoiceReference | undefined {
  // Persisted references are application-owned anchors. Return a copy so a
  // caller cannot mutate the stored draft while still accepting old short
  // references alongside the new bounded long form.
  return validVoiceReference(draft.voiceReference) ? { ...draft.voiceReference } : undefined
}

export function narrationVoiceReference(draft: NarrationDraft): NarrationVoiceReference | undefined {
  const stored = storedNarrationVoiceReference(draft)
  if (stored) return stored
  for (let index = 0; index < draft.phrases.length; index++) {
    const firstPhrase = draft.phrases[index]
    if (!firstPhrase) continue
    const first = phraseReference(draft, firstPhrase)
    if (!first) continue
    if (!first.extendable || first.reference.end - first.reference.start >= referenceTargetSeconds) {
      return first.reference
    }
    const parts = [first.reference.text]
    let end = first.reference.end
    for (let nextIndex = index + 1; nextIndex < draft.phrases.length; nextIndex++) {
      const phrase = draft.phrases[nextIndex]
      if (!phrase) break
      const next = phraseReference(draft, phrase)
      if (!next?.extendable || phrase.start < end || phrase.start - end > referenceMaxGapSeconds ||
          next.reference.end - first.reference.start > narrationMaxVoiceReferenceSeconds) break
      parts.push(next.reference.text)
      end = next.reference.end
      if (end - first.reference.start >= referenceTargetSeconds) break
    }
    return parts.length > 1
      ? { ...first.reference, end, text: parts.join(' ') }
      : first.reference
  }
  return undefined
}

/** Each stage owns a worker lifetime; it must release its GPU model before resolving. */
export interface NarrationAnalysisWorkers {
  renderAudio: (request: ExportRequest, range: readonly [number, number], signal: AbortSignal) => Promise<string>
  separate: (originalPath: string, signal: AbortSignal) => Promise<{ speechPath: string; backgroundPath: string }>
  transcribe: (speechPath: string, language: NarrationLanguage, signal: AbortSignal) => Promise<unknown>
  rewrite: (batches: ReturnType<typeof narrationCleanupMessages>[], signal: AbortSignal) => Promise<string[]>
}

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Narration analysis cancelled', 'AbortError')
}

/** Repair one malformed model response, not the audio or application-owned anchors. */
async function rewriteValidated<T>(batches: ReturnType<typeof narrationCleanupMessages>[],
  rewrite: NarrationAnalysisWorkers['rewrite'], parse: (raw: string, index: number) => T, signal: AbortSignal,
  fallback?: (index: number) => T): Promise<T[]> {
  const raw = await rewrite(batches, signal)
  checkCancellation(signal)
  if (raw.length !== batches.length) throw new Error('Narration cleanup returned incomplete batches')
  const result: T[] = []
  const failed: { index: number; messages: ReturnType<typeof narrationCleanupMessages> }[] = []
  raw.forEach((text, index) => {
    try { result[index] = parse(text, index) }
    catch (error) {
      // Start again from the source, rather than encouraging the model to copy
      // a spelling/JSON defect from its previous response.
      failed.push({ index, messages: [...(batches[index] ?? []),
        { role: 'user', content: `Validation failed: ${String(error)}. Correct the response to follow the original instructions and input exactly. Return JSON only.` }] })
    }
  })
  if (failed.length) {
    const repaired = await rewrite(failed.map((item) => item.messages), signal)
    checkCancellation(signal)
    if (repaired.length !== failed.length) throw new Error('Narration cleanup returned incomplete batches')
    failed.forEach(({ index }, retry) => {
      try { result[index] = parse(repaired[retry] ?? '', index) }
      catch (error) {
        if (!fallback) throw error
        result[index] = fallback(index)
      }
    })
  }
  return result
}

export function narrationContentKey(request: ExportRequest, range: readonly [number, number], models: string): string {
  const [start, end] = range
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
      end > timelineDuration(request.segments) || end - start > 86_400) throw new Error('Invalid narration selection')
  if (!models || models.length > 8192) throw new Error('Narration model identity is missing or too large')
  // Fingerprint the actual selected-audio recipe, including join envelopes.
  // Changes elsewhere in the timeline must not discard an edited transcript.
  const args = narrationInputArgs(request, range, '')
  const inputs = new Set(args.flatMap((arg, index) => arg === '-i' ? [args[index + 1]] : []))
  const sources = request.sources.filter((source) => inputs.has(source.metadata.path)).map(({ metadata }) => ({
    path: metadata.path, size: metadata.size, modifiedAt: metadata.modifiedAt, hasAudio: metadata.hasAudio
  })).sort((a, b) => a.path.localeCompare(b.path))
  return 'audio-v2:' + createHash('sha256').update(JSON.stringify({ models, range, sources, args })).digest('hex')
}

/** Selection-relative words and text are returned for review; this never mutates the project. */
export async function recognizeNarration(
  request: ExportRequest,
  range: readonly [number, number],
  settings: { language: NarrationLanguage; strength: NarrationCleanupStrength; translateToEnglish?: boolean; recognition?: NarrationRecognitionSettings },
  models: string,
  workers: Omit<NarrationAnalysisWorkers, 'rewrite'>,
  signal: AbortSignal
): Promise<NarrationDraft> {
  const contentKey = narrationContentKey(request, range, models)
  if (!['auto', 'en', 'ru'].includes(settings.language) || !narrationCleanupStrengths.includes(settings.strength)) {
    throw new Error('Unsupported narration settings')
  }
  checkCancellation(signal)
  const originalPath = await workers.renderAudio(request, range, signal)
  checkCancellation(signal)
  const stems = await workers.separate(originalPath, signal)
  checkCancellation(signal)
  const words = await workers.transcribe(stems.speechPath, settings.language, signal)
  checkCancellation(signal)
  const phrases = narrationPhrases(words, range[1] - range[0])
  return { contentKey, range: [range[0], range[1]], ...settings, originalPath, ...stems, phrases, approved: false, stage: 'recognized' }
}

export async function cleanNarrationDraft(draft: NarrationDraft, rewrite: NarrationAnalysisWorkers['rewrite'], signal: AbortSignal,
  originalWords?: readonly NarrationWord[]): Promise<NarrationDraft> {
  checkCancellation(signal)
  if (!narrationCleanupStrengths.includes(draft.strength)) throw new Error('Unsupported narration settings')
  let phrases = sentenceNarrationPhrases(normalizeNarrationTiming(draft.phrases))
  // Whisper often omits punctuation. Detect boundaries before translation,
  // where original word anchors still exist; never split revised paragraphs
  // proportionally or let the language model invent timestamps.
  const needsSentences = phrases.some((phrase) => !phrase.needsTimingReview &&
    (phrase.end - phrase.start > 12 || phrase.text.length > 160 ||
      (phrase.text.trim().split(/\s+/u).length > 2 && !endsNarrationSentence(phrase.text))))
  if (originalWords?.length && needsSentences) {
    const batches = narrationSentenceBatches(originalWords)
    const detected = (await rewriteValidated(batches.map(narrationSentenceMessages), rewrite, (raw, index) => {
      const batch = batches[index]
      if (!batch) throw new Error('Missing narration sentence batch')
      return parseNarrationSentenceBoundaries(raw, batch)
    }, signal, (index) => {
      const batch = batches[index]
      if (!batch) throw new Error('Missing narration sentence batch')
      // An invalid punctuation proposal must not prevent recognition. Retain
      // the recognizer's own punctuation/pause groups for this batch only.
      return fallbackNarrationSentenceBoundaries(batch)
    })).flat()
    // Overlap gives the punctuation model complete thoughts. Each batch owns
    // sentence ends inside its core; a sentence can cross a batch boundary.
    // Keep model boundaries, but never let them bridge a long original ASR pause.
    const gapEnds = originalWords.slice(1).flatMap((word, index) =>
      originalWords[index] && word.start - originalWords[index].end >= 2 ? [index + 1] : [])
    const endWords = [...new Set([...detected.map(({ endWord }) => endWord), ...gapEnds])].sort((a, b) => a - b)
    let cursor = 0
    const boundaries = endWords.map((endWord) => {
      const boundary = { startWord: cursor, endWord }
      cursor = endWord
      return boundary
    })
    phrases = normalizeNarrationTiming(narrationPhrasesFromSentenceBoundaries(originalWords, boundaries))
  }
  const valid = phrases.filter((phrase) => !phrase.needsTimingReview)
  // One anchored thought per prompt prevents the model moving a sentence into
  // another ID. All prompts still share one worker/model lifetime.
  const batches = valid.map((phrase) => [phrase])
  const revisions: NarrationRevision[] = []
  if (batches.length) {
    const cleaned = await rewriteValidated(batches.map((batch, index) => narrationCleanupMessages(batch, draft.strength, draft.language,
      draft.translateToEnglish, { before: (valid[index - 1]?.text ?? '').slice(-1000), after: (valid[index + 1]?.text ?? '').slice(0, 1000) })), rewrite, (raw, index) => {
      const batch = batches[index]
      if (!batch) throw new Error('Missing narration cleanup batch')
      return parseNarrationRevisions(raw, batch)
    }, signal)
    revisions.push(...cleaned.flat().map((revision) => narrationHasOnlyFillers(revision.text) && narrationHasOnlyFillers(revision.revisedText)
      ? { ...revision, revisedText: '' }
      : revision))
  }
  const byId = new Map(revisions.map((revision) => [revision.id, revision]))
  phrases = reviseNarrationPhrases(phrases, phrases.map((phrase) => byId.get(phrase.id) ?? phrase))
  return { ...draft, phrases: skipUnalignedNarrationWords(phrases), approved: false, stage: 'cleaned' }
}

/** Recognition and wording cleanup share one sequential worker lifetime. */
export async function analyzeNarration(request: ExportRequest, range: readonly [number, number],
  settings: { language: NarrationLanguage; strength: NarrationCleanupStrength; translateToEnglish?: boolean; recognition?: NarrationRecognitionSettings }, models: string,
  workers: NarrationAnalysisWorkers, signal: AbortSignal): Promise<NarrationDraft> {
  let words: unknown
  const draft = await recognizeNarration(request, range, settings, models, {
    ...workers, transcribe: async (input, language, abort) => {
      words = await workers.transcribe(input, language, abort)
      return words
    }
  }, signal)
  // recognizeNarration validated every word before this typed handoff.
  return cleanNarrationDraft(draft, workers.rewrite, signal, words as NarrationWord[])
}

export function approveNarrationDraft(draft: NarrationDraft, reviewed: string): NarrationDraft {
  if (!draft.phrases.length) throw new Error('No speech was detected in the selected range')
  const normalized = { ...draft, phrases: normalizeNarrationTiming(draft.phrases) }
  if (normalized.phrases.some((phrase) => phrase.needsTimingReview)) throw new Error('Review narration timing before generation')
  return { ...reviewNarrationDraft(normalized, reviewed), approved: true }
}

export function reviewNarrationDraft(draft: NarrationDraft, reviewed: string): NarrationDraft {
  const revisions = parseNarrationReview(reviewed, draft.phrases)
  // Only this explicit human-approval path can correct recognized words. IDs
  // and acoustic anchors still come exclusively from the application-owned draft.
  const corrected = draft.phrases.map((phrase, index) => ({ ...phrase, text: revisions[index]?.text ?? phrase.text }))
  const phrases = reviseNarrationPhrases(corrected, revisions)
  return { ...draft, phrases, approved: false }
}

export function requireCurrentNarration(draft: NarrationDraft, request: ExportRequest, models: string): void {
  if (!draft.approved) throw new Error('Review and approve the narration before generation')
  if (draft.contentKey !== narrationContentKey(request, draft.range, models)) {
    throw new Error('The source audio or model changed; analyze the selection again')
  }
}
