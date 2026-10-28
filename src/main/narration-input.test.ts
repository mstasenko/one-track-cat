import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExportRequest, VideoSpeed } from '../types'
import { narrationInputArgs } from './narration-input'
import { audioTempoFilter, segmentAudioEnvelope } from './segment-audio'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
let directory: string
let source: string

function run(args: string[]): Buffer {
  const result = spawnSync(ffmpeg, args, { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.toString())
  return result.stdout
}

function request(rate: VideoSpeed = 1): ExportRequest {
  return {
    canvas: { width: 64, height: 36, fps: 30, fit: 'contain' }, outputPath: '/unused.mp4', overlays: [],
    sources: [{ id: 'source', metadata: {
      path: source, name: 'speech.wav', size: 1, modifiedAt: 1, duration: 2, width: 64, height: 36,
      fps: 30, videoCodec: 'h264', hasAudio: true
    } }],
    segments: [{ id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 1, playbackRate: rate }]
  }
}

function render(project: ExportRequest, range: readonly [number, number]): Float32Array {
  const args = narrationInputArgs(project, range, 'unused.wav').slice(0, -1)
  const bytes = Uint8Array.from(run([...args, '-f', 'f32le', 'pipe:1']))
  return new Float32Array(bytes.buffer)
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'otc-narration-input-'))
  source = join(directory, "speech's original.wav")
  run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.2|0.1:s=48000:d=2',
    '-c:a', 'pcm_f32le', source])
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('Narration input', () => {
  it('always recognizes original audio even after narration has been applied', () => {
    const project = request()
    const before = render(project, [0.2, 0.6])
    const originalArgs = narrationInputArgs(project, [0.2, 0.6], '/new.wav')
    project.overlays = [{ id: 'redo', type: 'audio', name: 'Speech redo', path: '/never-read-generated.wav',
      sourceIn: 0, start: 0, duration: 1, zIndex: 0, volume: 1,
      narration: { draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true } }]
    for (let repeat = 0; repeat < 2; repeat += 1) {
      expect(narrationInputArgs(project, [0.2, 0.6], '/new.wav')).toEqual(originalArgs)
      expect(render(project, [0.2, 0.6])).toEqual(before)
    }
  })

  it('seeks to the selected audio without decoding video or including added layers', () => {
    const project = request()
    project.overlays = [{ id: 'meme', type: 'audio', name: 'meme', path: '/missing-meme.wav',
      sourceIn: 0, start: 0, duration: 1, zIndex: 0, volume: 1 }]
    const args = narrationInputArgs(project, [0.2, 0.6], '/new.wav')
    expect(args).toContain('0.200000000')
    expect(args).not.toContain('/missing-meme.wav')
    expect(args.indexOf('-vn')).toBeLessThan(args.indexOf('-i'))
    expect(args).toContain('-1')
    const audio = render(project, [0.2, 0.6])
    expect(audio.length).toBe(19_200 * 2)
    expect(audio[12_000]).toBeCloseTo(0.2, 6)
    expect(audio[12_001]).toBeCloseTo(0.1, 6)
  })

  it.each([0.25, 0.5, 1, 2, 4] as const)('preserves exact selected length at %sx speed', (rate) => {
    const audio = render(request(rate), [0.05, 0.2])
    expect(audio.length).toBe(7200 * 2)
    expect(audio.every(Number.isFinite)).toBe(true)
    expect(audio.some((sample) => sample > 0.05)).toBe(true)
  })

  it('ignores sub-sample rounding tails when recognition starts exactly at a cut', () => {
    const project = request()
    project.segments = [
      { id: 'a', sourceId: 'source', sourceStart: 0, sourceEnd: 0.1 },
      { id: 'b', sourceId: 'source', sourceStart: 0, sourceEnd: 0.2 },
      { id: 'c', sourceId: 'source', sourceStart: 1, sourceEnd: 1.5 }
    ]
    const args = narrationInputArgs(project, [0.3, 0.5], '/new.wav')
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1)
    const selected = render(project, [0.3, 0.5])
    const full = render(project, [0, 0.8])
    expect(selected.length).toBe(9600 * 2)
    expect(selected).toEqual(full.slice(14400 * 2, 24000 * 2))
    // Keep actual one-sample pieces; only zero-sample numerical tails vanish.
    const oneSample = narrationInputArgs(project, [0.3 - 1 / 48000, 0.5], '/new.wav')
    expect(oneSample.filter((arg) => arg === '-i')).toHaveLength(2)
    expect(render(request(), [0, 1 / 48000])).toHaveLength(2)
  })

  it('renders silent freezes and sources with no audio without opening their video', () => {
    const project = request()
    const original = project.sources[0]
    if (!original) throw new Error('Missing test source')
    original.metadata.hasAudio = false
    original.metadata.path = '/not-opened.mp4'
    project.segments.push({ id: 'freeze', kind: 'freeze', sourceId: 'source', sourceTime: 1, duration: 0.5 })
    const args = narrationInputArgs(project, [0, 1.5], '/new.wav')
    expect(args).not.toContain('-i')
    const audio = render(project, [0, 1.5])
    expect(audio.length).toBe(72_000 * 2)
    expect(audio.every((sample) => sample === 0)).toBe(true)
  })

  it('retains the existing join envelope when selection begins inside its fade', () => {
    const project = request()
    project.segments.push({ id: 'second', sourceId: 'source', sourceStart: 0, sourceEnd: 1,
      transition: { effect: 'fade', duration: 0.5 } })
    const full = render(project, [0, 2])
    for (const start of [0.995, 1.005]) {
      const selected = render(project, [start, start + 0.05])
      const offset = Math.round(start * 48000) * 2
      expect(selected.length).toBe(2400 * 2)
      for (let index = 0; index < selected.length; index += 1) {
        expect(selected[index]).toBeCloseTo(full[offset + index] ?? NaN, 5)
      }
    }
  })

  it('handles Replay as another original-source segment and omits unselected inputs', () => {
    const project = request()
    const original = project.sources[0]
    if (!original) throw new Error('Missing test source')
    project.sources.push({ ...original, id: 'unused', metadata: { ...original.metadata, path: '/not-opened.mp4' } })
    project.segments.push({ id: 'replay', sourceId: 'source', sourceStart: 0, sourceEnd: 1, replayGroupId: 'r1' })
    const args = narrationInputArgs(project, [1.2, 1.6], '/new.wav')
    expect(args.filter((value) => value === '-i')).toHaveLength(1)
    expect(args).not.toContain('/not-opened.mp4')
    expect(render(project, [1.2, 1.6]).length).toBe(19_200 * 2)
  })

  it('rejects a missing source instead of processing another clip', () => {
    const project = request()
    project.sources = []
    expect(() => narrationInputArgs(project, [0, 0.5], '/new.wav')).toThrow('source is missing')
  })

  it.each([[NaN, 1], [0, Infinity], [-1, 1], [1, 1], [0, 2]])('rejects invalid range %j', (start, end) => {
    expect(() => narrationInputArgs(request(), [start, end], '/new.wav')).toThrow('outside the timeline')
  })

  it('shares the ordinary export tempo and join rules without changing defaults', () => {
    expect(audioTempoFilter(0.25)).toBe('atempo=0.5,atempo=0.5')
    expect(audioTempoFilter(4)).toBe('atempo=2,atempo=2')
    expect(segmentAudioEnvelope(0, true, true)).toBe('')
    expect(segmentAudioEnvelope(1, true, true)).toBe(',afade=t=in:st=0:d=0.010000,afade=t=out:st=0.990000:d=0.010000')
  })
})
