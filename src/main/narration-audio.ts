import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { open } from 'node:fs/promises'
import { ffmpegPath } from './binaries'
import { narrationDurationSamples, narrationSampleRate, narrationMaxSlowdown, type NarrationPlacement } from '../narration'
import type { NarrationMixSettings } from '../narration-api'
import { parseNarrationMixSettings } from './narration-validation'

const exec = promisify(execFile)

/** Shared media boundary for narration helpers; callers own validation and cleanup. */
export async function narrationFfmpeg(args: string[], signal: AbortSignal): Promise<void> {
  await exec(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { signal, maxBuffer: 1024 * 1024 })
}

/** Remove verified extra speech only at an acoustic pause. ASR word endpoints
 * can precede the actual final syllable; never fade active speech at that estimate. */
export async function silenceNarrationTails(path: string, ranges: readonly (readonly [number, number])[],
  signal: AbortSignal): Promise<[number, number][]> {
  if (!ranges.length) return []
  signal.throwIfAborted()
  const file = await open(path, 'r+')
  const applied: [number, number][] = []
  try {
    const bytesPerFrame = 8 // stereo float32
    const bytes = (await file.stat()).size
    let previousEnd = 0
    for (const [start, end] of ranges) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previousEnd || end <= start ||
          bytes % bytesPerFrame !== 0 || end > bytes / bytesPerFrame) throw new Error('Invalid narration speech trim')
      previousEnd = end
    }
    const write = async (buffer: Buffer, position: number): Promise<void> => {
      for (let offset = 0; offset < buffer.length;) {
        signal.throwIfAborted()
        const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, position + offset)
        if (!bytesWritten) throw new Error('Could not trim generated narration')
        offset += bytesWritten
      }
    }
    const zeros = Buffer.alloc(narrationSampleRate * bytesPerFrame)
    previousEnd = 0
    for (const [start, end] of ranges) {
      signal.throwIfAborted()
      // Look forward, never into the requested word. Require 30 ms below
      // -50 dBFS RMS on both channels, with no peak above -40 dBFS. A few
      // quiet decoder-noise spikes must not hide the pause between sentences.
      const searchFrames = Math.min(end - start, narrationSampleRate / 2)
      const search = Buffer.alloc(searchFrames * bytesPerFrame)
      const { bytesRead } = await file.read(search, 0, search.length, start * bytesPerFrame)
      signal.throwIfAborted()
      if (bytesRead !== search.length) throw new Error('Incomplete generated narration')
      const quietFrames = Math.round(narrationSampleRate * 0.03)
      let quiet = 0
      let boundary: number | undefined
      for (let frame = 0; frame < searchFrames; frame += 480) {
        const count = Math.min(480, searchFrames - frame)
        let leftEnergy = 0, rightEnergy = 0, peak = 0
        for (let sample = frame; sample < frame + count; sample++) {
          const offset = sample * bytesPerFrame
          const left = search.readFloatLE(offset), right = search.readFloatLE(offset + 4)
          leftEnergy += left * left; rightEnergy += right * right
          peak = Math.max(peak, Math.abs(left), Math.abs(right))
        }
        quiet = peak <= 0.01 && leftEnergy <= count * 0.003 ** 2 &&
          rightEnergy <= count * 0.003 ** 2 ? quiet + count : 0
        if (quiet >= quietFrames) {
          boundary = start + frame + count
          break
        }
      }
      if (boundary === undefined) continue
      // The fade lies wholly inside that confirmed pause, after the word's decay.
      const fadeStart = Math.max(previousEnd, boundary - 480)
      const frames = boundary - fadeStart
      if (frames) {
        const fade = Buffer.alloc(frames * bytesPerFrame)
        const { bytesRead } = await file.read(fade, 0, fade.length, fadeStart * bytesPerFrame)
        if (bytesRead !== fade.length) throw new Error('Incomplete generated narration')
        for (let frame = 0; frame < frames; frame++) {
          const gain = 1 - (frame + 1) / frames
          for (const channel of [0, 1]) {
            const offset = frame * bytesPerFrame + channel * 4
            fade.writeFloatLE(fade.readFloatLE(offset) * gain, offset)
          }
        }
        await write(fade, fadeStart * bytesPerFrame)
      }
      for (let position = boundary * bytesPerFrame; position < end * bytesPerFrame;) {
        const count = Math.min(zeros.length, end * bytesPerFrame - position)
        await write(zeros.subarray(0, count), position)
        position += count
      }
      previousEnd = end
      applied.push([boundary, end])
    }
  } finally { await file.close() }
  return applied
}

/** Produces one window's PCM for sequential assembly, without a whole-clip graph. */
export function narrationWindowFilter(placement: NarrationPlacement): string {
  const { windowSamples, generatedSamples, tempo } = placement
  if (!Number.isSafeInteger(windowSamples) || windowSamples <= 0 ||
      !Number.isSafeInteger(generatedSamples) || generatedSamples <= 0 ||
      !Number.isFinite(tempo) || tempo < 1 - narrationMaxSlowdown || tempo > 1.15 || placement.needsReview ||
      tempo < generatedSamples / windowSamples) {
    throw new Error('Narration does not fit its time window; review the wording before export')
  }
  const generatedEnd = Math.min(windowSamples, Math.ceil(generatedSamples / tempo))
  const fadeSamples = Math.min(240, Math.floor(generatedEnd / 2))
  const filters = [
    `aresample=${narrationSampleRate}`,
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    'asetpts=PTS-STARTPTS'
  ]
  if (tempo !== 1) filters.push(`atempo=${tempo}`)
  // Fade the speech itself before padding, not the trailing silence. The final
  // sample trim corrects atempo/resampler rounding, not an overlong utterance.
  if (fadeSamples) filters.push(
    `afade=t=in:ss=0:ns=${fadeSamples}`,
    `afade=t=out:ss=${generatedEnd - fadeSamples}:ns=${fadeSamples}`
  )
  filters.push(`apad=whole_len=${windowSamples}`, `atrim=end_sample=${windowSamples}`)
  return filters.join(',')
}

/** Inputs are the separated environment and newly assembled speech, never the original mix. */
export function narrationMixGraph(duration: number, settings: NarrationMixSettings = {}): string {
  const { levelVoice, backgroundVolume } = parseNarrationMixSettings(settings)
  const samples = narrationDurationSamples(duration)
  const format = `aresample=${narrationSampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=PTS-STARTPTS`
  // The separator keeps handling noise in the environment residual by design;
  // tame only large residual peaks before the requested bed level, leaving quiet
  // ambience untouched and keeping the compressor off the synthesized voice.
  const backgroundCompressor =
    ',acompressor=threshold=0.2:ratio=20:attack=0.01:release=150:makeup=1:knee=1:link=maximum:detection=peak'
  const background = backgroundCompressor + (backgroundVolume === 1 ? '' : `,volume=${backgroundVolume}`)
  // Level only synthesized speech with bounded gain, never its environment.
  const voice = levelVoice ? ',dynaudnorm=f=250:g=15:p=0.8:m=4:r=0.12' : ''
  return `[0:a:0]${format}${background}[environment];[1:a:0]${format}${voice}[narration];` +
    '[environment][narration]amix=inputs=2:duration=first:normalize=0,' +
    `alimiter=limit=0.95:level=0:latency=1,atrim=end_sample=${samples}[narrationout]`
}
