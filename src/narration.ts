/** Narration is timed in audio samples, independently of video frame rate. */
export const narrationSampleRate = 48_000
export const narrationDefaultSlowdown = 0
export const narrationMaxSlowdown = 0.5
export const narrationMaxSentenceSeconds = 60
export const narrationMaxReferenceSeconds = 12
export const narrationMaxVoiceReferenceSeconds = 60
export const narrationMaxTextLength = 2048
export interface NarrationOverrun { id: string; text: string; extraSeconds: number }
export class NarrationTimingError extends Error {
  constructor(public readonly overruns: NarrationOverrun[]) {
    super('Narration does not fit. Shorten the highlighted phrases and generate again.')
  }
}

export interface NarrationWindow {
  id: string
  start: number
  end: number
  /** Measured generated audio length, not the model's predicted length. */
  generatedDuration: number
}

export interface NarrationPlacement {
  id: string
  startSample: number
  windowSamples: number
  generatedSamples: number
  tempo: number
  needsReview: boolean
}

function sampleCount(seconds: number, label: string): number {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) {
    throw new Error(`Narration ${label} must be between zero and 24 hours`)
  }
  return Math.round(seconds * narrationSampleRate)
}

export function narrationDurationSamples(duration: number): number {
  const samples = sampleCount(duration, 'duration')
  if (!samples) throw new Error('Narration duration must be positive')
  return samples
}

export function placeNarration(windows: readonly NarrationWindow[], duration: number,
  slowdown = narrationDefaultSlowdown): NarrationPlacement[] {
  if (!Number.isFinite(slowdown) || slowdown < 0 || slowdown > narrationMaxSlowdown) throw new Error('Invalid narration slowdown')
  const totalSamples = narrationDurationSamples(duration)
  const ids = new Set<string>()
  let previousEnd = 0
  return windows.map((window) => {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(window.id) || ids.has(window.id)) {
      throw new Error('Narration segment IDs must be safe and unique')
    }
    ids.add(window.id)
    const startSample = sampleCount(window.start, 'start')
    const endSample = sampleCount(window.end, 'end')
    const generatedSamples = sampleCount(window.generatedDuration, 'generated duration')
    if (startSample < previousEnd || endSample <= startSample || endSample > totalSamples || !generatedSamples) {
      throw new Error('Narration segments must be ordered, non-overlapping and inside the timeline')
    }
    previousEnd = endSample
    const windowSamples = endSample - startSample
    // Prefer a calmer delivery, reducing the slowdown only enough to fit before
    // the next fixed anchor. Leave spare time as a pause; never stretch to fill it.
    const tempo = Math.max(1 - slowdown, generatedSamples / windowSamples)
    return { id: window.id, startSample, windowSamples, generatedSamples, tempo, needsReview: tempo > 1.15 }
  })
}
