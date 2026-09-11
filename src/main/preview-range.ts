import type { ExportRequest } from '../types'
import { timelineDuration } from '../segment-time'

export type PreviewRange = readonly [start: number, end: number]

const rangeTolerance = 0.0001
const frameEpsilon = 0.000001

interface PreviewFilter {
  graph: string
  videoLabel: string
  audioLabel: string
}

function timestamp(value: number): string {
  return Math.max(0, value).toFixed(6)
}

function frameCeil(value: number, fps: number): number {
  return Math.ceil(value * fps - frameEpsilon) / fps
}

export function validatedPreviewRange(value: unknown, request: ExportRequest): PreviewRange | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length !== 2) throw new Error('Preview range must contain exactly two values')
  const [rawStart, rawEnd] = value as unknown[]
  if (typeof rawStart !== 'number' || typeof rawEnd !== 'number' || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
    throw new Error('Preview range values must be finite numbers')
  }
  const duration = timelineDuration(request.segments)
  if (rawStart < -rangeTolerance || rawEnd > duration + rangeTolerance || rawStart >= rawEnd) {
    throw new Error('Preview range is outside the timeline')
  }
  if (duration > 0 && rawStart <= rangeTolerance && rawEnd >= duration - rangeTolerance) return undefined
  const fps = request.canvas.fps
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Preview range requires a positive frame rate')
  const timelineEnd = Math.ceil(duration * fps) / fps
  const start = Math.max(0, frameCeil(rawStart, fps))
  const end = Math.min(frameCeil(rawEnd, fps), timelineEnd)
  if (end <= start) throw new Error('Preview range contains no frames')
  return [start, end]
}

export function previewFilterGraph(filter: PreviewFilter, range?: PreviewRange): PreviewFilter {
  if (!range) return filter
  const [start, end] = range
  const videoMain = 'otc_prepare_main'
  const videoProbe = 'otc_prepare_probe'
  const preparationSelect = `select='lt(t,${timestamp(start)})*(isnan(prev_selected_t)+gte(t-prev_selected_t,1))'`
  return {
    graph: `${filter.graph};[${filter.videoLabel}]split=2[${videoMain}][${videoProbe}];` +
      `[${videoMain}]trim=start=${timestamp(start)}:end=${timestamp(end)},setpts=PTS-STARTPTS[previewv];` +
      `[${videoProbe}]trim=start=0:end=${timestamp(start)},${preparationSelect},showinfo@otc_prepare=checksum=0,nullsink;` +
      `[${filter.audioLabel}]atrim=start=${timestamp(start)}:end=${timestamp(end)},asetpts=PTS-STARTPTS[previewa]`,
    videoLabel: 'previewv',
    audioLabel: 'previewa'
  }
}

export function clippedFaceRequest(request: ExportRequest, range?: PreviewRange): ExportRequest {
  if (!range) return request
  const [start, end] = range
  const faceBlurs = (request.faceBlurs ?? []).flatMap((effect) => {
    const clippedStart = Math.max(effect.start, start)
    const clippedEnd = Math.min(effect.start + effect.duration, end)
    if (clippedEnd <= clippedStart) return []
    return [{ ...effect, start: clippedStart - start, duration: clippedEnd - clippedStart }]
  })
  return { ...request, faceBlurs }
}
