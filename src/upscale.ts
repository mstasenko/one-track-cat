import {
  upscaleTargetFps,
  upscaleTargetLongEdge,
  type UpscaleMode,
  type ExportRequest,
  type FocusZoomEffect,
  type ProjectCanvas
} from './types'
import { isShortCanvas } from './short-frame'
import { segmentOutputDuration, segmentPlaybackRate } from './segment-time'

export interface UpscalePlan {
  canvas: ProjectCanvas
  spatial: boolean
  interpolate: boolean
  mode: UpscaleMode
  /** Absent means the whole video. Otherwise only these half-open intervals use Flash. */
  spatialRanges?: [number, number][]
  /** Repeated render-clock frames in lower-rate clips may need interpolation too. */
  interpolationRanges?: [number, number][]
}

export const flashSpatialSupportMessage =
  'FlashVSR+ spatial enhancement supports 3840×2160 or 2160×3840 output.'

/** Same half-open source-frame boundary as the native worker's duration ceiling. */
export function upscaleSourceFrame(time: number, fps: number): number {
  const value = time * fps
  return Math.max(0, Math.ceil(value - 8 * Number.EPSILON * Math.max(1, value)))
}

function frameInterpolationPlan(canvas: ProjectCanvas,
  timeline?: Pick<ExportRequest, 'sources' | 'segments'>): Pick<UpscalePlan, 'interpolate' | 'interpolationRanges'> {
  if (!timeline?.segments.length) return { interpolate: canvas.fps <= 59 }
  const rates = new Map(timeline.sources.map((source) => [source.id, source.metadata.fps]))
  const ranges: [number, number][] = []
  let position = 0
  let interpolate = false
  for (const segment of timeline.segments) {
    const duration = segmentOutputDuration(segment)
    const rate = (rates.get(segment.sourceId) ?? canvas.fps) * segmentPlaybackRate(segment)
    if (segment.kind !== 'freeze' && duration > 0) {
      if (rate <= 59) interpolate = true
      if (rate < Math.max(canvas.fps, upscaleTargetFps)) ranges.push([position, position + duration])
    }
    position += duration
  }
  return { interpolate, ...(interpolate && ranges.length ? { interpolationRanges: ranges } : {}) }
}

/** Preserve source frames on the output clock; RIFE fills only duplicated slots.
 * Spatial inference keeps its source clock so Flash never enhances extra frames.
 */
export function upscaleRenderRequest(request: ExportRequest, plan: UpscalePlan): ExportRequest {
  return !plan.spatial && plan.interpolate && request.canvas.fps !== plan.canvas.fps
    ? { ...request, canvas: { ...request.canvas, fps: plan.canvas.fps } }
    : request
}

/** Derive independent work from the effective canvas; never shrink pixels or lower frame rate. */
export function upscalePlan(
  canvas: ProjectCanvas,
  mode: UpscaleMode = 'turbo',
  focusZooms: FocusZoomEffect[] = [],
  timeline?: Pick<ExportRequest, 'sources' | 'segments'>
): UpscalePlan {
  const upscale = Math.max(canvas.width, canvas.height) < upscaleTargetLongEdge
  // Shorts use a fixed 1080x1920 editing canvas even for 4K footage. For a
  // timeline made entirely from 4K sources, reserve AI for close-ups instead
  // of treating that editing size as evidence of low-resolution source video.
  const highResolutionShort = isShortCanvas(canvas) && timeline !== undefined && timeline.segments.length > 0 &&
    timeline.segments.every((segment) => {
      const source = timeline.sources.find((item) => item.id === segment.sourceId)?.metadata
      return source !== undefined && Math.max(source.width, source.height) >= upscaleTargetLongEdge &&
        Math.min(source.width, source.height) >= 2160
    })
  const closeupsOnly = highResolutionShort || !upscale && Math.max(canvas.width, canvas.height) === upscaleTargetLongEdge
  // A 4K close-up has fewer source pixels even though its output canvas is still 4K.
  const closeups = closeupsOnly
    ? focusZooms.filter((effect) => effect.mode !== 'circle' && effect.zoom > 1 && effect.duration > 0).sort((a, b) => a.start - b.start)
    : []
  const spatialRanges: [number, number][] = []
  for (const effect of closeups) {
    const start = upscaleSourceFrame(effect.start, canvas.fps) / canvas.fps
    const end = upscaleSourceFrame(effect.start + effect.duration, canvas.fps) / canvas.fps
    if (end <= start) continue
    const previous = spatialRanges.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else spatialRanges.push([start, end])
  }
  const spatial = upscale && !closeupsOnly || spatialRanges.length > 0
  const interpolation = frameInterpolationPlan(canvas, timeline)
  const scale = upscale ? upscaleTargetLongEdge / Math.max(canvas.width, canvas.height) : 1
  return {
    spatial,
    ...interpolation,
    mode,
    ...(spatialRanges.length ? { spatialRanges } : {}),
    canvas: {
      ...canvas,
      width: spatial ? Math.max(2, Math.round(canvas.width * scale / 2) * 2) : canvas.width,
      height: spatial ? Math.max(2, Math.round(canvas.height * scale / 2) * 2) : canvas.height,
      fps: interpolation.interpolate ? Math.max(upscaleTargetFps, canvas.fps) : canvas.fps
    }
  }
}

/**
 * The fixed landscape graph also handles portrait via a lossless orientation adapter.
 * RIFE-only plans do not use a Flash spatial model and therefore remain generic.
 */
export function isFlashSpatialSupported(plan: UpscalePlan): boolean {
  return !plan.spatial || (Math.max(plan.canvas.width, plan.canvas.height) === 3840 &&
    Math.min(plan.canvas.width, plan.canvas.height) === 2160)
}
