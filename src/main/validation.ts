import { basename } from 'node:path'
import {
  audioFadeDurations,
  faceBlurMaxEffects,
  focusZoomAmounts,
  gameAudioLevels,
  mediaAnimationPresets,
  textAnimationPresets,
  transitionEffects,
  videoRangeTransitionEffects,
  videoSpeeds
} from '../types'
import type {
  ExportRequest,
  ExportSource,
  FaceBlurEffect,
  FocusZoomEffect,
  MediaMetadata,
  Overlay,
  ProjectCanvas,
  SavedSession,
  SavedSessionSnapshot,
  SourceSegment,
  VideoSpeed,
  VideoTransition,
  VideoRangeTransition
} from '../types'
import { timelineDuration } from '../segment-time'
import { fitVideoRangeTransition } from '../video-range-transition'

type UnknownRecord = Record<string, unknown>

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as UnknownRecord
}

function text(value: unknown, label: string, maximumLength = 4096): string {
  if (typeof value !== 'string' || !value || value.length > maximumLength) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function identifier(value: unknown, label: string): string {
  const id = text(value, label, 128)
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`${label} contains unsafe characters`)
  return id
}

function number(value: unknown, label: string, minimum = 0, maximum = 1e9): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside its allowed range`)
  }
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`)
  return value
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label} is not supported`)
  return value as T
}

function validateUniqueIds(items: readonly { id: string }[], label: string): void {
  const ids = new Set(items.map((item) => item.id))
  if (ids.size !== items.length) throw new Error(`${label} IDs must be unique`)
}

function optionalNumberPreset(value: unknown, values: readonly number[], label: string): void {
  if (value !== undefined && (typeof value !== 'number' || !values.includes(value))) {
    throw new Error(`${label} is not supported`)
  }
}

function optionalNumberRange(value: unknown, label: string, minimum: number, maximum: number): void {
  if (value !== undefined) number(value, label, minimum, maximum)
}

export function parsePath(value: unknown): string {
  return text(value, 'Path')
}

export function parseJobId(value: unknown): string {
  return text(value, 'Job ID', 128)
}

export function parseDefaultName(value: unknown): string {
  const name = text(value, 'Export name', 255)
  if (basename(name) !== name || !name.toLowerCase().endsWith('.mp4')) {
    throw new Error('Export name must be an MP4 filename')
  }
  return name
}

export function parseMediaMetadata(value: unknown): MediaMetadata {
  const input = record(value, 'Media metadata')
  return {
    path: parsePath(input.path),
    name: text(input.name, 'Media name', 1024),
    size: number(input.size, 'Media size', 0, Number.MAX_SAFE_INTEGER),
    modifiedAt: number(input.modifiedAt, 'Modification time', 0, 1e14),
    duration: number(input.duration, 'Media duration', 0.001, 1e8),
    width: number(input.width, 'Media width', 1, 100_000),
    height: number(input.height, 'Media height', 1, 100_000),
    fps: number(input.fps, 'Frame rate', 0, 1000),
    videoCodec: text(input.videoCodec, 'Video codec', 128),
    hasAudio: boolean(input.hasAudio, 'Audio presence')
  }
}

function parseProjectCanvas(value: unknown): ProjectCanvas {
  const input = record(value, 'Project canvas')
  return {
    width: number(input.width, 'Canvas width', 2, 100_000),
    height: number(input.height, 'Canvas height', 2, 100_000),
    fps: number(input.fps, 'Canvas frame rate', 1, 1000),
    fit: oneOf(input.fit, ['contain', 'cover'] as const, 'Canvas fit')
  }
}

function parseExportSource(value: unknown): ExportSource {
  const input = record(value, 'Video source')
  return {
    id: identifier(input.id, 'Source ID'),
    metadata: parseMediaMetadata(input.metadata)
  }
}

function parsePlaybackRate(value: unknown): VideoSpeed {
  if (typeof value !== 'number' || !videoSpeeds.includes(value as typeof videoSpeeds[number])) {
    throw new Error('Segment playback rate is unsupported')
  }
  return value as VideoSpeed
}

function parseSegmentSource(input: UnknownRecord, sources: Map<string, MediaMetadata>): { sourceId: string; source: MediaMetadata } {
  const sourceId = identifier(input.sourceId, 'Segment source ID')
  const source = sources.get(sourceId)
  if (!source) throw new Error('Timeline segment refers to an unknown video source')
  return { sourceId, source }
}

function parseSegmentBounds(input: UnknownRecord, sourceDuration: number): { sourceStart: number; sourceEnd: number } {
  const sourceStart = number(input.sourceStart, 'Segment start', 0, sourceDuration)
  const sourceEnd = number(input.sourceEnd, 'Segment end', 0, sourceDuration)
  if (sourceEnd <= sourceStart) throw new Error('Timeline segments must have positive duration')
  return { sourceStart, sourceEnd }
}

function parseSegment(value: unknown, sources: Map<string, MediaMetadata>): SourceSegment {
  const input = record(value, 'Timeline segment')
  const { sourceId, source } = parseSegmentSource(input, sources)
  if (input.kind === 'freeze') {
    const sourceTime = number(input.sourceTime, 'Freeze source time', 0, source.duration)
    const duration = number(input.duration, 'Freeze duration', 0.001, 5)
    return { kind: 'freeze', id: identifier(input.id, 'Segment ID'), sourceId, sourceTime, duration, ...parseReplayGroup(input) }
  }
  if (input.kind !== undefined && input.kind !== 'video') throw new Error('Segment kind is unsupported')
  return parseVideoSegment(input, sourceId, source)
}

function parseReplayGroup(input: UnknownRecord): { replayGroupId?: string } {
  return input.replayGroupId === undefined
    ? {}
    : { replayGroupId: identifier(input.replayGroupId, 'Replay group ID') }
}

function parseVideoSegment(input: UnknownRecord, sourceId: string, source: MediaMetadata): SourceSegment {
  const { sourceStart, sourceEnd } = parseSegmentBounds(input, source.duration)
  const playbackRate = input.playbackRate === undefined ? undefined : parsePlaybackRate(input.playbackRate)
  const transition = parseTransition(input.transition, (sourceEnd - sourceStart) / (playbackRate ?? 1))
  return {
    id: identifier(input.id, 'Segment ID'),
    sourceId,
    sourceStart,
    sourceEnd,
    ...(playbackRate === undefined ? {} : { playbackRate }),
    ...(transition ? { transition } : {}),
    ...parseReplayGroup(input)
  }
}

function parseTransition(value: unknown, segmentDuration: number): VideoTransition | undefined {
  if (value === undefined) return undefined
  const input = record(value, 'Segment transition')
  return {
    effect: oneOf(input.effect, transitionEffects, 'Transition effect'),
    duration: number(input.duration, 'Transition duration', 0.05, Math.min(5, segmentDuration))
  }
}

function validateOverlayBase(input: UnknownRecord, timelineDuration: number): void {
  identifier(input.id, 'Overlay ID')
  text(input.name, 'Overlay name', 1024)
  number(input.start, 'Overlay start', 0, timelineDuration)
  number(input.duration, 'Overlay duration', 0.001, 1e8)
  number(input.zIndex, 'Overlay order', 0, 1e6)
}

function validateVisual(input: UnknownRecord): void {
  const x = number(input.x, 'Overlay x', 0, 1)
  const y = number(input.y, 'Overlay y', 0, 1)
  const width = number(input.width, 'Overlay width', 0.001, 1)
  const height = number(input.height, 'Overlay height', 0.001, 1)
  if (x + width > 1.001 || y + height > 1.001) throw new Error('Overlay geometry is outside the frame')
  number(input.opacity, 'Overlay opacity', 0, 1)
}

function validateTextOverlay(input: UnknownRecord, canvas: ProjectCanvas): void {
  if (typeof input.text !== 'string' || input.text.length > 100_000) {
    throw new Error('Text content must be a string of at most 100000 characters')
  }
  text(input.fontFamily, 'Font family', 256)
  number(input.fontSize, 'Font size', 0.1, 1000)
  text(input.color, 'Text color', 64)
  text(input.outlineColor, 'Outline color', 64)
  number(input.outlineWidth, 'Outline width', 0, 100)
  boolean(input.shadow, 'Text shadow')
  oneOf(input.align, ['left', 'center', 'right'] as const, 'Text alignment')
  if (input.animation !== undefined) oneOf(input.animation, textAnimationPresets, 'Text animation')
  validateAnimationTiming(input)
  validateRenderedTextBitmap(input, canvas)
}

function validateRenderedTextBitmap(input: UnknownRecord, canvas: ProjectCanvas): void {
  if (input.renderedTextBitmap === undefined) return
  const bitmap = record(input.renderedTextBitmap, 'Rendered text bitmap')
  const dataUrl = text(bitmap.dataUrl, 'Rendered text bitmap image', 128 * 1024 * 1024)
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Rendered text bitmap must be a PNG image')
  number(bitmap.x, 'Rendered text x', -canvas.width * 2, canvas.width * 2)
  number(bitmap.y, 'Rendered text y', -canvas.height * 2, canvas.height * 2)
  number(bitmap.anchorX, 'Rendered text anchor x', 0, canvas.width)
  number(bitmap.anchorY, 'Rendered text anchor y', 0, canvas.height)
}

function validateRenderedImage(input: UnknownRecord): void {
  if (input.renderedImageDataUrl === undefined) return
  const rendered = text(input.renderedImageDataUrl, 'Rendered image', 128 * 1024 * 1024)
  if (!rendered.startsWith('data:image/png;base64,')) throw new Error('Rendered content must be a PNG image')
}

function validateImageOverlay(input: UnknownRecord): void {
  validateVisual(input)
  parsePath(input.path)
  validateMediaAnimation(input)
  validateRenderedImage(input)
}

function validateTimedVisualOverlay(input: UnknownRecord): void {
  validateVisual(input)
  parsePath(input.path)
  number(input.sourceIn, 'Source start', 0, 1e8)
  number(input.sourceDuration, 'Source duration', 0.001, 1e8)
}

function validateVideoOverlay(input: UnknownRecord): void {
  validateTimedVisualOverlay(input)
  validateMediaAnimation(input)
  boolean(input.loop, 'Media loop')
  const audioEnabled = boolean(input.audioEnabled, 'Video audio')
  const hasAudio = boolean(input.hasAudio, 'Video audio stream')
  if (audioEnabled && !hasAudio) throw new Error('Video requests audio but has no audio stream')
  number(input.volume, 'Video volume', 0, 2)
  validateAudioSettings(input)
}

function validateMediaAnimation(input: UnknownRecord): void {
  if (input.animation !== undefined) oneOf(input.animation, mediaAnimationPresets, 'Media animation')
  validateAnimationTiming(input)
}

function validateAnimationTiming(input: UnknownRecord): void {
  optionalNumberRange(input.animationDuration, 'Animation duration', 0, 5)
  optionalNumberRange(input.animationFadeIn, 'Animation fade in', 0, 5)
  optionalNumberRange(input.animationFadeOut, 'Animation fade out', 0, 5)
}

function validateAudioOverlay(input: UnknownRecord): void {
  parsePath(input.path)
  number(input.sourceIn, 'Source start', 0, 1e8)
  number(input.volume, 'Audio volume', 0, 2)
  validateAudioSettings(input)
}

function validateAudioSettings(input: UnknownRecord): void {
  optionalNumberPreset(input.fadeIn, audioFadeDurations, 'Fade in')
  optionalNumberPreset(input.fadeOut, audioFadeDurations, 'Fade out')
  if (input.duckGameAudio !== undefined) boolean(input.duckGameAudio, 'Lower game sound')
  optionalNumberPreset(input.gameAudioLevel, gameAudioLevels, 'Game audio level')
}

function parseFaceBlurs(value: unknown, duration: number): FaceBlurEffect[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > faceBlurMaxEffects) throw new Error(`Face blur effects must be an array with at most ${faceBlurMaxEffects} entries`)
  const output = value.map((item) => {
    const input = record(item, 'Face blur effect')
    const start = number(input.start, 'Face blur start', 0, duration)
    // Keep this aligned with the model's range epsilon so split coverage from
    // speed/replay edits remains serializable instead of failing on save.
    const effectDuration = number(input.duration, 'Face blur duration', 0.0001, duration)
    if (start + effectDuration > duration + 0.0001) throw new Error('Face blur extends past the timeline')
    return {
      id: identifier(input.id, 'Face blur ID'),
      start,
      duration: effectDuration,
      sensitivity: number(input.sensitivity, 'Face blur sensitivity', 0, 1),
      detail: oneOf(input.detail, ['standard', 'small'] as const, 'Face blur detail'),
      holdSeconds: number(input.holdSeconds, 'Face blur hold seconds', 0, 1),
      strength: number(input.strength, 'Face blur strength', 0, 1),
      style: oneOf(input.style, ['pixelate', 'blur', 'mask'] as const, 'Face blur style')
    }
  })
  validateUniqueIds(output, 'Face blur')
  const sorted = [...output].sort((left, right) => left.start - right.start)
  if (sorted.some((item, index) => index > 0 && item.start < (sorted[index - 1]?.start ?? 0) + (sorted[index - 1]?.duration ?? 0) - 0.0001)) {
    throw new Error('Face blur effects cannot overlap')
  }
  return sorted
}

function validateOverlay(value: unknown, timelineDuration: number, canvas: ProjectCanvas): Overlay {
  const input = record(value, 'Overlay')
  const type = oneOf(input.type, ['text', 'image', 'gif', 'video', 'audio'] as const, 'Overlay type')
  validateOverlayBase(input, timelineDuration)
  switch (type) {
    case 'text':
      validateVisual(input)
      validateTextOverlay(input, canvas)
      break
    case 'image':
      validateImageOverlay(input)
      break
    case 'gif':
      validateTimedVisualOverlay(input)
      break
    case 'video':
      validateVideoOverlay(input)
      break
    case 'audio':
      validateAudioOverlay(input)
  }
  return value as Overlay
}

export function parseExportRequest(value: unknown): ExportRequest {
  const input = record(value, 'Export request')
  const canvas = parseProjectCanvas(input.canvas)
  const sources = parseSources(input.sources)
  const sourcesById = new Map(sources.map((item) => [item.id, item.metadata]))
  const segments = parseSegments(input.segments, sourcesById)
  const duration = timelineDuration(segments)
  const overlays = parseOverlays(input.overlays, duration, canvas)
  const focusZooms = parseFocusZooms(input.focusZooms, duration)
  const faceBlurs = parseFaceBlurs(input.faceBlurs, duration)
  const videoTransitions = parseVideoRangeTransitions(input.videoTransitions, duration)
  return {
    canvas,
    sources,
    outputPath: parsePath(input.outputPath),
    segments,
    overlays,
    ...(input.focusZooms === undefined ? {} : { focusZooms }),
    ...(input.faceBlurs === undefined ? {} : { faceBlurs }),
    ...(input.videoTransitions === undefined ? {} : { videoTransitions })
  }
}

function parseVideoRangeTransitions(value: unknown, timelineDuration: number): VideoRangeTransition[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Video transitions must be an array')
  const output = value.map((item) => {
    const input = record(item, 'Video transition')
    const start = number(input.start, 'Video transition start', 0, timelineDuration)
    const duration = number(input.duration, 'Video transition duration', 0.000001, timelineDuration)
    if (start + duration > timelineDuration + 0.0001) throw new Error('Video transition extends past the timeline')
    const edge = (value: unknown): VideoTransition | undefined => {
      if (value === undefined) return undefined
      const transition = record(value, 'Video transition')
      return {
        effect: oneOf(transition.effect, videoRangeTransitionEffects, 'Video transition effect'),
        duration: number(transition.duration, 'Video transition duration', 0.000001)
      }
    }
    const into = edge(input.into)
    const out = edge(input.out)
    if (!into && !out) throw new Error('Video transition needs a start or end effect')
    return fitVideoRangeTransition({ id: identifier(input.id, 'Video transition ID'), start, duration, ...(into ? { into } : {}), ...(out ? { out } : {}) })
  })
  validateUniqueIds(output, 'Video transition')
  return output
}

function parseFocusZooms(value: unknown, duration: number): FocusZoomEffect[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Focus zooms must be an array')
  const output = value.map((item) => {
    const input = record(item, 'Focus zoom')
    const start = number(input.start, 'Focus zoom start', 0, duration)
    const effectDuration = number(input.duration, 'Focus zoom duration', 0.001, duration)
    if (start + effectDuration > duration + 0.0001) throw new Error('Focus zoom extends past the timeline')
    if (typeof input.zoom !== 'number' || !focusZoomAmounts.includes(input.zoom as typeof focusZoomAmounts[number])) throw new Error('Focus zoom amount is unsupported')
    return { id: identifier(input.id, 'Focus zoom ID'), start, duration: effectDuration, zoom: input.zoom as FocusZoomEffect['zoom'], focusX: number(input.focusX, 'Focus x', 0, 1), focusY: number(input.focusY, 'Focus y', 0, 1) }
  })
  validateUniqueIds(output, 'Focus zoom')
  const sorted = [...output].sort((left, right) => left.start - right.start)
  if (sorted.some((item, index) => index > 0 && item.start < (sorted[index - 1]?.start ?? 0) + (sorted[index - 1]?.duration ?? 0))) throw new Error('Focus zoom effects cannot overlap')
  return sorted
}

function parseSources(value: unknown): ExportSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new Error('Video sources must be a non-empty array')
  }
  const sources = value.map(parseExportSource)
  validateUniqueIds(sources, 'Video source')
  return sources
}

function parseSegments(value: unknown, sources: Map<string, MediaMetadata>): SourceSegment[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error('Timeline segments must be an array')
  }
  const segments = value.map((segment) => parseSegment(segment, sources))
  validateUniqueIds(segments, 'Timeline segment')
  if (segments[0]?.kind !== 'freeze' && segments[0]?.transition) throw new Error('The first timeline segment cannot have a transition')
  return segments
}

function parseOverlays(value: unknown, duration: number, canvas: ProjectCanvas): Overlay[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error('Overlays must be an array')
  }
  const overlays = value.map((overlay) => validateOverlay(overlay, duration, canvas))
  validateUniqueIds(overlays, 'Overlay')
  return overlays
}

function parseSelectedOverlayId(value: unknown): string | null {
  return value === null ? null : identifier(value, 'Selected overlay ID')
}

function parseMarks(value: unknown, duration: number): number[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Marks must be an array')
  return value.map((mark) => number(mark, 'Mark', 0, duration))
}

function parseSavedSessionSnapshot(value: unknown): SavedSessionSnapshot {
  const input = record(value, 'Saved session snapshot')
  const timeline = parseExportRequest({ ...input, outputPath: '/saved-session.mp4' })
  const duration = timelineDuration(timeline.segments)
  const selectedOverlayId = parseSelectedOverlayId(input.selectedOverlayId)
  // Legacy saved sessions used cutPoints; an explicit marks field must win so malformed current data cannot fall back.
  const marksInput = Object.prototype.hasOwnProperty.call(input, 'marks') ? input.marks : input.cutPoints
  const marks = parseMarks(marksInput, duration)
  const faceBlurs = timeline.faceBlurs
  const videoTransitions = timeline.videoTransitions
  return {
    canvas: timeline.canvas,
    sources: timeline.sources,
    segments: timeline.segments,
    overlays: timeline.overlays,
    selectedOverlayId,
    playhead: number(input.playhead, 'Playhead', 0, duration),
    marks,
    ...(input.focusZooms === undefined ? {} : { focusZooms: timeline.focusZooms ?? [] }),
    ...(input.faceBlurs === undefined ? {} : { faceBlurs: faceBlurs ?? [] }),
    ...(input.videoTransitions === undefined ? {} : { videoTransitions: videoTransitions ?? [] })
  }
}

function parseSessionStack(value: unknown, label: string): SavedSessionSnapshot[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(`${label} must be an array with at most 50 entries`)
  }
  return value.map(parseSavedSessionSnapshot)
}

export function parseSavedSession(value: unknown): SavedSession {
  const input = record(value, 'Saved session')
  const session = parseSavedSessionSnapshot(input)
  return {
    ...session,
    ...(input.history === undefined ? {} : { history: parseSessionStack(input.history, 'Undo history') }),
    ...(input.future === undefined ? {} : { future: parseSessionStack(input.future, 'Redo history') })
  }
}
