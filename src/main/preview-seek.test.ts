import { describe, expect, it } from 'vitest'
import type { ExportRequest, ImageOverlay } from '../types'
import { applyPreviewSeek, prepareTimelineInputs, previewSeekPlan, previewSeekRequest } from './preview-seek'

const source = (fps = 30, hasAudio = true) => ({
  path: '/input/source.mkv', name: 'Source', size: 1, modifiedAt: 1, duration: 12,
  width: 64, height: 36, fps, videoCodec: 'ffv1', hasAudio
})

const segment = { id: 'segment', sourceId: 'source', sourceStart: 1, sourceEnd: 10 } as const

function request(overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    canvas: { width: 64, height: 36, fps: 30, fit: 'contain' },
    sources: [{ id: 'source', metadata: source() }],
    segments: [segment],
    overlays: [], outputPath: '/tmp/output.mp4', ...overrides
  }
}

const selectedRange = [6, 7] as const

describe('selected-preview input seeking', () => {
  it('plans a two-second-preroll seek on a normal single segment', () => {
    expect(previewSeekPlan(request(), selectedRange)).toEqual({
      offset: 4, videoStart: 5, videoDuration: 5, audioStart: 1, audioDuration: 9, audioInputIndex: 1
    })
  })

  it.each([
    ['missing range', request(), undefined],
    ['range at the preroll boundary', request(), [2, 3] as const],
    ['multiple untrimmed segments', request({ segments: [segment, { ...segment, id: 'second' }] }), selectedRange],
    ['changed playback rate', request({ segments: [{ ...segment, playbackRate: 2 }] }), selectedRange],
    ['mismatched source frame rate', request({ sources: [{ id: 'source', metadata: source(60) }] }), selectedRange],
    ['source with invalid frame rate', request({ sources: [{ id: 'source', metadata: source(Number.NaN) }] }), selectedRange]
  ])('falls back for %s', (_name, project, range) => {
    expect(previewSeekPlan(project, range)).toBeUndefined()
  })

  it('keeps the existing generated-silence audio path for a source without audio', () => {
    const project = request({ sources: [{ id: 'source', metadata: source(30, false) }] })
    const plan = previewSeekPlan(project, selectedRange)
    expect(plan?.audioInputIndex).toBeUndefined()
    const args: string[] = []
    prepareTimelineInputs(project, args, plan)
    expect(args).toEqual([
      '-ss', '5.000000', '-t', '5.000000', '-threads', '4', '-i', '/input/source.mkv'
    ])
  })

  it('falls back when a timed visual effect would make the graph non-local', () => {
    const overlay: ImageOverlay = {
      id: 'overlay', type: 'image', name: 'Overlay', path: '/overlay.png', start: 0, duration: 1,
      zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1
    }
    expect(previewSeekPlan(request({ overlays: [overlay] }), selectedRange)).toBeUndefined()
    expect(previewSeekPlan(request({ focusZooms: [{ id: 'zoom', start: 0, duration: 1, zoom: 2, focusX: 0.5, focusY: 0.5 }] }), selectedRange)).toBeUndefined()
    expect(previewSeekPlan(request({
      videoTransitions: [{ id: 'transition', start: 0, duration: 1, into: { effect: 'fade', duration: 0.5 } }]
    }), selectedRange)).toBeUndefined()
  })

  it('drops later clips and unrelated effects before seeking a selected range', () => {
    const project = request({
      segments: [segment, { ...segment, id: 'second' }],
      videoTransitions: [
        { id: 'opening', start: 0, duration: 1, into: { effect: 'fade', duration: 1 } },
        { id: 'ending', start: 16, duration: 1, out: { effect: 'fade', duration: 1 } }
      ]
    })
    const narrowed = previewSeekRequest(project, selectedRange)
    expect(narrowed.segments).toEqual([segment])
    expect(narrowed.videoTransitions).toEqual([])
    expect(previewSeekPlan(narrowed, selectedRange)).toMatchObject({ offset: 4, videoStart: 5 })
  })

  it('keeps the full request when selected-range content must retain timeline timing', () => {
    const overlay: ImageOverlay = {
      id: 'overlay', type: 'image', name: 'Overlay', path: '/overlay.png', start: 6, duration: 1,
      zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1
    }
    const project = request({ segments: [segment, { ...segment, id: 'second' }], overlays: [overlay] })
    expect(previewSeekRequest(project, selectedRange)).toBe(project)
  })

  it('seeks video while retaining a full-duration original audio input', () => {
    const plan = previewSeekPlan(request(), selectedRange)
    if (!plan) throw new Error('expected a seek plan')
    const args: string[] = []
    const prepared = prepareTimelineInputs(request(), args, plan)
    expect(prepared.segments[0]).toMatchObject({ sourceStart: 0, sourceEnd: 9 })
    expect(args).toEqual([
      '-ss', '5.000000', '-t', '5.000000', '-threads', '4', '-i', '/input/source.mkv',
      '-ss', '1.000000', '-t', '9.000000', '-threads', '4', '-i', '/input/source.mkv'
    ])
  })

  it('adds hardware decoding only to video-bearing inputs', () => {
    const plan = previewSeekPlan(request(), selectedRange)
    if (!plan) throw new Error('expected a seek plan')
    const args: string[] = []
    prepareTimelineInputs(request(), args, plan, ['-hwaccel', 'auto', '-hwaccel_device', '/dev/dri/renderD128'])
    expect(args).toEqual([
      '-ss', '5.000000', '-t', '5.000000', '-hwaccel', 'auto', '-hwaccel_device', '/dev/dri/renderD128',
      '-threads', '4', '-i', '/input/source.mkv',
      '-ss', '1.000000', '-t', '9.000000', '-threads', '4', '-i', '/input/source.mkv'
    ])
  })

  it('restores the seeked video timestamp and rewires only the timeline audio', () => {
    const plan = previewSeekPlan(request(), selectedRange)
    if (!plan) throw new Error('expected a seek plan')
    const original = { graph: '[0:v:0]x[v];[0:a:0]y[a]', videoLabel: 'v', audioLabel: 'a' }
    expect(applyPreviewSeek(original, plan)).toEqual({
      graph: '[0:v:0]x[v];[1:a:0]y[a];[v]setpts=PTS+4.000000/TB[seekv]', videoLabel: 'seekv', audioLabel: 'a'
    })
    expect(applyPreviewSeek(original)).toBe(original)
  })
})
