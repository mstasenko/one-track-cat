import { describe, expect, it } from 'vitest'
import type { ExportRequest, FaceBlurEffect } from '../types'
import { clippedFaceRequest, previewFilterGraph, validatedPreviewRange, type PreviewRange } from './preview-range'

const effect = (start: number, duration: number): FaceBlurEffect => ({
  id: `${start}-${duration}`, start, duration, sensitivity: 0.5, detail: 'standard', holdSeconds: 0,
  strength: 0.5, style: 'blur'
})
const request = (faceBlurs?: FaceBlurEffect[]): ExportRequest => ({
  canvas: { width: 64, height: 64, fps: 10, fit: 'contain' }, sources: [], segments: [], overlays: [], outputPath: '/tmp/out.mp4',
  ...(faceBlurs === undefined ? {} : { faceBlurs })
})
const timelineRequest = (fps = 30): ExportRequest => ({
  ...request(),
  canvas: { width: 64, height: 64, fps, fit: 'contain' },
  segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }]
})
const filter = { graph: '[basev]null[vout];[basea]anull[aout]', videoLabel: 'vout', audioLabel: 'aout' }

describe('selected preview ranges', () => {
  it('keeps an omitted or complete range on the full-preview path', () => {
    const timeline = timelineRequest()
    expect(validatedPreviewRange(undefined, timeline)).toBeUndefined()
    expect(validatedPreviewRange([0, 10], timeline)).toBeUndefined()
  })

  it.each([
    null,
    [],
    [1],
    [1, 2, 3],
    ['1', 2],
    [Number.NaN, 2],
    [2, Number.POSITIVE_INFINITY],
    [-0.001, 2],
    [2, 10.001]
  ])('rejects malformed or out-of-bounds range %j', (range) => {
    expect(() => validatedPreviewRange(range, timelineRequest())).toThrow(/Preview range/)
  })

  it('returns a nonzero range with the requested timeline duration', () => {
    expect(validatedPreviewRange([2, 5], timelineRequest())).toEqual([2, 5])
  })

  it('aligns both ends upward to the frame grid and caps the final frame', () => {
    expect(validatedPreviewRange([1.001, 2.001], timelineRequest(30))).toEqual([31 / 30, 61 / 30])
    expect(validatedPreviewRange([2, 10.00005], timelineRequest(30))).toEqual([2, 10])
  })

  it('rejects a range that contains no complete output frame', () => {
    expect(() => validatedPreviewRange([1.0001, 1.0002], timelineRequest(30))).toThrow(/no frames/)
  })

  it('keeps the original filter when no range is supplied', () => {
    expect(previewFilterGraph(filter)).toBe(filter)
  })

  it('trims the final video and audio labels after the full graph', () => {
    expect(previewFilterGraph(filter, [2, 5])).toEqual({
      graph: '[basev]null[vout];[basea]anull[aout];[vout]split=2[otc_prepare_main][otc_prepare_probe];' +
        "[otc_prepare_main]trim=start=2.000000:end=5.000000,setpts=PTS-STARTPTS[previewv];" +
        "[otc_prepare_probe]trim=start=0:end=2.000000,select='lt(t,2.000000)*(isnan(prev_selected_t)+gte(t-prev_selected_t,1))',showinfo@otc_prepare=checksum=0,nullsink;" +
        '[aout]atrim=start=2.000000:end=5.000000,asetpts=PTS-STARTPTS[previewa]',
      videoLabel: 'previewv', audioLabel: 'previewa'
    })
  })

  it('keeps the selected output on the split main branch while probing only earlier frames', () => {
    const result = previewFilterGraph(filter, [2, 5])
    expect(result.videoLabel).toBe('previewv')
    expect(result.graph).toContain('[vout]split=2[otc_prepare_main][otc_prepare_probe]')
    expect(result.graph).toContain("trim=start=0:end=2.000000,select='lt(t,2.000000)*(isnan(prev_selected_t)+gte(t-prev_selected_t,1))'")
    expect(result.graph).toContain('showinfo@otc_prepare=checksum=0,nullsink')
    expect(result.graph).toContain('[otc_prepare_main]trim=start=2.000000:end=5.000000')
  })

  it.each([
    { name: 'clips the start', range: [2, 5] as PreviewRange, source: effect(1, 3), expected: { ...effect(1, 3), start: 0, duration: 2 } },
    { name: 'clips the end', range: [2, 5] as PreviewRange, source: effect(4, 4), expected: { ...effect(4, 4), start: 2, duration: 1 } },
    { name: 'clips both sides', range: [3, 7] as PreviewRange, source: effect(1, 10), expected: { ...effect(1, 10), start: 0, duration: 4 } }
  ])('$name and rebases the effect', ({ range, source, expected }) => {
    expect(clippedFaceRequest(request([source]), range).faceBlurs).toEqual([expected])
  })

  it('drops effects outside the selected range and leaves ordinary encoding', () => {
    const clipped = clippedFaceRequest(request([effect(0, 1)]), [2, 3])
    expect(clipped.faceBlurs).toEqual([])
    expect(clippedFaceRequest(request(), [2, 3]).faceBlurs).toEqual([])
  })

  it('returns the original request when no range is supplied', () => {
    const original = request([effect(1, 2)])
    expect(clippedFaceRequest(original)).toBe(original)
  })
})
