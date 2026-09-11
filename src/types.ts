import type { VideoDirectory } from './video-picker'
import type { OnlineTemplate, TemplateCategory, TemplateSource } from './online-templates'

export interface MediaMetadata {
  path: string
  name: string
  size: number
  modifiedAt: number
  duration: number
  width: number
  height: number
  fps: number
  videoCodec: string
  hasAudio: boolean
}

export interface AssetMetadata {
  duration: number
  hasAudio: boolean
  playbackPath?: string
}

export const transitionEffects = [
  'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft',
  'slideright', 'circleopen', 'zoomin', 'hblur'
] as const

export type TransitionEffect = typeof transitionEffects[number]

export interface VideoTransition {
  effect: TransitionEffect
  duration: number
}

export const videoSpeeds = [0.25, 0.5, 1, 2, 4] as const
export const focusZoomAmounts = [1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
export const freezeDurations = [0.5, 1, 2, 3, 4, 5] as const
export const textAnimationPresets = ['none', 'pop', 'fade', 'bounce', 'shake'] as const
export const mediaAnimationPresets = textAnimationPresets
export const audioFadeDurations = [0, 0.1, 0.25, 0.5, 1] as const
export const gameAudioLevels = [0.5, 0.3, 0.15] as const
export type VideoSpeed = typeof videoSpeeds[number]
export type FocusZoomAmount = typeof focusZoomAmounts[number]
export type FreezeDuration = typeof freezeDurations[number]
export type TextAnimationPreset = typeof textAnimationPresets[number]
export type MediaAnimationPreset = TextAnimationPreset
export type AudioFadeDuration = typeof audioFadeDurations[number]
export type GameAudioLevel = typeof gameAudioLevels[number]

export interface AnimationTiming {
  duration?: number
  fadeIn?: number
  fadeOut?: number
}

export interface FocusZoomEffect {
  id: string
  start: number
  duration: number
  zoom: FocusZoomAmount
  focusX: number
  focusY: number
}

export type FaceBlurDetail = 'standard' | 'small'
export type FaceBlurStyle = 'pixelate' | 'blur' | 'mask'
export const faceBlurMaxEffects = 100

export interface FaceBlurEffect {
  id: string
  start: number
  duration: number
  sensitivity: number
  detail: FaceBlurDetail
  holdSeconds: number
  strength: number
  style: FaceBlurStyle
}

export type FaceBlurSettings = Omit<FaceBlurEffect, 'id' | 'start' | 'duration'>

export interface InsertTransitions {
  into?: VideoTransition
  back?: VideoTransition
}

export const videoRangeTransitionEffects = ['fade', 'dissolve', 'hblur'] as const
export type VideoRangeTransitionEffect = typeof videoRangeTransitionEffects[number]

export interface VideoRangeTransition {
  id: string
  start: number
  duration: number
  into?: VideoTransition
  out?: VideoTransition
}

export interface VideoSegment {
  kind?: 'video'
  id: string
  sourceId: string
  sourceStart: number
  sourceEnd: number
  /** Playback speed for this segment; omitted means normal speed. */
  playbackRate?: VideoSpeed
  /** Transition from the preceding segment into this segment. */
  transition?: VideoTransition
  /** Ordinary timeline segments copied by one Replay action share this ID. */
  replayGroupId?: string
}

interface FreezeSegment {
  kind: 'freeze'
  id: string
  sourceId: string
  sourceTime: number
  duration: number
  replayGroupId?: string
}

export type SourceSegment = VideoSegment | FreezeSegment

export interface ExportSource {
  id: string
  metadata: MediaMetadata
}

export interface TimelineSource extends ExportSource {
  playbackPath: string
  waveform: number[]
}

export interface ProjectCanvas {
  width: number
  height: number
  fps: number
  fit: 'contain' | 'cover'
}

interface OverlayBase {
  id: string
  name: string
  start: number
  duration: number
  zIndex: number
}

export interface VisualOverlayBase extends OverlayBase {
  x: number
  y: number
  width: number
  height: number
  opacity: number
}

export interface TextOverlay extends VisualOverlayBase {
  type: 'text'
  text: string
  fontFamily: string
  fontSize: number
  color: string
  outlineColor: string
  outlineWidth: number
  shadow: boolean
  align: 'left' | 'center' | 'right'
  animation?: TextAnimationPreset
  animationDuration?: number
  animationFadeIn?: number
  animationFadeOut?: number
  renderedTextBitmap?: RenderedTextBitmap
}

export interface RenderedTextBitmap {
  dataUrl: string
  x: number
  y: number
  anchorX: number
  anchorY: number
}

export interface ImageOverlay extends VisualOverlayBase {
  type: 'image'
  path: string
  animation?: MediaAnimationPreset
  animationDuration?: number
  animationFadeIn?: number
  animationFadeOut?: number
  renderedImageDataUrl?: string
}

interface GifOverlay extends VisualOverlayBase {
  type: 'gif'
  path: string
  playbackPath?: string
  sourceIn: number
  sourceDuration: number
}

interface AudioOverlaySettings {
  volume: number
  fadeIn?: AudioFadeDuration
  fadeOut?: AudioFadeDuration
  duckGameAudio?: boolean
  gameAudioLevel?: GameAudioLevel
}

interface VideoOverlay extends VisualOverlayBase, AudioOverlaySettings {
  type: 'video'
  path: string
  animation?: MediaAnimationPreset
  animationDuration?: number
  animationFadeIn?: number
  animationFadeOut?: number
  loop: boolean
  audioEnabled: boolean
  hasAudio: boolean
  sourceIn: number
  sourceDuration: number
}

interface AudioOverlay extends OverlayBase, AudioOverlaySettings {
  type: 'audio'
  path: string
  sourceIn: number
}

export type Overlay = TextOverlay | ImageOverlay | GifOverlay | VideoOverlay | AudioOverlay

export interface EditSession {
  canvas: ProjectCanvas
  sources: TimelineSource[]
  segments: SourceSegment[]
  overlays: Overlay[]
  selectedOverlayId: string | null
  playhead: number
  marks: number[]
  focusZooms: FocusZoomEffect[]
  faceBlurs?: FaceBlurEffect[]
  videoTransitions?: VideoRangeTransition[]
}

export interface ExportRequest {
  canvas: ProjectCanvas
  sources: ExportSource[]
  outputPath: string
  segments: SourceSegment[]
  overlays: Overlay[]
  focusZooms?: FocusZoomEffect[]
  faceBlurs?: FaceBlurEffect[]
  videoTransitions?: VideoRangeTransition[]
}

export interface FacePreviewRequest extends ExportRequest {
  previewRange?: [start: number, end: number]
}

export interface FacePreviewResult {
  url: string
  start: number
  end: number
}

export interface SavedSessionSnapshot {
  canvas: ProjectCanvas
  sources: ExportSource[]
  segments: SourceSegment[]
  overlays: Overlay[]
  selectedOverlayId: string | null
  playhead: number
  marks: number[]
  focusZooms?: FocusZoomEffect[]
  videoTransitions?: VideoRangeTransition[]
  faceBlurs?: FaceBlurEffect[]
}

export interface SavedSession extends SavedSessionSnapshot {
  history?: SavedSessionSnapshot[]
  future?: SavedSessionSnapshot[]
}

export type JobKind = 'proxy' | 'export'

export type JobPhase = 'queued' | 'starting' | 'preparing' | 'masking' | 'encoding' | 'finalizing' | 'complete'
export type HardwareLabel = 'CPU' | 'iGPU' | 'dGPU'

export interface JobProgress {
  id: string
  kind: JobKind
  state: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  progress: number
  message: string
  phase?: JobPhase
  etaSeconds?: number
  hardwareLabel?: HardwareLabel
  encodingHardwareLabel?: HardwareLabel
}

export interface AssetItem {
  type: Exclude<Overlay['type'], 'text'>
  name: string
  path: string
}

export interface GpuDiagnostics {
  hardwareAcceleration: boolean
  videoDecode: string
  gpuCompositing: string
}

export interface FacePackStatus {
  available: boolean
  message: string
}

export interface otcApi {
  openVideo: () => Promise<string | null>
  listVideoDirectory: (directory?: string) => Promise<VideoDirectory>
  authorizeVideo: (path: string) => Promise<string>
  searchTemplates: (source: TemplateSource, category: TemplateCategory, query: string) => Promise<OnlineTemplate[]>
  importTemplate: (source: TemplateSource, id: string) => Promise<AssetItem>
  openTemplatePage: (source: TemplateSource, id: string) => Promise<void>
  openMedia: () => Promise<AssetItem | null>
  probe: (path: string) => Promise<MediaMetadata>
  probeAsset: (path: string) => Promise<AssetMetadata>
  waveform: (path: string) => Promise<number[]>
  scanAssets: () => Promise<AssetItem[]>
  chooseExportPath: (defaultName: string) => Promise<string | null>
  exportVideo: (request: ExportRequest) => Promise<void>
  loadSession: () => Promise<SavedSession | null>
  saveSession: (session: SavedSession) => Promise<void>
  resetSession: () => Promise<void>
  cancelJob: (id: string) => Promise<boolean>
  getGpuDiagnostics: () => Promise<GpuDiagnostics>
  facePackStatus: () => Promise<FacePackStatus>
  previewFaces: (request: FacePreviewRequest) => Promise<string>
  restoreFacePreview: (request: ExportRequest) => Promise<FacePreviewResult[]>
  getPathUrl: (path: string) => Promise<string>
  getSvgDataUrl: (path: string) => Promise<string>
  getDroppedPath: (file: File) => Promise<string>
  onOpenPath: (callback: (path: string) => void) => () => void
  onResetProject: (callback: () => void) => () => void
  onJobProgress: (callback: (progress: JobProgress) => void) => () => void
  onSaveRequest: (callback: () => Promise<void>) => () => void
}
