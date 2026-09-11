import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, VideoRangeTransition } from '../types'
import { ffmpegPath } from './binaries'
import { addVideoRangeTransitionFilters } from './video-range-transition'

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }))

const width = 64
const height = 64
const frameBytes = width * height * 3
const ffmpeg = ffmpegPath()

interface RenderConfig {
  fps: number
  duration: number
  frameCount: number
  source: 'white' | 'testsrc2'
}

const baseline: RenderConfig = { fps: 10, duration: 3, frameCount: 30, source: 'white' }

function seconds(value: number): string {
  return value.toFixed(6)
}

function smoothRamp(time: string, start: number, rampDuration: number): string {
  const progress = `min(1,max(0,((${time})-${seconds(start)})/${seconds(rampDuration)}))`
  return `(${progress}*${progress}*(3-2*${progress}))`
}

function edgeWeight(time: string, start: number, rampDuration: number, outgoing = false): string {
  const ramp = smoothRamp(time, start, rampDuration)
  return `between(${time},${seconds(start)},${seconds(start + rampDuration)})*(${outgoing ? ramp : `1-${ramp}`})`
}

function weightsFor(effect: VideoRangeTransition, effects: readonly string[]): string[] {
  const weights: string[] = []
  if (effect.into && effects.includes(effect.into.effect)) {
    weights.push(edgeWeight('T', effect.start, effect.into.duration))
  }
  if (effect.out && effects.includes(effect.out.effect)) {
    weights.push(edgeWeight('T', effect.start + effect.duration - effect.out.duration, effect.out.duration, true))
  }
  return weights
}

function weightExpression(weights: string[]): string {
  if (weights.length === 0) throw new Error('expected at least one transition edge')
  return weights.length === 1 ? (weights[0] ?? '') : `max(${weights.join(',')})`
}

function request(effect: VideoRangeTransition, config: RenderConfig): ExportRequest {
  return {
    canvas: { width, height, fps: config.fps, fit: 'contain' },
    sources: [{ id: 'source', metadata: {
      path: '/synthetic-white', name: 'synthetic-white', size: 1,
      modifiedAt: 1, duration: config.duration, width, height, fps: config.fps, videoCodec: 'rawvideo', hasAudio: false
    } }],
    segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: config.duration }],
    overlays: [], videoTransitions: [effect], outputPath: '/unused.mp4'
  }
}

function helperGraph(effect: VideoRangeTransition, config: RenderConfig): string {
  const filters = ['[0:v]format=yuv420p,settb=AVTB[src]']
  const output = addVideoRangeTransitionFilters(filters, request(effect, config), 'src')
  filters.push(`[${output}]format=rgb24[out]`)
  return filters.join(';')
}

/** The former per-pixel reference graph, retained to catch frame-boundary drift. */
function oldBlend(left: string, right: string, output: string, weights: string[]): string {
  const weight = weightExpression(weights)
  const expression = `A*(1-(${weight}))+B*(${weight})`.replaceAll(',', '\\,')
  return `[${left}][${right}]blend=all_expr='${expression}'[${output}]`
}

function oldReferenceGraph(effect: VideoRangeTransition, config: RenderConfig): string {
  const filters = ['[0:v]format=yuv420p,settb=AVTB[src]']
  let current = 'src'
  const fadeWeights = weightsFor(effect, ['fade', 'dissolve'])
  if (fadeWeights.length > 0) {
    filters.push(
      `[${current}]null[vrfadeclean0]`,
      `color=c=black:s=${width}x${height}:r=${config.fps}:d=${seconds(config.duration)},settb=AVTB[vrblack0]`,
      oldBlend('vrfadeclean0', 'vrblack0', 'vrfade0', fadeWeights)
    )
    current = 'vrfade0'
  }
  const blurWeights = weightsFor(effect, ['hblur', 'dissolve'])
  if (blurWeights.length > 0) {
    filters.push(
      `[${current}]split=2[vrclean0][vrblurin0]`,
      '[vrblurin0]gblur=sigma=18:steps=2[vrblur0]',
      oldBlend('vrclean0', 'vrblur0', 'vrout0', blurWeights)
    )
    current = 'vrout0'
  }
  filters.push(`[${current}]format=rgb24[out]`)
  return filters.join(';')
}

function render(graph: string, config: RenderConfig): Buffer {
  const source = config.source === 'white'
    ? `color=c=white:s=${width}x${height}:r=${config.fps}:d=${config.duration}`
    : `testsrc2=size=${width}x${height}:rate=${config.fps}:duration=${config.duration}`
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
    '-f', 'lavfi', '-i', source,
    '-filter_complex', graph, '-map', '[out]', '-frames:v', String(config.frameCount),
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'
  ], { maxBuffer: config.frameCount * frameBytes + 65536 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.toString('utf8').trim() || `ffmpeg exited with ${result.status ?? result.signal}`
    throw new Error(detail)
  }
  const output = result.stdout
  if (output.length !== config.frameCount * frameBytes) {
    throw new Error(`expected ${config.frameCount * frameBytes} RGB bytes, received ${output.length}`)
  }
  return output
}

function frames(raw: Buffer, frameCount: number): Buffer[] {
  return Array.from({ length: frameCount }, (_, index) => raw.subarray(index * frameBytes, (index + 1) * frameBytes))
}

function meanLuma(frame: Buffer): number {
  let total = 0
  for (const value of frame) total += value
  return total / Math.max(1, frame.length)
}

function maxDifference(left: Buffer, right: Buffer): number {
  let maximum = 0
  for (let index = 0; index < frameBytes; index += 1) {
    maximum = Math.max(maximum, Math.abs((left[index] ?? 0) - (right[index] ?? 0)))
  }
  return maximum
}

describe('CPU video range transition graph', () => {
  beforeAll(() => {
    if (!existsSync(ffmpeg)) throw new Error(`missing test ffmpeg: ${ffmpeg}`)
  })

  it.each([
    ['fade into a range', { id: 'fade-into', start: 1, duration: 1, into: { effect: 'fade' as const, duration: 1 } }],
    ['fade starting at zero', { id: 'fade-zero', start: 0, duration: 1, into: { effect: 'fade' as const, duration: 1 } }],
    ['fade out of a range', { id: 'fade-out', start: 1, duration: 1, out: { effect: 'fade' as const, duration: 1 } }]
  ] as const)('matches the former all_expr pixels for %s', (_name, effect) => {
    const actual = frames(render(helperGraph(effect, baseline), baseline), baseline.frameCount)
    const reference = frames(render(oldReferenceGraph(effect, baseline), baseline), baseline.frameCount)

    expect(actual).toHaveLength(baseline.frameCount)
    expect(reference).toHaveLength(baseline.frameCount)
    for (let index = 0; index < baseline.frameCount; index += 1) {
      const output = actual[index]
      const expected = reference[index]
      if (!output || !expected) throw new Error(`missing transition frame ${index}`)
      const difference = maxDifference(output, expected)
      if (difference > 2) {
        throw new Error(`frame ${index} differs by ${difference}: actual=${meanLuma(output)} reference=${meanLuma(expected)}`)
      }
    }

    // Explicitly cover a frame before, at, inside, at the end of, and after the range.
    const checkpoints = effect.start === 0 ? [0, 5, 9, 10, 11] : [9, 10, 15, 19, 20, 21]
    for (const index of checkpoints) {
      const output = actual[index]
      const expected = reference[index]
      if (!output || !expected) throw new Error(`missing checkpoint frame ${index}`)
      expect(Math.abs(meanLuma(output) - meanLuma(expected))).toBeLessThanOrEqual(2)
    }

    if (effect.start === 1 && 'into' in effect) {
      expect(meanLuma(actual[9] ?? Buffer.alloc(frameBytes))).toBeGreaterThan(240)
      expect(meanLuma(actual[10] ?? Buffer.alloc(frameBytes))).toBeLessThan(5)
      expect(meanLuma(actual[15] ?? Buffer.alloc(frameBytes))).toBeGreaterThan(120)
      expect(meanLuma(actual[15] ?? Buffer.alloc(frameBytes))).toBeLessThan(135)
      expect(meanLuma(actual[20] ?? Buffer.alloc(frameBytes))).toBeGreaterThan(240)
    }
  }, 30_000)

  it.each([
    ['dissolve at fractional fps', {
      id: 'dissolve-fractional', start: 0.5, duration: 1,
      into: { effect: 'dissolve' as const, duration: 0.5 }, out: { effect: 'dissolve' as const, duration: 0.5 }
    }],
    ['hblur at fractional fps', {
      id: 'hblur-fractional', start: 0.5, duration: 1,
      into: { effect: 'hblur' as const, duration: 0.5 }
    }]
  ] as const)('matches the former all_expr pixels for %s on a non-uniform source', (_name, effect) => {
    const fractional: RenderConfig = { fps: 60000 / 1001, duration: 2, frameCount: 120, source: 'testsrc2' }
    const actual = frames(render(helperGraph(effect, fractional), fractional), fractional.frameCount)
    const reference = frames(render(oldReferenceGraph(effect, fractional), fractional), fractional.frameCount)

    expect(actual).toHaveLength(fractional.frameCount)
    expect(reference).toHaveLength(fractional.frameCount)
    for (let index = 0; index < fractional.frameCount; index += 1) {
      const output = actual[index]
      const expected = reference[index]
      if (!output || !expected) throw new Error(`missing fractional transition frame ${index}`)
      const difference = maxDifference(output, expected)
      if (difference > 2) {
        throw new Error(`fractional frame ${index} differs by ${difference}: actual=${meanLuma(output)} reference=${meanLuma(expected)}`)
      }
    }
  }, 30_000)
})
