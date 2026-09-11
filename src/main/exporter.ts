import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExportRequest, Overlay, SourceSegment, VisualOverlayBase } from '../types'
import { exportEncoders, integratedDecodeDevice, softwareEncoder } from './export-encoder'
import { ensureDiskSpace, ensureFaceExportDiskSpace } from './export-space'
import { jobs } from './jobs'
import { addTextOverlayFilters, textAnimationFilterExpressions } from './text-filters'
import { addAudioOverlayFilters } from './audio-filters'
import { segmentOutputDuration, segmentPlaybackRate, timelineDuration } from '../segment-time'
import { overlayFit } from '../overlay-fit'
import { encodeWithFaces } from './face-export'
import { tryReuseFacePreview } from './face-preview-cache'
import { restrictedIntelRenderNode } from './face-worker'
import { encodeWithPrivilegedGpu } from './privileged-export'
import { clippedFaceRequest, previewFilterGraph, type PreviewRange } from './preview-range'
import { applyPreviewSeek, prepareTimelineInputs, preparePreviewSeek, type PreviewSeekPlan } from './preview-seek'
import { addVideoRangeTransitionFilters } from './video-range-transition'
import { frameAlphaFilter } from './frame-alpha'

export { prepareTimelineInputs } from './preview-seek'
export { estimatedExportBytes, ensureFaceExportDiskSpace } from './export-space'

type Encoder = Awaited<ReturnType<typeof exportEncoders>>[number]

interface PreparedInput {
  overlay: Overlay
  index: number
}

function seconds(value: number): string {
  return Math.max(0, value).toFixed(6)
}

function focusZoomExpression(request: ExportRequest): { zoom: string; x: string; y: string } | null {
  const effects = request.focusZooms ?? []
  if (effects.length === 0) return null
  const time = `on/${request.canvas.fps}`
  let zoom = '1'
  let x = '0'
  let y = '0'
  for (const effect of [...effects].reverse()) {
    const end = effect.start + effect.duration
    const ramp = Math.min(0.18, effect.duration / 3)
    const local = `((${time})-${seconds(effect.start)})`
    const easedIn = `pow(min(1,max(0,${local}/${seconds(ramp)})),2)*(3-2*min(1,max(0,${local}/${seconds(ramp)})))`
    const easedOut = `pow(min(1,max(0,(${seconds(end)}-(${time}))/${seconds(ramp)})),2)*(3-2*min(1,max(0,(${seconds(end)}-(${time}))/${seconds(ramp)})))`
    const activeZoom = `(1+${effect.zoom - 1}*min(${easedIn},${easedOut}))`
    const active = `between(${time},${seconds(effect.start)},${seconds(end)})`
    zoom = `if(${active},${activeZoom},${zoom})`
    x = `if(${active},max(0,min(iw-iw/zoom,${effect.focusX}*iw-iw/(2*zoom))),${x})`
    y = `if(${active},max(0,min(ih-ih/zoom,${effect.focusY}*ih-ih/(2*zoom))),${y})`
  }
  return { zoom, x, y }
}

function audioTempoFilter(rate: number): string {
  if (rate === 1) return 'anull'
  const factors = rate === 0.25 ? [0.5, 0.5] : rate === 4 ? [2, 2] : [rate]
  return factors.map((factor) => `atempo=${factor}`).join(',')
}

async function prepareRenderedImage(
  overlay: Pick<Overlay, 'id' | 'name'>,
  dataUrl: string | undefined,
  directory: string
): Promise<string> {
  if (!dataUrl?.startsWith('data:image/png;base64,')) {
    throw new Error(`Overlay “${overlay.name}” was not rendered before export`)
  }
  const path = join(directory, `${overlay.id}.png`)
  const encoded = dataUrl.slice('data:image/png;base64,'.length)
  await writeFile(path, Buffer.from(encoded, 'base64'))
  return path
}

async function prepareVisualPath(overlay: Overlay, directory: string): Promise<string> {
  if (overlay.type === 'text') return prepareRenderedImage(overlay, overlay.renderedTextBitmap?.dataUrl, directory)
  if (overlay.type === 'audio') throw new Error('Audio overlays do not have a visual path')
  if (extname(overlay.path).toLowerCase() !== '.svg') return overlay.path
  return prepareRenderedImage(
    overlay,
    overlay.type === 'image' ? overlay.renderedImageDataUrl : undefined,
    directory
  )
}

function visualGeometry(overlay: VisualOverlayBase, width: number, height: number): {
  width: number
  height: number
  x: number
  y: number
} {
  return {
    width: Math.max(2, Math.round(width * overlay.width / 2) * 2),
    height: Math.max(2, Math.round(height * overlay.height / 2) * 2),
    x: Math.round(width * overlay.x),
    y: Math.round(height * overlay.y)
  }
}

export function buildFilterGraph(request: ExportRequest, inputs: PreparedInput[]): {
  graph: string
  videoLabel: string
  audioLabel: string
} {
  const filters: string[] = []
  const { videoSegments, audioSegments } = addSegmentFilters(filters, request)
  addBaseFilters(filters, videoSegments, audioSegments, request)
  const cameraLabel = addFocusZoomFilters(filters, request)
  const transitionedLabel = addVideoRangeTransitionFilters(filters, request, cameraLabel)
  const videoLabel = addVisualFilters(filters, inputs, request, transitionedLabel)
  const duration = timelineDuration(request.segments)
  addAudioOverlayFilters(filters, inputs, duration)
  return { graph: filters.join(';'), videoLabel, audioLabel: 'aout' }
}

function addFocusZoomFilters(filters: string[], request: ExportRequest): string {
  const expression = focusZoomExpression(request)
  if (!expression) return 'basev'
  const { width, height, fps } = request.canvas
  filters.push(`[basev]zoompan=z='${expression.zoom}':x='${expression.x}':y='${expression.y}':d=1:s=${width}x${height}:fps=${fps}[camera]`)
  return 'camera'
}

function addSegmentFilters(filters: string[], request: ExportRequest): {
  videoSegments: string[]
  audioSegments: string[]
} {
  const videoSegments: string[] = []
  const audioSegments: string[] = []
  request.segments.forEach((segment, index) => addSegmentFilter(filters, request, segment, index, videoSegments, audioSegments))
  return { videoSegments, audioSegments }
}

function addSegmentFilter(filters: string[], request: ExportRequest, segment: SourceSegment, index: number, videoSegments: string[], audioSegments: string[]): void {
    const { inputIndex, source } = exportSegmentSource(request, segment)
    const playbackRate = segmentPlaybackRate(segment)
    const segmentDuration = segmentOutputDuration(segment)
    // Continue source footage beneath the next clip; only pad if its source ends.
    // The extra video is consumed by xfade, so audio and timeline length stay unchanged.
    const next = request.segments[index + 1]
    const handle = next?.kind !== 'freeze' ? next?.transition?.duration ?? 0 : 0
    const videoDuration = segmentDuration + handle
    const { fps } = request.canvas
    const scaleAndCrop = exportScaleAndCrop(request)
    if (segment.kind === 'freeze') {
      // Scale the still once before cloning it; tpad needs a known frame rate.
      filters.push(`[${inputIndex}:v:0]trim=start=${seconds(segment.sourceTime)},setpts=PTS-STARTPTS,select='eq(n,0)',${scaleAndCrop},setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${seconds(videoDuration)},trim=duration=${seconds(videoDuration)},settb=AVTB,format=yuv420p[vseg${index}]`)
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${seconds(segment.duration)}[aseg${index}]`)
      videoSegments.push(`[vseg${index}]`)
      audioSegments.push(`[aseg${index}]`)
      return
    }
    filters.push(
      `[${inputIndex}:v:0]trim=start=${seconds(segment.sourceStart)}:end=${seconds(segment.sourceEnd + handle * playbackRate)},` +
      `setpts=(PTS-STARTPTS)/${playbackRate},${scaleAndCrop},setsar=1,fps=${fps},` +
      (handle > 0 ? `tpad=stop_mode=clone:stop_duration=${seconds(handle)},trim=duration=${seconds(videoDuration)},` : '') +
      `settb=AVTB,format=yuv420p[vseg${index}]`
    )
    videoSegments.push(`[vseg${index}]`)
    const fadeIn = index > 0
    const fadeOut = Boolean(next)
    const deClick = Math.min(0.01, segmentDuration / 2)
    const deClickFilters = deClick > 0
      ? (fadeIn ? `,afade=t=in:st=0:d=${seconds(deClick)}` : '') +
        (fadeOut ? `,afade=t=out:st=${seconds(segmentDuration - deClick)}:d=${seconds(deClick)}` : '')
      : ''
    if (source.hasAudio) {
      filters.push(
        `[${inputIndex}:a:0]atrim=start=${seconds(segment.sourceStart)}:end=${seconds(segment.sourceEnd)},` +
        `asetpts=PTS-STARTPTS,${audioTempoFilter(playbackRate)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo` +
        `${deClickFilters}[aseg${index}]`
      )
    } else {
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${seconds(segmentDuration)}[aseg${index}]`)
    }
    audioSegments.push(`[aseg${index}]`)
}

function exportSegmentSource(request: ExportRequest, segment: SourceSegment): { inputIndex: number; source: ExportRequest['sources'][number]['metadata'] } {
  const inputIndex = request.sources.findIndex((source) => source.id === segment.sourceId)
  const source = request.sources[inputIndex]?.metadata
  if (inputIndex < 0 || !source) throw new Error('A timeline video source is missing')
  return { inputIndex, source }
}

function exportScaleAndCrop(request: ExportRequest): string {
  const { width, height, fit } = request.canvas
  return fit === 'cover'
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
}

function addBaseFilters(
  filters: string[],
  videoSegments: string[],
  audioSegments: string[],
  request: ExportRequest
): void {
  addVideoBaseFilters(filters, videoSegments, request)
  if (request.segments.length === 1) {
    filters.push(`${audioSegments[0]}anull[basea]`)
  } else {
    filters.push(`${audioSegments.join('')}concat=n=${request.segments.length}:v=0:a=1[basea]`)
  }
}

function addVideoBaseFilters(
  filters: string[],
  videoSegments: string[],
  request: ExportRequest
): void {
  let currentLabel = required(videoSegments[0], 'The timeline is empty')
  const firstSegment = required(request.segments[0], 'The timeline is empty')
  let outputDuration = segmentOutputDuration(firstSegment)

  for (let index = 1; index < request.segments.length; index += 1) {
    const segment = required(request.segments[index], 'A timeline video segment is missing')
    const nextLabel = required(videoSegments[index], 'A timeline video segment is missing')
    const joinedLabel = `[vjoin${index}]`
    if (segment.kind !== 'freeze' && segment.transition) {
      filters.push(
        `${currentLabel}${nextLabel}xfade=transition=${segment.transition.effect}:` +
        `duration=${seconds(segment.transition.duration)}:offset=${seconds(outputDuration)}${joinedLabel}`
      )
    } else {
      filters.push(`${currentLabel}${nextLabel}concat=n=2:v=1:a=0${joinedLabel}`)
    }
    currentLabel = joinedLabel
    outputDuration += segmentOutputDuration(segment)
  }
  filters.push(`${currentLabel}null[basev]`)
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}

function visualFilter(
  filters: string[],
  overlay: Exclude<Overlay, { type: 'audio' }>,
  index: number,
  order: number,
  inputLabel: string,
  request: ExportRequest
): string {
  const outputLabel = `vout${order}`
  if (overlay.type === 'text') {
    return addTextOverlayFilters(filters, overlay, index, order, inputLabel, request.canvas)
  }
  const { canvas } = request
  const geometry = visualGeometry(overlay, canvas.width, canvas.height)
  const fullScreen = fillsFrame(overlay)
  const scale = overlayFit(overlay, canvas) === 'cover'
    ? `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height},format=rgba,setsar=1`
    : visualScale(fullScreen, geometry, canvas)
  const bounds = fullScreen ? { x: 0, y: 0, width: canvas.width, height: canvas.height } : geometry
  const animation = visualAnimationFilter(overlay, bounds, order)
  const trim = 'sourceIn' in overlay
    ? `trim=start=${seconds(overlay.sourceIn)}:end=${seconds(overlay.sourceIn + overlay.duration)}`
    : `trim=duration=${seconds(overlay.duration)}`
  // Coarse source timebases otherwise round fractional starts and drop the last overlay frame.
  // Hold the decoded final frame until the overlay's exclusive timeline end, not decoder EOF.
  filters.push(
    `[${index}:v:0]${trim},settb=AVTB,setpts=PTS-STARTPTS+${seconds(overlay.start)}/TB,` +
    `${scale},${animation.filter}[ov${order}]`,
    `[${inputLabel}][ov${order}]overlay=${animation.position}:` +
    `eof_action=repeat:repeatlast=1:enable='gte(t,${seconds(overlay.start)})*lt(t,${seconds(overlay.start + overlay.duration)})'` +
    `[${outputLabel}]`
  )
  return outputLabel
}

function visualAnimationFilter(
  overlay: Exclude<Overlay, { type: 'audio' | 'text' }>,
  bounds: { x: number; y: number; width: number; height: number },
  order: number
): { filter: string; position: string } {
  const unchanged = { filter: `colorchannelmixer=aa=${overlay.opacity}`, position: `x=${bounds.x}:y=${bounds.y}` }
  if (overlay.type === 'gif') return unchanged
  if (!overlay.animation || overlay.animation === 'none') return unchanged
  // Crop/fit first, then animate around the same center as the preview's content transform.
  const timing = { duration: overlay.animationDuration, fadeIn: overlay.animationFadeIn, fadeOut: overlay.animationFadeOut }
  const frame = textAnimationFilterExpressions(overlay.animation, overlay.duration, `(t-${seconds(overlay.start)})`, timing)
  const alpha = textAnimationFilterExpressions(overlay.animation, overlay.duration, `(T-${seconds(overlay.start)})`, timing)
  // Apply alpha at a fixed size; converting formats after a dynamic resize can crash or pin its initial size.
  const resize = frame.scale === '1' ? '' : `,scale=w='max(2,2*round(iw*(${frame.scale})/2))':h='max(2,2*round(ih*(${frame.scale})/2))':eval=frame`
  return {
    filter: `${frameAlphaFilter(`visualalpha${order}`, overlay.opacity, alpha.opacity)}${resize}`,
    position: `x='${bounds.x}+${bounds.width}/2-overlay_w/2+(${frame.x})*${bounds.width}':y='${bounds.y}+${bounds.height}/2-overlay_h/2+(${frame.y})*${bounds.height}':eval=frame`
  }
}

function fillsFrame(overlay: VisualOverlayBase): boolean {
  return overlay.width >= 0.999 && overlay.height >= 0.999
}

function visualScale(fullScreen: boolean, geometry: { width: number; height: number }, canvas: { width: number; height: number }): string {
  const { width, height } = fullScreen ? canvas : geometry
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `format=rgba,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`
}

function addVisualFilters(filters: string[], inputs: PreparedInput[], request: ExportRequest, inputLabel = 'basev'): string {
  let videoLabel = inputLabel
  const visualInputs = inputs
    .filter(({ overlay }) => overlay.type !== 'audio')
    .sort((left, right) => left.overlay.zIndex - right.overlay.zIndex)
  visualInputs.forEach(({ overlay, index }, order) => {
    if (overlay.type === 'audio') return
    videoLabel = visualFilter(filters, overlay, index, order, videoLabel, request)
  })
  return videoLabel
}

export async function exportVideo(request: ExportRequest, range?: PreviewRange): Promise<void> {
  if (request.segments.length === 0) throw new Error('The timeline is empty')
  await mkdir(dirname(request.outputPath), { recursive: true })
  await ensureDiskSpace(request)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'otc-export-'))
  const temporaryOutput = join(dirname(request.outputPath), `.${randomUUID()}.otc.mp4`)
  const duration = range ? range[1] - range[0] : timelineDuration(request.segments)
  const jobId = randomUUID()

  try {
    const reused = range ? false : await tryReuseFacePreview(request, temporaryOutput, jobId, duration)
    if (!reused) {
      const workerRequest = clippedFaceRequest(request, range)
      if (workerRequest.faceBlurs?.length) await ensureFaceExportDiskSpace(request, temporaryDirectory)
      await encodeVideo(request, temporaryDirectory, temporaryOutput, duration, jobId, range)
    }
    await rename(temporaryOutput, request.outputPath)
  } catch (error) {
    await rm(temporaryOutput, { force: true })
    throw error
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('cancelled')
}

async function prepareInputs(request: ExportRequest, directory: string, range?: PreviewRange): Promise<{
  inputArgs: string[]
  preparedInputs: PreparedInput[]
  graphRequest: ExportRequest
  seek?: PreviewSeekPlan
}> {
  const inputArgs = ['-hide_banner', '-y']
  const { request: seekRequest, seek } = await preparePreviewSeek(request, range)
  const decodeDevice = await integratedDecodeDevice()
  const decoderInputArgs = decodeDevice ? ['-hwaccel', 'auto', '-hwaccel_device', decodeDevice] : []
  const graphRequest = prepareTimelineInputs(seekRequest, inputArgs, seek, decoderInputArgs)
  const preparedInputs: PreparedInput[] = []
  for (const [offset, overlay] of seekRequest.overlays.entries()) {
    inputArgs.push(...await overlayInputArgs(overlay, directory))
    preparedInputs.push({ overlay, index: offset + graphRequest.sources.length })
  }
  return { inputArgs, preparedInputs, graphRequest, seek }
}

function needsAudioValidation(overlay: Overlay): boolean {
  return overlay.type === 'video' && overlay.audioEnabled && !overlay.hasAudio
}

export function loopsInput(overlay: Overlay): boolean {
  return overlay.type === 'gif' || (overlay.type === 'video' && overlay.loop)
}

function stillInput(overlay: Overlay): boolean {
  return overlay.type === 'image' || overlay.type === 'text'
}

async function overlayInputArgs(overlay: Overlay, directory: string): Promise<string[]> {
  if (needsAudioValidation(overlay)) throw new Error(`Video clip has no audio stream: ${overlay.name}`)
  const path = overlay.type === 'audio' ? overlay.path : await prepareVisualPath(overlay, directory)
  const options: string[] = []
  if (stillInput(overlay)) options.push('-loop', '1')
  if (loopsInput(overlay)) options.push('-stream_loop', '-1')
  return [...options, '-threads', '2', '-i', path]
}

function encoderGraph(encoder: Encoder, softwareGraph: string, videoLabel: string): string {
  return encoder.filterSuffix
    ? `${softwareGraph};[${videoLabel}]${encoder.filterSuffix}`
    : softwareGraph
}

function canRetryEncoding(error: unknown, index: number, count: number): boolean {
  return !isCancellation(error) && index < count - 1
}

async function encodeVideo(
  request: ExportRequest,
  directory: string,
  output: string,
  duration: number,
  jobId: string,
  range?: PreviewRange
): Promise<void> {
  const { inputArgs, preparedInputs, graphRequest, seek } = await prepareInputs(request, directory, range)
  const filter = previewFilterGraph(applyPreviewSeek(buildFilterGraph(graphRequest, preparedInputs), seek), range)
  const workerRequest = clippedFaceRequest(request, range)
  if (workerRequest.faceBlurs?.length) {
    const faceContext = { sourceRequest: request, frameOffset: Math.round((range?.[0] ?? 0) * request.canvas.fps), preparationStart: seek?.offset ?? 0 }
    await encodeWithFaces(workerRequest, inputArgs, filter, directory, output, duration, jobId, faceContext)
    return
  }
  const restrictedNode = await restrictedIntelRenderNode()
  if (restrictedNode) {
    await ensureFaceExportDiskSpace(request, directory)
    try {
      await encodeWithPrivilegedGpu(request, inputArgs, filter, directory, output, duration, jobId, restrictedNode)
      return
    } catch (error) {
      if (isCancellation(error)) throw error
    }
    const encoder = softwareEncoder()
    const graph = encoderGraph(encoder, filter.graph, filter.videoLabel)
    await jobs.run(
      encoder.executable, encoderArgs(encoder, inputArgs, filter, graph, duration, output),
      'export', duration, jobId, 'GPU authorization or encoding unavailable; using CPU',
      { phase: 'encoding', hardwareLabel: 'CPU' }
    )
    return
  }
  const encoders = await exportEncoders()
  for (const [index, encoder] of encoders.entries()) {
    const graph = encoderGraph(encoder, filter.graph, filter.videoLabel)
    try {
      await jobs.run(
        encoder.executable, encoderArgs(encoder, inputArgs, filter, graph, duration, output),
        'export', duration, jobId, '',
        { phase: 'encoding', hardwareLabel: encoder.hardwareLabel }
      )
      return
    } catch (error) {
      if (!canRetryEncoding(error, index, encoders.length)) throw error
      // The probe cannot predict every real filter graph or driver failure.
      await rm(output, { force: true })
    }
  }
}

function encoderArgs(
  encoder: Encoder,
  inputArgs: string[],
  filter: ReturnType<typeof buildFilterGraph>,
  graph: string,
  duration: number,
  output: string
): string[] {
  return [
    ...encoder.input, ...inputArgs,
    '-filter_complex_threads', '4', '-filter_complex', graph,
    '-map', `[${encoder.videoLabel(filter.videoLabel)}]`, '-map', `[${filter.audioLabel}]`,
    '-t', seconds(duration), ...encoder.output,
    '-c:a', 'aac', '-b:a', '256k',
    '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', output
  ]
}
