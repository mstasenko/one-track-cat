import type {
  AssetItem,
  EditSession,
  FaceBlurSettings,
  FocusZoomAmount,
  FreezeDuration,
  GpuDiagnostics,
  InsertTransitions,
  JobProgress,
  Overlay,
  TextAnimationPreset,
  VideoSpeed,
  VideoTransition
} from '@shared/types'

export interface EditorState {
  initialized: boolean
  session: EditSession | null
  history: EditSession[]
  future: EditSession[]
  gesture: EditSession | null
  assets: AssetItem[]
  gpu: GpuDiagnostics | null
  job: JobProgress | null
  busy: string | null
  error: string | null
  initialize: () => Promise<void>
  loadVideo: (path?: string, short?: boolean) => Promise<void>
  openShort: () => Promise<void>
  insertVideo: (transitions?: InsertTransitions) => Promise<void>
  resetProject: () => Promise<void>
  setPlayhead: (time: number) => void
  addMark: () => void
  clearMarks: () => void
  removeMarked: () => void
  addText: () => void
  addAsset: (asset: AssetItem) => Promise<void>
  addExternalMedia: () => Promise<void>
  selectOverlay: (id: string | null) => void
  updateOverlay: (id: string, patch: Partial<Overlay>) => void
  beginOverlayGesture: () => void
  updateOverlayGesture: (id: string, patch: Partial<Overlay>) => void
  commitOverlayGesture: () => void
  cancelOverlayGesture: () => void
  removeSelectedOverlay: () => void
  setSpeed: (rate: VideoSpeed) => void
  addFocusZoom: (zoom: FocusZoomAmount, focusX: number, focusY: number) => void
  removeFocusZoom: () => void
  applyVideoTransition: (into?: VideoTransition, out?: VideoTransition) => void
  applyFaceBlur: (settings: FaceBlurSettings) => void
  updateFaceBlurSettings: (id: string, settings: FaceBlurSettings) => void
  removeFaceBlur: (id: string) => void
  insertFreeze: (duration: FreezeDuration) => void
  removeFreeze: () => void
  insertReplay: () => void
  removeReplay: () => void
  setTextAnimation: (id: string, preset: TextAnimationPreset) => void
  undo: () => void
  redo: () => void
  setJob: (progress: JobProgress) => void
  showError: (message: string) => void
  clearError: () => void
}
