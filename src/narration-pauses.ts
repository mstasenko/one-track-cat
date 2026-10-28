export interface NarrationPausePart {
  /** Spoken text for this synthesis request; marker text is never retained. */
  text: string
  /** Silence to insert immediately before this spoken part. */
  pauseBefore: number
}

export interface NarrationPauseText {
  /** Reviewed text with pause markers removed, for subtitles and validation. */
  text: string
  parts: NarrationPausePart[]
  trailingPause: number
  totalPause: number
  hasMarkers: boolean
}

export class NarrationPauseError extends Error {
  constructor(message: string) {
    super(`Narration pause marker error: ${message}`)
    this.name = 'NarrationPauseError'
  }
}

const markerPattern = /\[([^\]]*)\]/gu
const numericMarker = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)\s*$/iu
const maxMarkerSeconds = 10
const maxTotalSeconds = 30
const maxMarkers = 16

function spokenText(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(/\s+([,.;:!?…])/gu, '$1').replace(/([([{])\s+/gu, '$1').trim()
}

function parseMarker(raw: string): number {
  const match = numericMarker.exec(raw)
  if (!match) throw new NarrationPauseError(`malformed marker [${raw}]; use [500ms] or [1s]`)
  const numeric = Number(match[1])
  const seconds = match[2]?.toLowerCase() === 'ms' ? numeric / 1000 : numeric
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxMarkerSeconds) {
    throw new NarrationPauseError(`pause [${raw}] must be greater than zero and no more than ${maxMarkerSeconds}s`)
  }
  return seconds
}

/** Parse human pause markers while preserving ordinary reviewed text exactly when absent. */
export function parseNarrationPauses(value: string): NarrationPauseText {
  if (typeof value !== 'string') throw new NarrationPauseError('reviewed text must be a string')
  const matches = [...value.matchAll(markerPattern)]
  if (!matches.length) {
    if (value.includes('[') || value.includes(']')) throw new NarrationPauseError('malformed pause marker')
    return { text: value, parts: [{ text: value, pauseBefore: 0 }], trailingPause: 0, totalPause: 0, hasMarkers: false }
  }
  if (value.replace(markerPattern, '').includes('[') || value.replace(markerPattern, '').includes(']')) {
    throw new NarrationPauseError('malformed pause marker')
  }
  const parts: NarrationPausePart[] = []
  let cursor = 0
  let pending = 0
  let total = 0
  for (const [index, match] of matches.entries()) {
    const offset = match.index
    const before = value.slice(cursor, offset).trim()
    if (before) {
      parts.push({ text: before, pauseBefore: pending })
      pending = 0
    }
    if (index + 1 > maxMarkers) throw new NarrationPauseError(`at most ${maxMarkers} pause markers are allowed per phrase`)
    const seconds = parseMarker(match[1] ?? '')
    total += seconds
    if (total > maxTotalSeconds) throw new NarrationPauseError(`total pauses must not exceed ${maxTotalSeconds}s per phrase`)
    pending += seconds
    cursor = offset + match[0].length
  }
  const after = value.slice(cursor).trim()
  if (after) parts.push({ text: after, pauseBefore: pending })
  const trailingPause = after ? 0 : pending
  const text = spokenText(value.replace(markerPattern, ' '))
  return { text, parts, trailingPause, totalPause: total, hasMarkers: true }
}
