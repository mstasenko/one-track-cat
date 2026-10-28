import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioOverlay, ExportRequest } from '../types'
import type { NarrationReview } from '../narration-api'
import { narrationDurationSamples, narrationSampleRate } from '../narration'
import { sliceNarrationReview } from '../narration-slice'
import { timelineDuration } from '../segment-time'
import { narrationContentKey, type NarrationDraft } from './narration-analysis'
import { narrationInputArgs, narrationInputPartSamples } from './narration-input'
import { narrationFfmpeg } from './narration-audio'

async function audioHash(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Old drafts hashed unrelated timeline edits. Verify their retained recording before reuse. */
export async function upgradeLegacyDraft(draft: NarrationDraft, current: ExportRequest,
  models: string, root: string, signal: AbortSignal): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(draft.contentKey)) return
  const temporary = join(root, `${randomUUID()}-verify.wav`)
  try {
    await narrationFfmpeg(narrationInputArgs(current, draft.range, temporary), signal)
    if (await audioHash(temporary, signal) === await audioHash(draft.originalPath, signal)) {
      draft.contentKey = narrationContentKey(current, draft.range, models)
    }
  } finally { await rm(temporary, { force: true }) }
}

async function trimAudio(input: string, output: string, start: number, samples: number, signal: AbortSignal): Promise<void> {
  await narrationFfmpeg(['-i', input, '-af', `atrim=start_sample=${start},asetpts=PTS-STARTPTS,` +
    `apad=whole_len=${samples},atrim=end_sample=${samples}`, '-c:a', 'pcm_f32le', '-n', output], signal)
}

async function* rawChunks(path: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  const chunkBytes = narrationSampleRate * 8
  let pending: Buffer = Buffer.alloc(0)
  for await (const chunk of createReadStream(path, { signal, highWaterMark: chunkBytes })) {
    pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer
    while (pending.length >= chunkBytes) {
      yield pending.subarray(0, chunkBytes)
      pending = pending.subarray(chunkBytes)
    }
  }
  if (pending.length % 8) throw new Error('Invalid raw narration sample data')
  if (pending.length) yield pending
}

async function sameRawAudio(leftPath: string, rightPath: string, frames: number, signal: AbortSignal): Promise<boolean> {
  const left = rawChunks(leftPath, signal)
  const right = rawChunks(rightPath, signal)
  let compared = 0
  try {
    for (;;) {
      const [a, b] = await Promise.all([left.next(), right.next()])
      if (a.done || b.done) return a.done === b.done && compared === frames
      if (a.value.length !== b.value.length) return false
      const bytes = a.value.length
      for (let offset = 0; offset < bytes; offset += 4) {
        const first = a.value.readFloatLE(offset)
        const second = b.value.readFloatLE(offset)
        // A rejected seek offset need not scan the remainder of a long recording.
        if (!Number.isFinite(first) || !Number.isFinite(second) || Math.abs(first - second) > 1e-7) return false
      }
      compared += Math.floor(bytes / 8)
    }
  } finally {
    await Promise.all([left.return(undefined), right.return(undefined)])
  }
}

async function renderRawPart(input: string, start: number, samples: number,
  directory: string, name: string, signal: AbortSignal): Promise<string> {
  const wav = join(directory, `${name}.wav`)
  const raw = join(directory, `${name}.f32le`)
  try {
    await trimAudio(input, wav, start, samples, signal)
    await narrationFfmpeg(['-i', wav, '-f', 'f32le', '-ar', String(narrationSampleRate), '-ac', '2', '-n', raw], signal)
    return raw
  } finally { await rm(wav, { force: true }) }
}

async function matchingOffset(saved: NarrationReview, current: ExportRequest, overlay: AudioOverlay, original: string,
  directory: string, signal: AbortSignal): Promise<number> {
  const samples = narrationDurationSamples(overlay.duration)
  // Cuts add 10 ms join envelopes. Compare all retained samples between those
  // edges; allow one sample of rounding between independent AAC seeks and cuts.
  const guard = Math.min(480, Math.floor(samples / 4))
  const count = samples - guard * 2
  const actual = join(directory, 'check-current.wav')
  const expected = join(directory, 'check-cached.wav')
  await trimAudio(original, actual, guard, count, signal)
  const hash = await audioHash(actual, signal)
  const offset = Math.round(overlay.sourceIn * narrationSampleRate)
  for (const shift of [0, -1, 1]) {
    if (offset + shift < 0) continue
    await rm(expected, { force: true })
    await trimAudio(saved.originalPath, expected, offset + shift + guard, count, signal)
    if (await audioHash(expected, signal) === hash) return offset + shift
  }
  // Independent source seeks can round in opposite directions at a join.
  // Check each rendered part at ±1 sample, allowing only float32 rounding.
  const parts = narrationInputPartSamples(current, [overlay.start, overlay.start + overlay.duration])
  if (!parts.length) throw new Error('The audio in this Re-voice section changed; click Recognize again')
  let position = 0
  for (const [index, samplesForPart] of parts.entries()) {
    const guardForPart = Math.min(480, Math.floor(samplesForPart / 4))
    const retained = samplesForPart - guardForPart * 2
    const actualRaw = join(directory, `check-part-current-${index}.f32le`)
    try {
      await renderRawPart(original, position + guardForPart, retained, directory, `check-part-current-${index}`, signal)
      let matched = false
      for (const shift of [0, -1, 1]) {
        const savedStart = offset + position + shift + guardForPart
        if (savedStart < 0) continue
        const expectedRaw = join(directory, `check-part-saved-${index}-${shift}.f32le`)
        try {
          await renderRawPart(saved.originalPath, savedStart, retained, directory, `check-part-saved-${index}-${shift}`, signal)
          matched = await sameRawAudio(actualRaw, expectedRaw, retained, signal)
        } finally { await rm(expectedRaw, { force: true }) }
        if (matched) break
      }
      if (!matched) throw new Error('The audio in this Re-voice section changed; click Recognize again')
    } finally { await rm(actualRaw, { force: true }) }
    position += samplesForPart
  }
  return offset
}

/** Fork only the selected piece. Sibling pieces and their immutable drafts stay untouched. */
export async function prepareNarrationSlice(saved: NarrationReview, current: ExportRequest,
  overlay: AudioOverlay, models: string, root: string, signal: AbortSignal): Promise<NarrationReview> {
  const range: [number, number] = [overlay.start, overlay.start + overlay.duration]
  if (overlay.narration?.invalidated) throw new Error('Video speed changed; click Recognize again')
  if (overlay.sourceIn === 0 && range.every((value, index) => Math.abs(value - (saved.range[index] ?? 0)) < 1 / narrationSampleRate)) {
    return saved
  }
  const sliced = sliceNarrationReview(saved, range, overlay.sourceIn)
  const directory = join(root, randomUUID())
  await mkdir(directory, { mode: 0o700 })
  const originalPath = join(directory, 'original.wav')
  const speechPath = join(directory, 'speech.wav')
  const backgroundPath = join(directory, 'background.wav')
  try {
    const samples = narrationDurationSamples(overlay.duration)
    // A narration-only split leaves the original recording valid. Reuse it:
    // independent AAC seeks need not decode to bit-identical float samples.
    const unchanged = Math.abs(range[0] - saved.range[0] - overlay.sourceIn) < 1 / narrationSampleRate &&
      saved.range[1] <= timelineDuration(current.segments) &&
      saved.contentKey === narrationContentKey(current, saved.range, models)
    let offset = Math.round(overlay.sourceIn * narrationSampleRate)
    if (unchanged) await trimAudio(saved.originalPath, originalPath, offset, samples, signal)
    else {
      await narrationFfmpeg(narrationInputArgs(current, range, originalPath), signal)
      offset = await matchingOffset(saved, current, overlay, originalPath, directory, signal)
    }
    await trimAudio(saved.speechPath, speechPath, offset, samples, signal)
    await trimAudio(saved.backgroundPath, backgroundPath, offset, samples, signal)
    return { ...sliced, originalPath, speechPath, backgroundPath,
      contentKey: narrationContentKey(current, range, models) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    await rm(join(directory, 'check-current.wav'), { force: true })
    await rm(join(directory, 'check-cached.wav'), { force: true })
  }
}
