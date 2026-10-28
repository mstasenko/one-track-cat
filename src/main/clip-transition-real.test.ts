import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, SourceSegment, VideoTransition } from '../types'
import { segmentOutputDuration, timelineDuration } from '../segment-time'

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./binaries', () => ({
  ffmpegPath: () => join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  ffprobePath: () => join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe')
}))
vi.mock('./jobs', () => ({ jobs: { run: vi.fn() } }))
vi.mock('./intel-device', () => ({ restrictedIntelRenderNode: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./privileged-export', () => ({ encodeWithPrivilegedGpu: vi.fn() }))
vi.mock('./face-export', () => ({ encodeWithFaces: vi.fn() }))
vi.mock('./face-preview-cache', () => ({ tryReuseFacePreview: vi.fn().mockResolvedValue(false) }))

import { buildFilterGraph, prepareTimelineInputs } from './exporter'

const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const width = 64
const height = 48
const frameBytes = width * height * 3 / 2
const defaultFps = 30

interface FixtureSource {
  id: string
  path: string
  duration: number
  fps: number
}

interface FfmpegResult {
  stdout: Buffer
  stderr: Buffer
  status: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

interface RenderedGraph {
  raw: Buffer
  pts: number[]
}

interface TransitionCase {
  name: string
  fps: number
  segments: SourceSegment[]
  transitionCount: number
  fadeCount: number
  dissolveCount?: number
  wholeIncoming?: boolean
}

let directory: string
let sources: FixtureSource[]

function seconds(value: number): string {
  return Math.max(0, value).toFixed(6)
}

function invokeFfmpeg(args: string[], loglevel = 'error', input?: Buffer): FfmpegResult {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', loglevel, '-nostats', '-y',
    '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
    ...args
  ], {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    ...(input ? { input } : {}),
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', otc_CPU_ONLY: '1' }
  })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error } : {})
  }
}

function runFfmpeg(args: string[], input?: Buffer): Buffer {
  const result = invokeFfmpeg(args, 'error', input)
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.toString('utf8').trim() || `ffmpeg exited with ${result.status ?? result.signal}`
    throw new Error(detail)
  }
  return result.stdout
}

function createSource(source: FixtureSource, expression: string): void {
  const frameCount = Math.ceil(source.duration * source.fps) + 1
  runFfmpeg([
    '-f', 'lavfi', '-i', `nullsrc=s=${width}x${height}:r=${source.fps}:d=${source.duration}`,
    '-vf', `geq=${expression}`,
    '-frames:v', String(frameCount), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', source.path
  ])
}

function metadata(source: FixtureSource) {
  return {
    path: source.path,
    name: `${source.id}.mkv`,
    size: 1,
    modifiedAt: 1,
    duration: source.duration,
    width,
    height,
    fps: source.fps,
    videoCodec: 'ffv1',
    hasAudio: false
  }
}

function request(segments: SourceSegment[], fps: number): ExportRequest {
  return {
    canvas: { width, height, fps, fit: 'contain' },
    sources: sources.map((source) => ({ id: source.id, metadata: metadata(source) })),
    segments,
    overlays: [],
    outputPath: join(directory, 'unused.mkv')
  }
}

function videoSegment(
  id: string,
  sourceId: string,
  sourceStart: number,
  sourceEnd: number,
  options: { playbackRate?: 0.25 | 0.5 | 1 | 2 | 4; transition?: VideoTransition } = {}
): SourceSegment {
  return { id, sourceId, sourceStart, sourceEnd, ...options }
}

function nativeBlendFragment(inputs: string, mixed: string, duration: number, fps: number, effect: 'fade' | 'dissolve'): string {
  const frameDuration = Math.max(1, Math.round(duration * fps)) / fps
  const progress = `min(1,max(0,T/${seconds(frameDuration)}))`
  const weight = effect === 'fade' ? `(${progress}*${progress}*(3-2*${progress}))` : progress
  const expression = `A*(1-(${weight}))+B*(${weight})`.replaceAll(',', '\\,')
  return `${inputs}blend=all_expr='${expression}':shortest=1,format=yuv420p${mixed}`
}

function nativeClipOracle(graph: string, request: ExportRequest): string {
  const fragments = graph.split(';')
  request.segments.forEach((segment, index) => {
    const transition = segment.kind === 'freeze' ? undefined : segment.transition
    const effect = transition?.effect
    if (effect !== 'fade' && effect !== 'dissolve') return
    const marker = `[vmixed${index}]`
    const position = fragments.findIndex((fragment) => fragment.endsWith(marker) && fragment.includes(`blend@vfade${index}=`))
    if (position < 0) throw new Error(`Missing fade fragment for segment ${index}`)
    const fragment = fragments[position]
    if (!fragment) throw new Error(`Missing fade fragment for segment ${index}`)
    const inputs = /^(\[[^\]]+\]\[[^\]]+\])/.exec(fragment)
    const inputLabels = inputs?.[1]
    if (!inputLabels) throw new Error(`Malformed fade fragment for segment ${index}`)
    if (!transition) throw new Error(`Missing transition for segment ${index}`)
    fragments[position] = nativeBlendFragment(inputLabels, marker, transition.duration, request.canvas.fps, effect)
  })
  return fragments.join(';')
}

function removeGlobalDissolveBlur(graph: string): string {
  const fragments = graph.split(';')
  const position = fragments.findIndex((fragment) => fragment.includes('gblur@clipdissolve=') && fragment.endsWith('[clipdissolve]'))
  if (position < 0) return graph
  const fragment = fragments[position]
  if (!fragment) throw new Error('Missing global dissolve blur fragment')
  const input = /^\[[^\]]+\]/.exec(fragment)?.[0]
  if (!input) throw new Error('Malformed global dissolve blur fragment')
  fragments[position] = `${input}null[clipdissolve]`
  return fragments.join(';')
}

function renderGraph(graph: string, inputArgs: string[], videoLabel: string, audioLabel: string, frameCount?: number): RenderedGraph {
  const result = invokeFfmpeg([
    ...inputArgs,
    '-filter_complex', `${graph};[${videoLabel}]format=yuv420p,showinfo[transition_out];[${audioLabel}]anullsink`,
    '-map', '[transition_out]', '-an', '-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p',
    ...(frameCount === undefined ? [] : ['-frames:v', String(frameCount)]),
    '-f', 'rawvideo', 'pipe:1'
  ], 'info')
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.toString('utf8').trim() || `ffmpeg exited with ${result.status ?? result.signal}`
    throw new Error(detail)
  }
  if (result.stdout.length % frameBytes !== 0) {
    throw new Error(`Raw output is not frame-aligned: ${result.stdout.length} bytes`)
  }
  const pts = [...result.stderr.toString('utf8').matchAll(/showinfo.*?pts:\s*(-?\d+).*?pts_time:\s*([-+\d.]+)/g)]
    .map((match) => Number(match[1]))
  return { raw: result.stdout, pts }
}

function frameDifference(left: Buffer, right: Buffer): number {
  let maximum = 0
  for (let index = 0; index < frameBytes; index += 1) {
    maximum = Math.max(maximum, Math.abs((left[index] ?? 0) - (right[index] ?? 0)))
  }
  return maximum
}

function softIntervals(project: ExportRequest): [number, number][] {
  const intervals: [number, number][] = []
  let start = 0
  for (const segment of project.segments) {
    if (segment.kind !== 'freeze' && (segment.transition?.effect === 'fade' || segment.transition?.effect === 'dissolve')) {
      intervals.push([start, start + segment.transition.duration])
    }
    start += segmentOutputDuration(segment)
  }
  return intervals
}

function sourceFrames(path: string, frameCount: number): Buffer {
  return runFfmpeg([
    '-i', path,
    '-frames:v', String(frameCount), '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1'
  ])
}

function staticBlur(frame: Buffer, sigma: number): Buffer {
  return runFfmpeg([
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', '1', '-i', 'pipe:0',
    '-vf', `gblur=sigma=${sigma.toFixed(6)}:sigmaV=${sigma.toFixed(6)}:steps=2`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'
  ], frame)
}

function dissolveSigma(time: number, start: number, duration: number, fps: number): number {
  const frameDuration = Math.max(1, Math.round(duration * fps)) / fps
  const progress = Math.min(1, Math.max(0, (time - start) / frameDuration))
  return 10 * progress * (1 - progress)
}

function assertDissolveBlur(actual: RenderedGraph, linear: RenderedGraph, project: ExportRequest): void {
  let start = 0
  for (const segment of project.segments) {
    const transition = segment.kind === 'freeze' ? undefined : segment.transition
    if (transition?.effect === 'dissolve') {
      const end = start + transition.duration
      const frames = actual.pts.map((pts, index) => ({ index, time: pts / 1_000_000 }))
      const inside = frames.filter(({ time }) => time >= start - 1e-6 && time < end + 1e-6)
      if (inside.length === 0) throw new Error(`No rendered dissolve frames in ${start}-${end}`)
      const middle = inside.reduce((best, frame) =>
        Math.abs(frame.time - (start + transition.duration / 2)) < Math.abs(best.time - (start + transition.duration / 2)) ? frame : best
      )
      const before = [...frames].reverse().find(({ time }) => time < start - 1e-6)
      const after = frames.find(({ time }) => time >= end - 1e-6)
      for (const frame of [before, middle, after]) {
        if (!frame) continue
        const input = linear.raw.subarray(frame.index * frameBytes, (frame.index + 1) * frameBytes)
        const sigma = dissolveSigma(frame.time, start, transition.duration, project.canvas.fps)
        const expected = staticBlur(input, sigma)
        const output = actual.raw.subarray(frame.index * frameBytes, (frame.index + 1) * frameBytes)
        expect(frameDifference(output, expected), `dissolve ${start}-${end} frame ${frame.index} time ${frame.time} sigma ${sigma}`).toBeLessThanOrEqual(1)
      }
      if (before) {
        const beforeFrame = linear.raw.subarray(before.index * frameBytes, (before.index + 1) * frameBytes)
        const middleFrame = linear.raw.subarray(middle.index * frameBytes, (middle.index + 1) * frameBytes)
        expect(frameDifference(beforeFrame, middleFrame)).toBeGreaterThan(0)
      }
    }
    start += segmentOutputDuration(segment)
  }
}

const cases: TransitionCase[] = [
  {
    name: 'consecutive fades',
    fps: defaultFps,
    transitionCount: 3,
    fadeCount: 3,
    segments: [
      videoSegment('fade-a', 'a', 0.1, 1.1),
      videoSegment('fade-b', 'b', 0.05, 1.05, { transition: { effect: 'fade', duration: 0.5 } }),
      videoSegment('fade-c', 'c', 0.2, 1.2, { transition: { effect: 'fade', duration: 0.5 } }),
      videoSegment('fade-d', 'd', 0.1, 1.1, { transition: { effect: 'fade', duration: 0.5 } })
    ]
  },
  {
    name: 'fade, wipe, circle',
    fps: defaultFps,
    transitionCount: 3,
    fadeCount: 1,
    segments: [
      videoSegment('mixed-a', 'a', 0, 0.8),
      videoSegment('mixed-b', 'b', 0.1, 0.9, { transition: { effect: 'fade', duration: 0.2 } }),
      videoSegment('mixed-c', 'c', 0.2, 1, { transition: { effect: 'wipeleft', duration: 0.2 } }),
      videoSegment('mixed-d', 'd', 0.3, 1.1, { transition: { effect: 'circleopen', duration: 0.2 } })
    ]
  },
  {
    name: 'consecutive dissolves',
    fps: defaultFps,
    transitionCount: 3,
    fadeCount: 0,
    dissolveCount: 3,
    segments: [
      videoSegment('dissolve-a', 'a', 0.05, 1.05),
      videoSegment('dissolve-b', 'b', 0.1, 1.1, { transition: { effect: 'dissolve', duration: 0.35 } }),
      videoSegment('dissolve-c', 'c', 0.2, 1.2, { transition: { effect: 'dissolve', duration: 0.4 } }),
      videoSegment('dissolve-d', 'd', 0.11, 1.11, { transition: { effect: 'dissolve', duration: 0.23 } })
    ]
  },
  {
    name: 'mixed dissolves at fractional fps',
    fps: 60000 / 1001,
    transitionCount: 4,
    fadeCount: 1,
    dissolveCount: 2,
    segments: [
      videoSegment('mixed-dissolve-a', 'a', 0.01, 0.71),
      videoSegment('mixed-dissolve-b', 'b', 0.12, 0.92, { transition: { effect: 'dissolve', duration: 0.3 } }),
      videoSegment('mixed-dissolve-c', 'c', 0.17, 0.82, { transition: { effect: 'wipeleft', duration: 0.2 } }),
      videoSegment('mixed-dissolve-d', 'd', 0.21, 0.91, { transition: { effect: 'dissolve', duration: 0.23 } }),
      videoSegment('mixed-dissolve-e', 'a', 0.3, 0.95, { transition: { effect: 'fade', duration: 0.19 } })
    ]
  },
  {
    name: 'spin',
    fps: defaultFps,
    transitionCount: 1,
    fadeCount: 0,
    segments: [
      videoSegment('spin-a', 'a', 0.1, 0.9),
      videoSegment('spin-b', 'b', 0.2, 1, { transition: { effect: 'spin', duration: 0.25 } })
    ]
  },
  {
    name: 'fractional source, freeze, speed, exhausted handle',
    fps: defaultFps,
    transitionCount: 1,
    fadeCount: 1,
    wholeIncoming: true,
    segments: [
      videoSegment('fractional-d', 'd', 0.133, 0.733, { playbackRate: 2 }),
      { kind: 'freeze', id: 'fractional-freeze', sourceId: 'a', sourceTime: 0.6, duration: 0.4 },
      videoSegment('fractional-a', 'a', 0.2, 1.2, { playbackRate: 0.5 }),
      videoSegment('fractional-b', 'b', 0.15, 0.55, { transition: { effect: 'fade', duration: 0.4 } })
    ]
  },
  {
    name: 'freeze and speeds without transitions',
    fps: defaultFps,
    transitionCount: 0,
    fadeCount: 0,
    segments: [
      videoSegment('plain-a', 'a', 0, 0.6, { playbackRate: 2 }),
      { kind: 'freeze', id: 'plain-freeze', sourceId: 'b', sourceTime: 0.4, duration: 0.3 },
      videoSegment('plain-c', 'c', 0.1, 0.6, { playbackRate: 0.5 })
    ]
  }
]

describe('CPU clip transition oracle', () => {
  beforeAll(() => {
    vi.stubEnv('otc_CPU_ONLY', '1')
    if (!existsSync(ffmpeg)) throw new Error(`missing test ffmpeg: ${ffmpeg}`)
    directory = mkdtempSync(join(tmpdir(), 'otc-clip-transition-real-'))
    sources = [
      { id: 'a', path: join(directory, 'a.mkv'), duration: 1.3, fps: defaultFps },
      { id: 'b', path: join(directory, 'b.mkv'), duration: 1.3, fps: defaultFps },
      { id: 'c', path: join(directory, 'c.mkv'), duration: 1.3, fps: defaultFps },
      { id: 'd', path: join(directory, 'd.mkv'), duration: 1.3, fps: 60000 / 1001 }
    ]
    const sourceA = sources[0]
    const sourceB = sources[1]
    const sourceC = sources[2]
    const sourceD = sources[3]
    if (!sourceA || !sourceB || !sourceC || !sourceD) throw new Error('Transition fixtures are incomplete')
    createSource(sourceA, "lum='40+X+2*Y+N':cb='80+mod(3*X+N,50)':cr='170+mod(2*Y+N,50)'")
    createSource(sourceB, "lum='170-X+Y+N':cb='120+mod(X+2*N,40)':cr='70+mod(2*Y+N,80)'")
    createSource(sourceC, "lum='80+2*X+N':cb='180+mod(X+N,60)':cr='90+mod(3*Y+N,60)'")
    createSource(sourceD, "lum='25+X+Y+N':cb='70+mod(X+N,80)':cr='160+mod(2*Y+N,70)'")
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each(cases)('matches the native-420 oracle: $name', (testCase) => {
    const project = request(testCase.segments, testCase.fps)
    const inputArgs: string[] = []
    const prepared = prepareTimelineInputs(project, inputArgs)
    const current = buildFilterGraph(prepared, [])
    const oracle = removeGlobalDissolveBlur(nativeClipOracle(current.graph, prepared))
    const actual = renderGraph(current.graph, inputArgs, current.videoLabel, current.audioLabel)
    const reference = renderGraph(oracle, inputArgs, current.videoLabel, current.audioLabel)

    expect(actual.raw.length).toBe(reference.raw.length)
    expect(actual.pts).toEqual(reference.pts)
    expect(actual.raw.length / frameBytes).toBe(Math.round(timelineDuration(prepared.segments) * prepared.canvas.fps))
    expect(actual.pts).toHaveLength(actual.raw.length / frameBytes)
    expect((prepared.segments.filter((segment) => segment.kind !== 'freeze' && segment.transition).length)).toBe(testCase.transitionCount)
    const intervals = softIntervals(prepared)
    const dissolveIntervals = intervals.filter((_, intervalIndex) => {
      let transitionIndex = 0
      for (const segment of prepared.segments) {
        if (segment.kind !== 'freeze' && (segment.transition?.effect === 'fade' || segment.transition?.effect === 'dissolve')) {
          if (transitionIndex === intervalIndex) return segment.transition.effect === 'dissolve'
          transitionIndex += 1
        }
      }
      return false
    })
    let maximum = 0
    let maximumFrame = -1
    for (let frame = 0; frame < actual.raw.length / frameBytes; frame += 1) {
      const actualFrame = actual.raw.subarray(frame * frameBytes, (frame + 1) * frameBytes)
      const referenceFrame = reference.raw.subarray(frame * frameBytes, (frame + 1) * frameBytes)
      const difference = frameDifference(actualFrame, referenceFrame)
      const time = (actual.pts[frame] ?? 0) / 1_000_000
      const inFade = intervals.some(([start, end]) => time >= start - 1e-6 && time < end + 1e-6)
      const inDissolve = dissolveIntervals.some(([start, end]) => time >= start - 1e-6 && time < end + 1e-6)
      if (!inDissolve && difference > maximum) {
        maximum = difference
        maximumFrame = frame
      }
      if (!inFade && !inDissolve) expect(difference).toBe(0)
    }
    const allowedDifference = testCase.fadeCount > 0 ? 1 : 0
    if (maximum > allowedDifference) {
      const actualFrame = actual.raw.subarray(maximumFrame * frameBytes, (maximumFrame + 1) * frameBytes)
      const referenceFrame = reference.raw.subarray(maximumFrame * frameBytes, (maximumFrame + 1) * frameBytes)
      let channel = 0
      for (let index = 0; index < frameBytes; index += 1) {
        if (Math.abs((actualFrame[index] ?? 0) - (referenceFrame[index] ?? 0)) === maximum) {
          channel = index
          break
        }
      }
      throw new Error(`native clip reference mismatch: max=${maximum} frame=${maximumFrame} pts=${actual.pts[maximumFrame]} channel=${channel} actual=${actualFrame[channel]} reference=${referenceFrame[channel]}`)
    }
    const dissolveCount = testCase.dissolveCount ?? 0
    expect(current.graph.match(/gblur@clipdissolve=/g) ?? []).toHaveLength(dissolveCount > 0 ? 1 : 0)
    if (dissolveCount > 0) {
      expect(current.graph).toContain('sigmaV=0')
      expect(current.graph).toContain('gblur@clipdissolve sigmaV')
      assertDissolveBlur(actual, reference, prepared)
    }
    if (testCase.wholeIncoming) {
      expect(current.graph).not.toContain('[vremainder')
      expect(current.graph).toContain('tpad=stop_mode=clone:stop_duration=0.400000,trim=duration=2.400000')
    }

    // Keep the source-handle and speed cases honest: every rendered case must have
    // more than one frame and a non-zero transition graph when requested.
    expect(actual.raw.length).toBeGreaterThan(frameBytes)
  }, 30_000)

  it('preserves native source detail at the fade entry', () => {
    const project = request([
      videoSegment('endpoint-a', 'a', 0, 0.8),
      videoSegment('endpoint-b', 'b', 0, 0.5, { transition: { effect: 'fade', duration: 0.25 } })
    ], defaultFps)
    const inputArgs: string[] = []
    const prepared = prepareTimelineInputs(project, inputArgs)
    const current = buildFilterGraph(prepared, [])
    const actual = renderGraph(current.graph, inputArgs, current.videoLabel, current.audioLabel)
    const fadeFrame = Math.round(0.8 * defaultFps)
    const source = sources.find((candidate) => candidate.id === 'a')
    if (!source) throw new Error('Missing endpoint source fixture')
    const expected = sourceFrames(source.path, fadeFrame + 1)
    // The first overlap frame is still the outgoing source, including chroma.
    // xfade's 4:4:4 conversion used to blur this source detail before blending.
    expect(frameDifference(
      actual.raw.subarray(fadeFrame * frameBytes, (fadeFrame + 1) * frameBytes),
      expected.subarray(fadeFrame * frameBytes, (fadeFrame + 1) * frameBytes)
    )).toBe(0)
  }, 30_000)
})
