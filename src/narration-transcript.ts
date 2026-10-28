import type { NarrationRevision } from './narration-cleanup'
import { narrationMaxReferenceSeconds, narrationMaxSentenceSeconds, narrationMaxTextLength } from './narration'

export interface NarrationWord {
  start: number
  end: number
  text: string
}

export interface NarrationPhrase extends NarrationRevision {
  start: number
  end: number
  /** Invalid alignment must be corrected or retranscribed before synthesis. */
  needsTimingReview: boolean
  /** A bounded original reference, independent of a longer complete sentence. */
  referenceEnd?: number
  referenceText?: string
  /** Playback tempo actually applied to this generated phrase (1 is unchanged). */
  generatedTempo?: number
}

function checkedWord(value: unknown, duration: number): NarrationWord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Narration word is invalid')
  const word = value as Record<string, unknown>
  if (typeof word.start !== 'number' || typeof word.end !== 'number' ||
      !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
      word.start < 0 || word.end < word.start || word.end > duration ||
      typeof word.text !== 'string' || !word.text.trim() || word.text.length > 160) {
    throw new Error('Narration words need bounded text and valid timeline timestamps')
  }
  return { start: word.start, end: word.end, text: word.text }
}

export function appendNarrationWord(text: string, next: string): string {
  // Whisper normally includes leading spaces, but tokenizers/languages differ.
  return text + (text && !/\s$/u.test(text) && !/^[\s,.;:!?…]/u.test(next) ? ' ' : '') + next
}

export function endsNarrationSentence(text: string): boolean {
  // An ellipsis often marks hesitation mid-sentence, not a completed thought.
  return /[.!?。！？]["'”’)]*$/u.test(text) && !/\.{2,}["'”’)]*$/u.test(text)
}

/** Group original ASR words, never LLM-provided timing, into short anchored utterances. */
export function narrationPhrases(value: unknown, duration: number): NarrationPhrase[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400) throw new Error('Invalid narration duration')
  if (!Array.isArray(value) || value.length > 100_000) throw new Error('Narration words must be a bounded array')
  const phrases: NarrationPhrase[] = []
  let current: NarrationPhrase | undefined
  let previousEnd = 0
  let characters = 0
  for (const raw of value) {
    const word = checkedWord(raw, duration)
    characters += word.text.length
    if (characters > 1_000_000) throw new Error('Narration transcript is too large')
    const text = appendNarrationWord(current?.text ?? '', word.text).trim()
    const split = current && (word.start - current.end >= 0.6 || word.end - current.start > 12 || text.length > 160)
    if (split) current = undefined
    const needsTimingReview = word.end === word.start || word.start < previousEnd || word.end - word.start > 12
    if (!current) {
      current = { id: `phrase-${phrases.length}`, start: word.start, end: word.end,
        text: word.text.trim(), revisedText: word.text.trim(), needsTimingReview }
      phrases.push(current)
    } else {
      current.text = text
      current.revisedText = text
      current.end = Math.max(current.end, word.end)
      current.needsTimingReview ||= needsTimingReview
    }
    previousEnd = word.end
    if (endsNarrationSentence(word.text.trim())) current = undefined
  }
  return normalizeNarrationTiming(phrases)
}

/** Silence an unaligned short ASR fragment without reindexing saved edits.
 * Its empty slot may use only the gap between retained speech; never shorten
 * a neighbouring sentence to accommodate an unreliable word's overlap. */
export function skipUnalignedNarrationWords(phrases: readonly NarrationPhrase[]): NarrationPhrase[] {
  return phrases.map((phrase, index) => {
    const duration = phrase.end - phrase.start
    const previousEnd = phrases[index - 1]?.end ?? 0
    const nextStart = phrases[index + 1]?.start ?? Infinity
    const start = Math.max(phrase.start, previousEnd)
    const end = Math.min(phrase.end, nextStart)
    const uncertain = phrase.needsTimingReview && Number.isFinite(phrase.start) &&
      Number.isFinite(phrase.end) && phrase.start >= 0 && duration > 0 && duration <= narrationMaxSentenceSeconds &&
      (duration > 12 || phrase.start < previousEnd || phrase.end > nextStart) && end > start &&
      phrase.referenceEnd === undefined && typeof phrase.text === 'string' && typeof phrase.revisedText === 'string' &&
      !!phrase.text.trim() && phrase.text.trim().split(/\s+/u).length <= 3 && phrase.text.trim() === phrase.revisedText.trim()
    return uncertain ? { ...phrase, start, end, revisedText: '', needsTimingReview: false } : phrase
  })
}

/** Synthesis uses phrase windows, so zero-length/overlapping words inside a valid
 * window do not invalidate it. Keep genuinely overlapping or unbounded phrases blocked. */
function boundedReference(phrase: NarrationPhrase): boolean {
  return phrase.referenceEnd === undefined ||
    (Number.isFinite(phrase.start) && Number.isFinite(phrase.end) &&
      Number.isFinite(phrase.referenceEnd) && phrase.referenceEnd > phrase.start &&
      phrase.referenceEnd <= phrase.end && phrase.referenceEnd - phrase.start <= narrationMaxReferenceSeconds)
}

function boundedWindow(phrase: NarrationPhrase): boolean {
  const duration = phrase.end - phrase.start
  return Number.isFinite(phrase.start) && Number.isFinite(phrase.end) &&
    phrase.start >= 0 && phrase.end >= 0 && duration > 0 &&
    duration <= narrationMaxSentenceSeconds && boundedReference(phrase)
}

export function normalizeNarrationTiming(phrases: readonly NarrationPhrase[]): NarrationPhrase[] {
  const normalized = phrases.map((phrase) => ({ ...phrase }))
  const repairedStarts = new Set<number>()
  let earlierEnd = 0
  let malformedPrefix = false

  // Preserve every phrase start (synthesis places by starts) and trim only a
  // safe, proportionally small preceding boundary.
  for (let index = 1; index < normalized.length; index++) {
    const previous = normalized[index - 1]
    const phrase = normalized[index]
    if (!previous || !phrase) continue
    const previousDuration = previous.end - previous.start
    const duration = phrase.end - phrase.start
    const valid = boundedWindow(previous) && boundedWindow(phrase)
    const ordered = phrase.start >= previous.start && phrase.start >= earlierEnd
    const overlap = previous.end - phrase.start
    const overlapLimit = Math.min(0.2, 0.1 * Math.min(previousDuration, duration))
    const overlapTolerance = Number.EPSILON * Math.max(1, Math.abs(previous.end), Math.abs(phrase.start)) * 8
    const smallOverlap = overlap > 0 && overlap <= overlapLimit + overlapTolerance
    const repaired = !malformedPrefix && valid && ordered && smallOverlap && phrase.end > previous.end &&
      phrase.start > previous.start && (previous.referenceEnd === undefined || previous.referenceEnd <= phrase.start)
    if (repaired) {
      // Never shorten a reference along with its phrase window.
      previous.end = phrase.start
      repairedStarts.add(index)
    }
    // Once a pair is malformed or has an unsafe overlap, do not retime a later
    // pair based on its now-ambiguous boundary.
    if (malformedPrefix || !valid || !ordered || (overlap > 0 && !repaired)) {
      malformedPrefix = true
    }
    if (Number.isFinite(previous.end)) earlierEnd = Math.max(earlierEnd, previous.end)
  }

  let previousEnd = 0
  return normalized.map((phrase, index) => {
    const duration = phrase.end - phrase.start
    // A long phrase can retain a stale ASR overlap flag even though its
    // cross-phrase defect was repaired above; flags without that repair remain.
    const needsTimingReview = !boundedWindow(phrase) || phrase.start < previousEnd ||
      (phrase.needsTimingReview && duration > 12 && !repairedStarts.has(index))
    if (Number.isFinite(phrase.end)) previousEnd = Math.max(previousEnd, phrase.end)
    return phrase.needsTimingReview === needsTimingReview ? phrase : { ...phrase, needsTimingReview }
  })
}

/** Rejoin ASR pause fragments before rewriting, using only original word anchors.
 * Sentence-local synthesis removes artificial pauses without retiming later events.
 * Keep real silences; retain the first short fragment as the voice reference. */
export function sentenceNarrationPhrases(phrases: readonly NarrationPhrase[]): NarrationPhrase[] {
  const sentences: NarrationPhrase[] = []
  for (const phrase of phrases) {
    const previous = sentences.at(-1)
    const text = appendNarrationWord(previous?.text ?? '', phrase.text)
    if (previous && !previous.needsTimingReview && !phrase.needsTimingReview &&
        !endsNarrationSentence(previous.text) && phrase.start >= previous.end &&
        phrase.start - previous.end < 2 && phrase.end - previous.start <= narrationMaxSentenceSeconds && text.length <= narrationMaxTextLength) {
      previous.referenceEnd ??= previous.end
      previous.referenceText ??= previous.text
      previous.end = phrase.end
      previous.text = text
      previous.revisedText = text
    } else sentences.push({ ...phrase })
  }
  return sentences
}

/** Preserve every anchor/original when applying reviewed, text-only revisions. */
export function reviseNarrationPhrases(phrases: readonly NarrationPhrase[], revisions: readonly NarrationRevision[]): NarrationPhrase[] {
  if (phrases.length !== revisions.length) throw new Error('Narration review must preserve every phrase')
  return phrases.map((phrase, index) => {
    const revision = revisions[index]
    if (revision?.id !== phrase.id || revision.text !== phrase.text ||
        typeof revision.revisedText !== 'string' || revision.revisedText.length > narrationMaxTextLength) {
      throw new Error('Narration review may change only short revised text')
    }
    const updated = { ...phrase, revisedText: revision.revisedText.trim() }
    if (updated.revisedText !== phrase.revisedText) delete updated.generatedTempo
    return updated
  })
}
