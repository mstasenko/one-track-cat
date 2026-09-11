import type { ExportRequest, SourceSegment } from '../types'
import { segmentOutputDuration } from '../segment-time'
import type { PreviewRange } from './preview-range'
import { previewTimelineOffset } from './preview-timing'

export interface PreviewSeekPlan {
  offset: number
  videoStart: number
  videoDuration: number
  audioStart: number
  audioDuration: number
  audioInputIndex?: number
  audioOffset?: number
}

interface PreviewFilter {
  graph: string
  videoLabel: string
  audioLabel: string
}

function seconds(value: number): string {
  return Math.max(0, value).toFixed(6)
}

function sourceFor(request: ExportRequest, segment: SourceSegment): ExportRequest['sources'][number]['metadata'] | undefined {
  return request.sources.find((source) => source.id === segment.sourceId)?.metadata
}

function normalSegment(segment: SourceSegment): segment is Extract<SourceSegment, { kind?: 'video' }> {
  return segment.kind !== 'freeze'
}

function overlapsRange(start: number, duration: number, range: PreviewRange): boolean {
  return start < range[1] && start + duration > range[0]
}

/** Drops later timeline work when the selected preview is wholly inside the first clip. */
export function previewSeekRequest(request: ExportRequest, range?: PreviewRange): ExportRequest {
  const first = request.segments[0]
  if (!range || !first || !normalSegment(first) || (first.playbackRate ?? 1) !== 1
    || range[1] > segmentOutputDuration(first)) return request
  const overlays = request.overlays.filter((item) => overlapsRange(item.start, item.duration, range))
  const focusZooms = (request.focusZooms ?? []).filter((item) => overlapsRange(item.start, item.duration, range))
  const videoTransitions = (request.videoTransitions ?? []).filter((item) => overlapsRange(item.start, item.duration, range))
  if (overlays.length || focusZooms.length || videoTransitions.length) return request
  return { ...request, segments: [first], overlays, focusZooms, videoTransitions }
}

/**
 * Selects the narrow 2-second-preroll case. The offset is quantized to the
 * source frame grid; audio stays on the original input so its timeline remains exact.
 */
export function previewSeekPlan(request: ExportRequest, range?: PreviewRange): PreviewSeekPlan | undefined {
  if (!range || range[0] <= 2 || request.segments.length !== 1) return undefined
  if (request.overlays.length > 0 || (request.focusZooms?.length ?? 0) > 0 || (request.videoTransitions?.length ?? 0) > 0) return undefined
  const segment = request.segments[0]
  if (!segment || !normalSegment(segment) || (segment.playbackRate ?? 1) !== 1) return undefined
  const source = sourceFor(request, segment)
  const fps = request.canvas.fps
  if (!source || !Number.isFinite(fps) || fps <= 0 || !Number.isFinite(source.fps) || source.fps <= 0 || source.fps !== fps) return undefined
  const duration = segment.sourceEnd - segment.sourceStart
  if (!Number.isFinite(duration) || range[1] > duration || range[1] <= range[0]) return undefined
  const offset = Math.floor((range[0] - 2) * request.canvas.fps) / request.canvas.fps
  if (!Number.isFinite(offset) || offset <= 0 || offset >= duration) return undefined
  return {
    offset,
    videoStart: segment.sourceStart + offset,
    videoDuration: duration - offset,
    audioStart: segment.sourceStart,
    audioDuration: duration,
    ...(source.hasAudio ? { audioInputIndex: 1 } : {})
  }
}

function laterPreviewSegment(request: ExportRequest, range: PreviewRange): { index: number; start: number } | undefined {
  let start = 0
  for (const [index, segment] of request.segments.entries()) {
    const end = start + segmentOutputDuration(segment)
    // Keep real joins and their audio de-click envelopes on the full composition path.
    if (index > 0 && range[0] > start + 2 && range[1] < end - 2 / request.canvas.fps) return { index, start }
    start = end
  }
  return undefined
}

/** Seek a later ordinary clip without changing the global frame numbers used by face caching. */
export async function preparePreviewSeek(request: ExportRequest, range?: PreviewRange): Promise<{
  request: ExportRequest
  seek?: PreviewSeekPlan
}> {
  const first = previewSeekRequest(request, range)
  const original = { request: first, seek: previewSeekPlan(first, range) }
  if (!range || original.seek || request.overlays.length || request.focusZooms?.length
    || request.segments.some((segment) => normalSegment(segment) && segment.transition)
    || request.videoTransitions?.some((effect) => overlapsRange(effect.start, effect.duration, range))) return original
  const selected = laterPreviewSegment(request, range)
  if (!selected) return original
  const offset = await previewTimelineOffset(request, selected.index)
  const segment = request.segments[selected.index]
  if (offset === undefined || !segment) return original
  const narrowed = { ...request, segments: [segment], videoTransitions: [] }
  const localRange: PreviewRange = [range[0] - offset, range[1] - offset]
  const seek = previewSeekPlan(narrowed, localRange)
  if (!seek) return original
  return {
    request: narrowed,
    seek: {
      ...seek,
      // Preserve a short tail for decoder/FPS end-of-input handling.
      videoDuration: Math.min(seek.videoDuration, localRange[1] + 1 - seek.offset),
      audioDuration: Math.min(seek.audioDuration, range[1] - selected.start + 1),
      offset: offset + seek.offset,
      audioOffset: selected.start
    }
  }
}

export function applyPreviewSeek(filter: PreviewFilter, plan?: PreviewSeekPlan): PreviewFilter {
  if (!plan) return filter
  const audio = plan.audioInputIndex === undefined ? undefined : `[${plan.audioInputIndex}:a:0]`
  const audioShift = plan.audioOffset ? `;[${filter.audioLabel}]asetpts=PTS+${seconds(plan.audioOffset)}/TB[seeka]` : ''
  return {
    graph: `${audio ? filter.graph.replaceAll('[0:a:0]', audio) : filter.graph};[${filter.videoLabel}]setpts=PTS+${seconds(plan.offset)}/TB[seekv]${audioShift}`,
    videoLabel: 'seekv',
    audioLabel: plan.audioOffset ? 'seeka' : filter.audioLabel
  }
}

export function prepareTimelineInputs(
  request: ExportRequest,
  inputArgs: string[] = [],
  plan?: PreviewSeekPlan,
  decoderInputArgs: readonly string[] = []
): ExportRequest {
  const sources = request.segments.map((segment, index) => {
    const source = sourceFor(request, segment)
    if (!source) throw new Error('A timeline video source is missing')
    if (segment.kind === 'freeze') {
      inputArgs.push('-ss', seconds(segment.sourceTime), '-t', '1', ...decoderInputArgs, '-threads', '4', '-i', source.path)
      return { id: `export-segment-${index}`, metadata: source }
    }
    const duration = segment.sourceEnd - segment.sourceStart
    const next = request.segments[index + 1]
    const handle = next?.kind !== 'freeze' && next?.transition
      ? Math.min(Math.max(0, source.duration - segment.sourceEnd), next.transition.duration * (segment.playbackRate ?? 1))
      : 0
    const seeked = plan && index === 0
    inputArgs.push(
      '-ss', seconds(seeked ? plan.videoStart : segment.sourceStart),
      '-t', seconds(seeked ? plan.videoDuration : duration + handle),
      ...decoderInputArgs, '-threads', '4', '-i', source.path
    )
    return {
      id: `export-segment-${index}`,
      metadata: { ...source, duration: duration + handle }
    }
  })
  if (plan?.audioInputIndex !== undefined) {
    const segment = request.segments[0]
    const source = segment && sourceFor(request, segment)
    if (segment && normalSegment(segment) && source) {
      inputArgs.push('-ss', seconds(plan.audioStart), '-t', seconds(plan.audioDuration), '-threads', '4', '-i', source.path)
    }
  }
  const segments = request.segments.map((segment, index): SourceSegment => segment.kind === 'freeze'
    ? { ...segment, sourceId: `export-segment-${index}`, sourceTime: 0 }
    : {
        ...segment,
        sourceId: `export-segment-${index}`,
        sourceStart: 0,
        sourceEnd: segment.sourceEnd - segment.sourceStart
      })
  return { ...request, sources, segments }
}
