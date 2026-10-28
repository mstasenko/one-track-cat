import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { placeNarration } from '../narration'
import { narrationMixGraph, narrationWindowFilter } from './narration-audio'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')

function renderAudio(inputs: string[], filter: string, complex = false): Float32Array {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
    ...inputs.flatMap((input) => ['-f', 'lavfi', '-i', input]),
    ...(complex ? ['-filter_complex', filter, '-map', '[narrationout]'] : ['-af', filter]),
    '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'
  ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 10_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8'))
  const copied = Uint8Array.from(result.stdout)
  return new Float32Array(copied.buffer)
}

function placement(generatedDuration = 0.25) {
  const [result] = placeNarration([{ id: 'phrase', start: 0, end: 0.5, generatedDuration }], 0.5, 0.15)
  if (!result) throw new Error('Missing narration placement')
  return result
}

describe('Narration audio', () => {
  it('scales or mutes the environment without changing the new voice or duration', () => {
    const inputs = ['aevalsrc=0.1|0.05:s=48000:d=0.25', 'aevalsrc=0.2:s=48000:d=0.25']
    const half = renderAudio(inputs, narrationMixGraph(0.25, { backgroundVolume: 0.5 }), true)
    const muted = renderAudio(inputs, narrationMixGraph(0.25, { backgroundVolume: 0 }), true)
    expect(half.length).toBe(12_000 * 2)
    expect(muted.length).toBe(half.length)
    expect((half[12_000] ?? NaN) - (half[12_001] ?? NaN)).toBeCloseTo(0.025, 5)
    expect(muted[12_000]).toBeCloseTo(muted[12_001] ?? NaN, 5)
    expect(muted[12_000]).toBeCloseTo(0.2 * Math.SQRT1_2, 5)
  })
  it('attenuates loud environment transients without changing quiet bed or voice', () => {
    const inputs = [
      "aevalsrc='if(between(t,0.1,0.15),0.6,0.05)|if(between(t,0.1,0.15),0.3,0.025)':s=48000:d=0.25",
      'aevalsrc=0.04:s=48000:d=0.25'
    ]
    const audio = renderAudio(inputs, narrationMixGraph(0.25, { backgroundVolume: 0.2 }), true)
    const sample = (time: number, channel: number): number => audio[Math.round(time * 48_000) * 2 + channel] ?? NaN
    const voice = 0.04 * Math.SQRT1_2
    const quietLeft = sample(0.05, 0)
    const quietRight = sample(0.05, 1)
    const transientLeft = sample(0.12, 0)
    const transientRight = sample(0.12, 1)
    // Below the compressor threshold, the environment remains exactly at its
    // requested level and the generated voice remains independently audible.
    expect(quietLeft).toBeCloseTo(0.05 * 0.2 + voice, 5)
    expect(quietRight).toBeCloseTo(0.025 * 0.2 + voice, 5)
    // The linked compressor reduces the transient well below static 20% while
    // preserving its L/R ratio after subtracting the unchanged mono voice.
    expect(transientLeft).toBeLessThan(0.09)
    expect((transientRight - quietRight) / (transientLeft - quietLeft)).toBeCloseTo(0.5, 2)
  })
  it('attenuates loud environment transients at full bed level too', () => {
    const inputs = [
      "aevalsrc='if(between(t,0.1,0.15),0.6,0.05)|if(between(t,0.1,0.15),0.3,0.025)':s=48000:d=0.25",
      'anullsrc=r=48000:cl=stereo:d=0.25'
    ]
    const audio = renderAudio(inputs, narrationMixGraph(0.25, { backgroundVolume: 1 }), true)
    const sample = (time: number, channel: number): number => audio[Math.round(time * 48_000) * 2 + channel] ?? NaN
    const quietLeft = sample(0.05, 0)
    const quietRight = sample(0.05, 1)
    const transientLeft = sample(0.12, 0)
    const transientRight = sample(0.12, 1)
    expect(quietLeft).toBeCloseTo(0.05, 5)
    expect(quietRight).toBeCloseTo(0.025, 5)
    expect(transientLeft).toBeLessThan(0.3)
    expect(transientRight / transientLeft).toBeCloseTo(0.5, 2)
  })
  it('levels generated speech with bounded gain and no timeline change', () => {
    const inputs = ['anullsrc=r=48000:cl=stereo:d=8',
      "aevalsrc='if(lt(t,4),0.02,0.2)*sin(2*PI*440*t)':s=48000:d=8"]
    const original = renderAudio(inputs, narrationMixGraph(8), true)
    const leveled = renderAudio(inputs, narrationMixGraph(8, { levelVoice: true }), true)
    const rms = (audio: Float32Array, from: number, to: number): number => {
      const samples = audio.subarray(from * 48000 * 2, to * 48000 * 2)
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
    }
    expect(leveled.length).toBe(8 * 48000 * 2)
    expect(leveled.every((value) => Number.isFinite(value) && Math.abs(value) <= 0.95)).toBe(true)
    expect(rms(leveled, 1, 2)).toBeGreaterThan(rms(original, 1, 2))
    expect(rms(leveled, 6, 7) / rms(leveled, 1, 2)).toBeLessThan(rms(original, 6, 7) / rms(original, 1, 2))
  })
  it('never levels the environment when generated speech is silent', () => {
    const audio = renderAudio(['aevalsrc=0.1|0.05:s=48000:d=0.25', 'anullsrc=r=48000:cl=stereo:d=0.25'],
      narrationMixGraph(0.25, { levelVoice: true }), true)
    expect(audio.length).toBe(12_000 * 2)
    expect(audio[12_000]).toBeCloseTo(0.1, 5)
    expect(audio[12_001]).toBeCloseTo(0.05, 5)
  })
  it('keeps short speech natural and pads its remaining time window', () => {
    const filter = narrationWindowFilter(placement())
    expect(filter).toContain('atempo=0.85')
    const audio = renderAudio(['aevalsrc=0.2:s=48000:d=0.25'], filter)
    expect(audio.length).toBe(24_000 * 2)
    expect(audio[0]).toBe(0)
    expect(audio[12_000]).toBeCloseTo(0.2 * Math.SQRT1_2, 3)
    expect(audio[25_000]).toBeGreaterThan(0.1)
    expect(audio.slice(36_000).every((value) => value === 0)).toBe(true)
  })

  it('lengthens speech without lowering pitch or filling the whole window', () => {
    const audio = renderAudio(['sine=frequency=440:sample_rate=48000:duration=0.25'], narrationWindowFilter(placement()))
    const left = audio.filter((_, index) => index % 2 === 0)
    const tail = left.slice(Math.round(0.26 * 48000), Math.round(0.28 * 48000))
    expect(Math.sqrt(tail.reduce((sum, value) => sum + value * value, 0) / tail.length)).toBeGreaterThan(0.03)
    let crossings = 0
    for (let index = 2401; index < 9600; index++) {
      if ((left[index - 1] ?? 0) <= 0 && (left[index] ?? 0) > 0) crossings++
    }
    expect(crossings / 0.15).toBeCloseTo(440, -1)
    expect(left.slice(18_000).every((value) => value === 0)).toBe(true)
    expect(narrationWindowFilter(placement(0.5))).not.toContain('atempo')
  })

  it('fits modest overruns using pitch-preserving tempo adjustment', () => {
    const filter = narrationWindowFilter(placement(0.55))
    expect(filter).toContain('atempo=1.1')
    const audio = renderAudio(['sine=frequency=440:sample_rate=48000:duration=0.55'], filter)
    expect(audio.length).toBe(24_000 * 2)
    expect(audio.every(Number.isFinite)).toBe(true)
    expect(audio.some((value) => value > 0.05)).toBe(true)
  })

  it('requires review rather than truncating an overlong utterance', () => {
    expect(() => narrationWindowFilter(placement(0.7))).toThrow('review the wording')
  })

  it.each([
    { tempo: NaN }, { tempo: Infinity }, { tempo: 0.49 }, { tempo: 1.2 },
    { windowSamples: 0 }, { generatedSamples: 0 }, { windowSamples: 0.5 },
    { tempo: 1, generatedSamples: 25_000 }, { needsReview: true }
  ])('rejects invalid placement: %j', (changes) => {
    expect(() => narrationWindowFilter({ ...placement(), ...changes })).toThrow('Narration')
  })

  it('mixes environment and new speech at exactly the requested sample count', () => {
    const audio = renderAudio([
      'aevalsrc=0.1|0.05:s=48000:d=0.25', 'aevalsrc=0.2:s=48000:d=0.25'
    ], narrationMixGraph(0.25), true)
    expect(audio.length).toBe(12_000 * 2)
    // Mono narration is distributed to stereo at -3 dB by FFmpeg; the bed's
    // stereo balance must survive. No normalization or automatic makeup gain.
    expect((audio[12_000] ?? NaN) - (audio[12_001] ?? NaN)).toBeCloseTo(0.05, 5)
    expect(audio[12_000]).toBeGreaterThan(0.2)
    expect(audio[12_000]).toBeLessThan(0.31)
  })

  it('pads empty tails without extending the timeline', () => {
    const audio = renderAudio([
      'anullsrc=r=44100:cl=stereo:d=0.1', 'anullsrc=r=16000:cl=mono:d=0.15'
    ], narrationMixGraph(0.25), true)
    expect(audio.length).toBe(12_000 * 2)
    expect(audio.every((value) => value === 0)).toBe(true)
  })

  it('rejects an invalid reconstruction duration', () => {
    expect(() => narrationMixGraph(NaN)).toThrow('Narration')
  })
})
