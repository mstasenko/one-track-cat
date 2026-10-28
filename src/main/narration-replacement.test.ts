import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AudioOverlay } from '../types'
import { gameAudioGainAtOutputTime, isAudioEnabledOverlay, narrationGainAtLocalTime } from '../audio-envelope'
import { addAudioOverlayFilters } from './audio-filters'

const overlay: AudioOverlay = { id: 'narration', name: 'AI Narration', type: 'audio', path: '/generated.wav',
  sourceIn: 0, volume: 1, start: 1, duration: 1, zIndex: 1,
  narration: { draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true } }

describe('Narration replacement', () => {
  it('keeps original speech muted across touching replacement sections in preview', () => {
    const first = { ...overlay, start: 0, duration: 0.1 + 0.2 }
    const second = { ...overlay, id: 'second', start: 0.3, duration: 1 }
    for (const time of [0.2975, 0.3, 0.3025]) {
      expect(gameAudioGainAtOutputTime([second, first], time)).toBe(0)
    }
    expect(gameAudioGainAtOutputTime([first, { ...second, start: 0.4 }], 0.35)).toBe(1)
  })

  it('exports no original-audio burst between adjacent silent narration sections', () => {
    const filters = ['[0:a]aformat=channel_layouts=stereo[basea]']
    addAudioOverlayFilters(filters, [
      { overlay: { ...overlay, start: 0 }, index: 1 },
      { overlay: { ...overlay, id: 'second', start: 1 }, index: 2 }
    ], 3)
    const result = spawnSync(join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg'), [
      '-v', 'error', '-filter_complex_threads', '1', '-f', 'lavfi', '-i', 'aevalsrc=0.1|0.1:s=48000:d=3',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1',
      '-filter_complex', filters.join(';'), '-map', '[aout]', '-f', 'f32le', 'pipe:1'
    ], { maxBuffer: 2 * 1024 ** 2, timeout: 10000 })
    expect(result.status, result.stderr.toString()).toBe(0)
    const samples = new Float32Array(Uint8Array.from(result.stdout).buffer)
    const joinSamples = samples.subarray(Math.round(0.97 * 48000) * 2, Math.round(1.03 * 48000) * 2)
    expect(Math.max(...joinSamples.map(Math.abs))).toBeLessThan(0.00001)
  })

  it('switches Original/AI without leaving the base muted or the replacement audible', () => {
    expect(isAudioEnabledOverlay(overlay)).toBe(true)
    expect(gameAudioGainAtOutputTime([overlay], 1.5)).toBe(0)
    const original = { ...overlay, narration: { ...overlay.narration, draftId: 'draft', enabled: false } }
    expect(isAudioEnabledOverlay(original)).toBe(false)
    expect(gameAudioGainAtOutputTime([original], 1.5)).toBe(1)
  })

  it('uses complementary smooth preview gains only inside the replacement range', () => {
    for (const time of [0, 0.999, 1, 1.001, 1.0025, 1.005, 1.5, 1.999, 2, 3]) {
      const gain = narrationGainAtLocalTime(1, time - 1)
      expect(gain).toBeGreaterThanOrEqual(0)
      expect(gain).toBeLessThanOrEqual(1)
      expect(gameAudioGainAtOutputTime([overlay], time) + gain).toBeCloseTo(1, 12)
    }
  })

  it('exports sample-accurate replacement without old speech, clicks, or duration changes', () => {
    const filters: string[] = ['[0:a]aformat=channel_layouts=stereo[basea]']
    addAudioOverlayFilters(filters, [{ overlay, index: 1 }], 3)
    const result = spawnSync(join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg'), [
      '-v', 'error', '-filter_complex_threads', '1', '-f', 'lavfi', '-i', 'aevalsrc=0.1|0.1:s=48000:d=3',
      '-f', 'lavfi', '-i', 'aevalsrc=0.2|0.2:s=48000:d=1', '-filter_complex', filters.join(';'),
      '-map', '[aout]', '-f', 'f32le', 'pipe:1'
    ], { maxBuffer: 2 * 1024 ** 2, timeout: 10000 })
    expect(result.status, result.stderr.toString()).toBe(0)
    const samples = new Float32Array(Uint8Array.from(result.stdout).buffer)
    // Existing final limiter has a fixed lookahead delay; compare away from edges.
    expect(samples.length / 2).toBeGreaterThanOrEqual(3 * 48000)
    expect(samples[48000]).toBeCloseTo(0.1 / 0.95, 4)
    expect(samples[144000]).toBeCloseTo(0.2 / 0.95, 4)
    expect(samples[240000]).toBeCloseTo(0.1 / 0.95, 4)
    let largestStep = 0
    for (let index = 9600; index < samples.length - 9600; index += 2) largestStep = Math.max(largestStep, Math.abs((samples[index] ?? 0) - (samples[index - 2] ?? 0)))
    expect(largestStep).toBeLessThan(0.001)
  })
})
