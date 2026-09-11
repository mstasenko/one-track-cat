import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, ImageOverlay, VideoRangeTransition } from '../types'

const timingMocks = vi.hoisted(() => ({ previewTimelineOffset: vi.fn() }))

vi.mock('./preview-timing', () => timingMocks)

import { preparePreviewSeek, prepareTimelineInputs } from './preview-seek'

const fps = 60000 / 1001
const range = [515.298117, 540.306433] as const
const prefixDuration = 320.32 - 70
const timingOffset = 250.316733
const prefixPath = '/input/prefix.mp4'
const selectedPath = '/input/selected.mp4'

function metadata(path: string, hasAudio = true) {
  return {
    path, name: path.split('/').at(-1) ?? 'input.mp4', size: 1, modifiedAt: 1,
    duration: 320.32, width: 1280, height: 720, fps, videoCodec: 'h264', hasAudio
  }
}

function request(overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    canvas: { width: 1280, height: 720, fps, fit: 'contain' },
    sources: [
      { id: 'prefix-source', metadata: metadata(prefixPath) },
      { id: 'selected-source', metadata: metadata(selectedPath) }
    ],
    segments: [
      { id: 'prefix', sourceId: 'prefix-source', sourceStart: 70, sourceEnd: 320.32 },
      { id: 'selected', sourceId: 'selected-source', sourceStart: 0, sourceEnd: 320.32 }
    ],
    overlays: [],
    outputPath: '/output.mp4',
    ...overrides
  }
}

function fixed(value: number): string {
  return Math.max(0, value).toFixed(6)
}

function expectedSeekOffset(): number {
  const localStart = range[0] - timingOffset
  return timingOffset + Math.floor((localStart - 2) * fps) / fps
}

beforeEach(() => {
  vi.clearAllMocks()
  timingMocks.previewTimelineOffset.mockResolvedValue(timingOffset)
})

describe('later selected-preview window preparation', () => {
  it('narrows to the selected clip while preserving global timing and request data', async () => {
    const faceBlur = {
      id: 'face', start: 515, duration: 30, sensitivity: 0.5, detail: 'standard' as const,
      holdSeconds: 0, strength: 0.5, style: 'blur' as const
    }
    const project = request({
      faceBlurs: [faceBlur],
      videoTransitions: [
        { id: 'opening', start: 0, duration: 5, into: { effect: 'fade', duration: 1 } },
        { id: 'ending', start: 1600, duration: 5, out: { effect: 'fade', duration: 1 } }
      ]
    })
    const original = structuredClone(project)
    const selectedSegment = project.segments[1]
    if (!selectedSegment || selectedSegment.kind === 'freeze') throw new Error('expected selected video')

    const prepared = await preparePreviewSeek(project, range)

    const localStart = range[0] - timingOffset
    const localOffset = Math.floor((localStart - 2) * fps) / fps
    const globalOffset = expectedSeekOffset()
    expect(timingMocks.previewTimelineOffset).toHaveBeenCalledWith(project, 1)
    expect(prepared.request.segments).toEqual([project.segments[1]])
    expect(prepared.request.faceBlurs).toBe(project.faceBlurs)
    expect(prepared.request.videoTransitions).toEqual([])
    expect(prepared.seek).toMatchObject({
      offset: globalOffset,
      audioOffset: prefixDuration,
      videoStart: localOffset,
      audioDuration: range[1] - prefixDuration + 1
    })
    expect(prepared.seek?.offset).toBeCloseTo(globalOffset, 12)
    expect(prepared.seek?.videoStart).toBeCloseTo(selectedSegment.sourceStart + localOffset, 12)
    expect(prepared.seek?.videoDuration).toBeCloseTo(range[1] - timingOffset + 1 - localOffset, 9)
    expect(prepared.seek?.videoDuration).toBeLessThanOrEqual(selectedSegment.sourceEnd - selectedSegment.sourceStart - localOffset)
    expect(prepared.seek?.audioOffset).toBe(250.32)

    const args: string[] = []
    prepareTimelineInputs(prepared.request, args, prepared.seek)
    expect(args).toEqual([
      '-ss', fixed(prepared.seek?.videoStart ?? 0), '-t', fixed(prepared.seek?.videoDuration ?? 0),
      '-threads', '4', '-i', selectedPath,
      '-ss', '0.000000', '-t', fixed(prepared.seek?.audioDuration ?? 0),
      '-threads', '4', '-i', selectedPath
    ])
    expect(args.filter((value) => value === prefixPath)).toHaveLength(0)
    expect(args.filter((value) => value === selectedPath)).toHaveLength(2)
    expect(project).toEqual(original)
  })

  it('keeps the existing first-clip fast path without a timing probe', async () => {
    const first = request().segments[0]
    if (!first) throw new Error('missing first segment')
    const firstClip = request({ segments: [first] })

    const prepared = await preparePreviewSeek(firstClip, [6, 7])

    expect(timingMocks.previewTimelineOffset).not.toHaveBeenCalled()
    expect(prepared.request.segments).toEqual(firstClip.segments)
    expect(prepared.seek?.videoStart).toBeGreaterThan(2)
  })

  it('keeps the full request when no range is selected or timing metadata is missing', async () => {
    const project = request()

    const full = await preparePreviewSeek(project)
    expect(full).toEqual({ request: project, seek: undefined })
    expect(timingMocks.previewTimelineOffset).not.toHaveBeenCalled()

    timingMocks.previewTimelineOffset.mockResolvedValueOnce(undefined)
    const missing = await preparePreviewSeek(project, range)
    expect(missing).toEqual({ request: project, seek: undefined })
    expect(timingMocks.previewTimelineOffset).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['crosses the clip join', [prefixDuration - 1, prefixDuration + 1] as const],
    ['starts within the first two seconds of a clip', [prefixDuration + 0.5, prefixDuration + 1.5] as const],
    ['touches the final audio edge of a clip', [prefixDuration + 319.5, prefixDuration + 320.31] as const]
  ])('keeps the full request when the selected range %s', async (_name, selectedRange) => {
    const project = request()

    const prepared = await preparePreviewSeek(project, selectedRange)

    expect(prepared).toEqual({ request: project, seek: undefined })
    expect(timingMocks.previewTimelineOffset).not.toHaveBeenCalled()
  })

  it.each([
    ['an overlay', { overlays: [{
      id: 'overlay', type: 'image', name: 'overlay', path: '/overlay.png', start: 0,
      duration: 1, zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1
    } satisfies ImageOverlay] }],
    ['a focus zoom', { focusZooms: [{ id: 'zoom', start: 0, duration: 1, zoom: 2, focusX: 0.5, focusY: 0.5 }] }],
    ['a clip transition', { segments: [
      { id: 'prefix', sourceId: 'prefix-source', sourceStart: 70, sourceEnd: 320.32 }, {
        id: 'selected', sourceId: 'selected-source', sourceStart: 0, sourceEnd: 320.32,
        transition: { effect: 'fade', duration: 1 }
      }
    ] }],
    ['an overlapping range fade', { videoTransitions: [{
      id: 'range-fade', start: range[0] + 1, duration: 1,
      into: { effect: 'fade' as const, duration: 0.5 }
    } satisfies VideoRangeTransition] }]
  ] satisfies [string, Partial<ExportRequest>][])('keeps the full request for %s', async (_name, overrides) => {
    const project = request(overrides)

    const prepared = await preparePreviewSeek(project, range)

    expect(prepared).toEqual({ request: project, seek: undefined })
    expect(timingMocks.previewTimelineOffset).not.toHaveBeenCalled()
  })

  it('keeps a global audio offset while using generated silence for a silent selected source', async () => {
    const project = request({
      sources: [
        { id: 'prefix-source', metadata: metadata(prefixPath) },
        { id: 'selected-source', metadata: metadata(selectedPath, false) }
      ]
    })
    const prepared = await preparePreviewSeek(project, range)
    if (!prepared.seek) throw new Error('expected a later-clip seek')

    const args: string[] = []
    prepareTimelineInputs(prepared.request, args, prepared.seek)

    expect(prepared.seek.audioOffset).toBe(prefixDuration)
    expect(prepared.seek.audioInputIndex).toBeUndefined()
    expect(args.filter((value) => value === selectedPath)).toHaveLength(1)
    expect(args).not.toContain(prefixPath)
  })
})
