import { narrationSampleRate, type NarrationPlacement } from './narration'
import { parseNarrationPauses } from './narration-pauses'
import type { NarrationPhrase } from './narration-transcript'

export interface NarrationSubtitleLine {
  start: number
  end: number
  text: string
}

export class NarrationSubtitleAlignmentError extends Error {
  constructor(message: string) {
    super(`Narration subtitle alignment error: ${message}`)
    this.name = 'NarrationSubtitleAlignmentError'
  }
}

interface Word {
  normalized: string
  start: number
  end: number
}

interface Token {
  normalized: string
  from: number
  to: number
  start?: number
  end?: number
}

interface PhraseTokens {
  id: string
  text: string
  start: number
  windowEnd: number
  tokens: Token[]
}

const maxPhrases = 100_000
const maxWords = 100_000
const maxText = 4_000
const maxTotalText = 4_000_000
const longPause = 0.6
const maxInterpolationGap = 1.5
const wordPattern = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}'’-]*[\p{L}\p{M}\p{N}])?/gu

function error(message: string): never {
  throw new NarrationSubtitleAlignmentError(message)
}

function normalizeWord(value: string): string {
  return value.replace(/\u0301/gu, '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[’]/gu, "'").replace(/[-‐‑‒–—]/gu, '-')
}

function displayText(value: string): string {
  return parseNarrationPauses(value).text.replace(/\u0301/gu, '')
}

function tokenize(value: string): { value: string; from: number; to: number }[] {
  return [...value.matchAll(wordPattern)].flatMap((match) => {
    const token = match[0]
    const from = match.index
    return token && from >= 0 ? [{ value: token, from, to: from + token.length }] : []
  })
}

function phraseTokens(phrases: readonly NarrationPhrase[], duration: number): PhraseTokens[] {
  const input: unknown = phrases
  if (!Array.isArray(input) || input.length === 0 || input.length > maxPhrases) {
    error('phrases must be a bounded non-empty array')
  }
  const values = input as unknown[]
  const output: PhraseTokens[] = []
  let previousEnd = 0
  let totalText = 0
  let totalWords = 0
  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) error(`phrase ${index} is invalid`)
    const record = value as Record<string, unknown>
    const start = record.start
    const end = record.end
    const revisedText = record.revisedText
    if (typeof start !== 'number' || typeof end !== 'number' ||
        !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > duration ||
        start < previousEnd || typeof revisedText !== 'string' || revisedText.length > maxText) {
      error(`phrase ${index} has invalid timing or reviewed text`)
    }
    const text = displayText(revisedText)
    const tokens = tokenize(text).map(({ value: token, from, to }) => ({
      normalized: normalizeWord(token), from, to
    }))
    if (text.trim() && !tokens.length) error(`phrase ${index} has no subtitle words`)
    totalText += text.length
    totalWords += tokens.length
    if (totalText > maxTotalText || totalWords > maxWords) error('reviewed subtitle text is too large')
    const next = values[index + 1]
    const nextRecord = next && typeof next === 'object' && !Array.isArray(next)
      ? next as Record<string, unknown> : undefined
    const nextStart = typeof nextRecord?.start === 'number' ? nextRecord.start : duration
    if (!Number.isFinite(nextStart) || nextStart < end || nextStart > duration) {
      error(`phrase ${index} has an invalid following timing anchor`)
    }
    output.push({ id: typeof record.id === 'string' ? record.id : '', text, start, windowEnd: nextStart, tokens })
    previousEnd = end
  }
  return output
}

function recognizedWords(rawWords: unknown, duration: number): Word[] {
  if (!Array.isArray(rawWords) || rawWords.length > maxWords) error('recognized words must be a bounded array')
  const output: Word[] = []
  let previousStart = 0
  for (const [index, value] of (rawWords as unknown[]).entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) error(`recognized word ${index} is invalid`)
    const record = value as Record<string, unknown>
    const start = record.start
    const end = record.end
    const text = record.text
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) ||
        start < 0 || end < start || end > duration || start < previousStart ||
        typeof text !== 'string' || !text.trim() || text.length > 160) {
      error(`recognized word ${index} has invalid text or timestamps`)
    }
    // Whisper sometimes emits zero-duration words, including hallucinated
    // prefixes. They are not acoustic anchors; reviewed text is still retained
    // and receives timing from neighbouring valid words below.
    if (end === start) continue
    const pieces = tokenize(text)
    for (const [pieceIndex, piece] of pieces.entries()) {
      // Whisper can return more than one lexical word in one timestamped
      // record. Preserve that record's exact envelope while giving wrapped
      // captions distinct, positive anchors.
      const span = end - start
      const pieceStart = pieceIndex === 0 ? start : start + span * pieceIndex / pieces.length
      const pieceEnd = pieceIndex + 1 === pieces.length ? end : start + span * (pieceIndex + 1) / pieces.length
      output.push({ normalized: normalizeWord(piece.value), start: pieceStart, end: pieceEnd })
    }
    if (output.length > maxWords) error('recognized transcript is too large')
    previousStart = start
  }
  return output
}

function phraseWordWindow(words: readonly Word[], phrase: PhraseTokens, initialIndex: number): { window: Word[]; nextIndex: number } {
  let wordIndex = initialIndex
  while (wordIndex < words.length && ((words[wordIndex]?.start ?? 0) + (words[wordIndex]?.end ?? 0)) / 2 < phrase.start) wordIndex += 1
  const window: Word[] = []
  // A jittered ASR word may start in the preceding pause but overlap this
  // fixed speech slot. Keep it as a clipped boundary anchor.
  const preceding = words[wordIndex - 1]
  if (preceding && preceding.start < phrase.start && preceding.end > phrase.start) {
    const end = Math.min(preceding.end, phrase.windowEnd)
    if (end > phrase.start) window.push({ ...preceding, start: phrase.start, end })
  }
  while (wordIndex < words.length && (words[wordIndex]?.start ?? Infinity) < phrase.windowEnd) {
    const word = words[wordIndex]
    if (word) {
      const start = Math.max(phrase.start, word.start)
      const end = Math.min(phrase.windowEnd, word.end)
      if (end > start) window.push({ ...word, start, end })
    }
    wordIndex += 1
  }
  return { window, nextIndex: wordIndex }
}

function align(tokens: Token[], words: readonly Word[], matchedWordIndices?: number[]): number {
  const width = words.length + 1
  // Align the sequence, not each word greedily: a changed contraction must not
  // consume a repeated word near the end and strand the intervening sentence.
  if ((tokens.length + 1) * width > 4_000_000) error('phrase alignment is too large')
  const lengths = new Uint16Array((tokens.length + 1) * width)
  for (let row = tokens.length - 1; row >= 0; row -= 1) {
    for (let column = words.length - 1; column >= 0; column -= 1) {
      lengths[row * width + column] = tokens[row]?.normalized === words[column]?.normalized
        ? 1 + (lengths[(row + 1) * width + column + 1] ?? 0)
        : Math.max(lengths[(row + 1) * width + column] ?? 0, lengths[row * width + column + 1] ?? 0)
    }
  }
  let row = 0
  let column = 0
  let matches = 0
  while (row < tokens.length && column < words.length) {
    const token = tokens[row]
    const word = words[column]
    if (!token || !word) break
    if (token.normalized === word.normalized) {
      token.start = word.start
      token.end = word.end
      matchedWordIndices?.push(column)
      matches += 1
      row += 1
      column += 1
    } else if ((lengths[(row + 1) * width + column] ?? 0) >= (lengths[row * width + column + 1] ?? 0)) {
      row += 1
    } else column += 1
  }
  return matches
}

/** Fill unrecognized phrase edges from fixed starts or the nearest observed span.
 * Never extend a trailing caption through the phrase's unused silent window. */
function interpolateEdges(tokens: Token[], phraseStart: number): void {
  const first = tokens.findIndex((token) => token.start !== undefined)
  let last = tokens.length - 1
  while (last >= 0 && tokens[last]?.end === undefined) last -= 1
  const leading = tokens[first]
  const trailing = tokens[last]
  if (!leading || !trailing) return
  if (first > 0) {
    const start = Math.min(phraseStart, leading.start ?? phraseStart)
    const end = (leading.start ?? start) > start ? leading.start ?? start : leading.end ?? start
    const count = (leading.start ?? start) > start ? first : first + 1
    for (let index = 0; index < count; index += 1) {
      const token = tokens[index]
      if (token) { token.start = start + (end - start) * index / count; token.end = start + (end - start) * (index + 1) / count }
    }
  }
  if (last < tokens.length - 1) {
    const start = trailing.start ?? phraseStart
    const end = trailing.end ?? start
    const count = tokens.length - last
    for (let index = last; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token) { token.start = start + (end - start) * (index - last) / count; token.end = index === tokens.length - 1 ? end : start + (end - start) * (index - last + 1) / count }
    }
  }
}

function interpolate(tokens: Token[]): void {
  const matched = tokens.flatMap((token, index) => token.start !== undefined && token.end !== undefined ? [{ token, index }] : [])
  for (let index = 0; index + 1 < matched.length; index += 1) {
    const left = matched[index]
    const right = matched[index + 1]
    if (!left || !right || right.index - left.index <= 1) continue
    const gap = (right.token.start ?? 0) - (left.token.end ?? 0)
    if (gap < 0 || gap > maxInterpolationGap) continue
    const count = right.index - left.index
    if (gap === 0) {
      // There is no unobserved gap to interpolate. Divide the observed span
      // of the right anchor across the missing run and that anchor, retaining
      // the right endpoint and avoiding a zero-duration subtitle line.
      const anchorStart = right.token.start ?? 0
      const span = (right.token.end ?? 0) - anchorStart
      for (let position = left.index + 1; position < right.index; position += 1) {
        const token = tokens[position]
        if (!token) continue
        const offset = position - left.index - 1
        token.start = anchorStart + span * offset / count
        token.end = anchorStart + span * (offset + 1) / count
      }
      right.token.start = anchorStart + span * (count - 1) / count
      continue
    }
    for (let position = left.index + 1; position < right.index; position += 1) {
      const token = tokens[position]
      if (!token) continue
      token.start = (left.token.end ?? 0) + gap * (position - left.index) / count
      token.end = (left.token.end ?? 0) + gap * (position - left.index + 1) / count
    }
  }
}

function between(text: string, tokens: readonly Token[], index: number): string {
  const current = tokens[index]
  const next = tokens[index + 1]
  return current ? text.slice(current.to, next?.from ?? text.length) : ''
}

function sentenceBreak(value: string): boolean {
  return /[.!?。！？]["'”’)]*\s*$/u.test(value)
}

function preferredBreak(value: string): boolean {
  return /[,;:，；：、.!?。！？]["'”’)]*\s*$/u.test(value)
}

function lineText(text: string, tokens: readonly Token[], first: number, last: number): string {
  const start = tokens[first]
  if (!start) return ''
  return text.slice(first === 0 ? 0 : start.from, tokens[last + 1]?.from ?? text.length).trim()
}

function group(phrase: PhraseTokens, maxCharacters: number): NarrationSubtitleLine[] {
  const { text, tokens } = phrase
  const lines: NarrationSubtitleLine[] = []
  let first = 0
  while (first < tokens.length) {
    let last = first
    let preferred = -1
    let sentence = -1
    for (let index = first; index < tokens.length; index += 1) {
      const value = lineText(text, tokens, first, index)
      if (index > first && value.length > maxCharacters) break
      last = index
      const nextStart = tokens[index + 1]?.start
      const currentEnd = tokens[index]?.end
      const gap = nextStart !== undefined && currentEnd !== undefined ? nextStart - currentEnd : 0
      const punctuation = between(text, tokens, index)
      if (sentenceBreak(punctuation)) sentence = index
      else if (preferredBreak(punctuation) || gap >= longPause) preferred = index
      if (sentence >= 0 || gap >= longPause) break
    }
    if (last < tokens.length - 1 && (sentence >= first || preferred >= first)) last = sentence >= first ? sentence : preferred
    const selected = tokens.slice(first, last + 1).filter((token) => token.start !== undefined && token.end !== undefined)
    if (!selected.length) error('subtitle line has no usable recognized anchor')
    const line = lineText(text, tokens, first, last)
    if (!line) error('subtitle line text is empty')
    lines.push({ start: selected[0]?.start ?? 0, end: selected.at(-1)?.end ?? 0, text: line })
    first = last + 1
  }
  return lines
}

/** Generated audio bounds prevent captions from spilling into unused pauses. */
function generatedSpeechEnd(phrase: PhraseTokens, take: NarrationPlacement | undefined): number | undefined {
  if (!take) return undefined
  const start = take.startSample / narrationSampleRate
  const end = start + Math.min(take.windowSamples, take.generatedSamples / take.tempo) / narrationSampleRate
  if (!Number.isFinite(end) || !Number.isFinite(start) ||
      ![take.windowSamples, take.generatedSamples, take.tempo].every(Number.isFinite) ||
      take.windowSamples <= 0 || take.generatedSamples <= 0 || take.tempo <= 0 ||
      Math.abs(start - phrase.start) > 1 / narrationSampleRate || end <= start || end > phrase.windowEnd + 1 / narrationSampleRate) {
    error('generated speech has invalid subtitle timing')
  }
  return end
}

function boundGeneratedSpeech(phrase: PhraseTokens, take: NarrationPlacement | undefined): void {
  const end = generatedSpeechEnd(phrase, take)
  if (end === undefined) return
  phrase.windowEnd = Math.min(phrase.windowEnd, end)
}

export function narrationSubtitleLines(
  phrases: readonly NarrationPhrase[], rawWords: unknown, duration: number, maxCharacters = 44,
  generated?: readonly NarrationPlacement[]
): NarrationSubtitleLine[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400) {
    error('duration must be a finite positive value no greater than 24 hours')
  }
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0 || maxCharacters > maxText) {
    error('maxCharacters must be a positive bounded integer')
  }
  const phraseList = phraseTokens(phrases, duration)
  const words = recognizedWords(rawWords, duration)
  const speech = new Map(generated?.map((placement) => [placement.id, placement]))
  let wordIndex = 0
  let alignmentCells = 0
  for (const phrase of phraseList) {
    const take = speech.get(phrase.id)
    boundGeneratedSpeech(phrase, take)
    const phraseWindow = phraseWordWindow(words, phrase, wordIndex)
    const window = phraseWindow.window
    wordIndex = phraseWindow.nextIndex
    if (!phrase.tokens.length) continue
    // Bound total CPU work as well as each matrix allocation.
    alignmentCells += (phrase.tokens.length + 1) * (window.length + 1)
    if (alignmentCells > 16_000_000) error('total subtitle alignment is too large')
    if (!align(phrase.tokens, window)) {
      if (!take) error('no reviewed words matched a phrase anchor')
      // We synthesized this exact text. If Whisper misses a short utterance,
      // estimate its words only within the measured, fitted speech duration.
      const total = phrase.tokens.reduce((sum, token) => sum + token.normalized.length, 0)
      let cursor = phrase.start
      for (const token of phrase.tokens) {
        token.start = cursor
        cursor += (phrase.windowEnd - phrase.start) * token.normalized.length / total
        token.end = Math.min(cursor, phrase.windowEnd)
      }
    }
    interpolate(phrase.tokens)
    interpolateEdges(phrase.tokens, phrase.start)
  }
  const lines = phraseList.flatMap((phrase) => group(phrase, maxCharacters))
  let previousEnd = 0
  return lines.map((line) => {
    const start = Math.max(previousEnd, Math.min(duration, line.start))
    const end = Math.min(duration, line.end)
    if (start < 0 || end < start || end > duration) error('subtitle lines have invalid or overlapping timings')
    previousEnd = end
    return { start, end, text: line.text }
  })
}

function tailPlacementMap(generated: readonly NarrationPlacement[] | undefined, duration: number): Map<string, NarrationPlacement> | undefined {
  if (!generated || !Array.isArray(generated) || generated.length > maxPhrases) return undefined
  const durationSamples = Math.round(duration * narrationSampleRate)
  const result = new Map<string, NarrationPlacement>()
  let previousEnd = 0
  for (const value of generated) {
    const placement = value as Partial<NarrationPlacement> | null
    const id = placement?.id
    const startSample = placement?.startSample
    const windowSamples = placement?.windowSamples
    const generatedSamples = placement?.generatedSamples
    const tempo = placement?.tempo
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(id) || result.has(id) ||
        typeof startSample !== 'number' || typeof windowSamples !== 'number' || typeof generatedSamples !== 'number' ||
        !Number.isSafeInteger(startSample) || !Number.isSafeInteger(windowSamples) || !Number.isSafeInteger(generatedSamples) ||
        startSample < previousEnd || windowSamples <= 0 || generatedSamples <= 0 || startSample + windowSamples > durationSamples ||
        typeof tempo !== 'number' || !Number.isFinite(tempo) || tempo <= 0 || placement?.needsReview !== false) return undefined
    const normalized: NarrationPlacement = { id, startSample, windowSamples, generatedSamples, tempo, needsReview: false }
    result.set(id, normalized)
    previousEnd = startSample + windowSamples
  }
  return result
}

function sampleCount(value: number): number {
  return Math.round(value * narrationSampleRate)
}

/** Propose a tail only after every requested word matches. The audio-side
 * quiet-gap check decides whether it is safe to remove anything there. */
export function narrationSpeechTailRanges(
  phrases: readonly NarrationPhrase[], rawWords: unknown, duration: number,
  generated: readonly NarrationPlacement[] | undefined
): [number, number][] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400 || !Array.isArray(phrases) || phrases.length === 0) return []
  const speech = tailPlacementMap(generated, duration)
  if (!speech) return []
  let phraseList: PhraseTokens[]
  let words: Word[]
  try {
    phraseList = phraseTokens(phrases, duration)
    words = recognizedWords(rawWords, duration)
  } catch {
    return []
  }
  const ranges: [number, number][] = []
  let wordIndex = 0
  let alignmentCells = 0
  try {
    for (const phrase of phraseList) {
      const take = speech.get(phrase.id)
      if (!take || !phrase.tokens.length) continue
      boundGeneratedSpeech(phrase, take)
      const phraseWindow = phraseWordWindow(words, phrase, wordIndex)
      const window = phraseWindow.window
      wordIndex = phraseWindow.nextIndex
      alignmentCells += (phrase.tokens.length + 1) * (window.length + 1)
      if (alignmentCells > 16_000_000) return []
      // An overlapping ASR window makes only this phrase uncertain. Keep
      // independently aligned phrases eligible for conservative cleanup.
      if (window.some((word, index) => index > 0 && word.start < (window[index - 1]?.end ?? 0))) continue
      const target = phrase.tokens.map((token) => ({ ...token }))
      const matchedWordIndices: number[] = []
      if (align(target, window, matchedWordIndices) !== target.length || matchedWordIndices.length !== target.length) continue
      const lastIndex = matchedWordIndices.at(-1)
      if (lastIndex === undefined) continue
      const lastWord = window[lastIndex]
      if (!lastWord || lastWord.end <= lastWord.start || lastWord.end > phrase.windowEnd) continue
      // Model tails may be unintelligible and absent from ASR altogether.
      // Preserve a small margin, then require an acoustic pause in the caller;
      // never depend on recognizing extra words before checking the tail.
      const start = sampleCount(lastWord.end + 0.04)
      const end = sampleCount(phrase.windowEnd)
      if (end > start) ranges.push([start, end])
    }
  } catch {
    // A malformed or unexpectedly large alignment must never mute uncertain audio.
    return []
  }
  return ranges
}
