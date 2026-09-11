import { create } from 'zustand'
import { faceBlurMaxEffects } from '@shared/types'
import type { FaceBlurSettings, Overlay, TimelineSource } from '@shared/types'
import type { EditorState } from './editor-state'
import {
  clamp,
  createSession,
  marksAfterRemoval,
  defaultTextOverlay,
  deletionRange,
  makeId,
  primarySource,
  removeOutputRange,
  timelineDuration,
  positionAtOutputTime,
  isFreezeSegment
} from './timeline'
import { insertSourceAtOutputTime } from './segment-ranges'
import { applySpeedToOutputRange } from './speed'
import { addFocusZoom, removeFocusZoomFromRange } from './focus-zoom'
import { insertFreezeFrame, removeFreezeFrame } from './freeze'
import { timedRangesAfterRemoval } from './timed-ranges'
import { insertReplay as insertReplayEdit, removeReplayAtPlayhead, replayEligibility } from './replay'
import { removeFaceBlurById, replaceFaceBlurRange, updateFaceBlurById } from './face-blur'
import { replaceVideoRangeTransition } from './video-range-transition'
import { chooseVideo } from './video-picker'
import {
  mutation,
  normalizeOverlay,
  patchedOverlaySession,
  queueSessionWrite,
  restoredEditorState
} from './store-session'

export const useEditorStore = create<EditorState>((set, get) => {
  let projectGeneration = 0

  const patchSource = (id: string, patch: Partial<TimelineSource>): void => set((state) => state.session ? {
    session: {
      ...state.session,
      sources: state.session.sources.map((source) => source.id === id ? { ...source, ...patch } : source)
    }
  } : state)

  const loadWaveform = (source: TimelineSource): void => {
    if (!source.metadata.hasAudio || source.waveform.length > 0) return
    void window.otc.waveform(source.metadata.path)
      .then((waveform) => patchSource(source.id, { waveform }))
      .catch(() => undefined)
  }

  return {
  initialized: false,
  session: null,
  history: [],
  future: [],
  gesture: null,
  assets: [],
  gpu: null,
  job: null,
  busy: null,
  error: null,

  async initialize() {
    if (get().initialized) return
    const generation = projectGeneration
    try {
      const [gpu, assets, saved] = await Promise.all([
        window.otc.getGpuDiagnostics(),
        window.otc.scanAssets(),
        window.otc.loadSession()
      ])
      const restored = saved ? await restoredEditorState(saved) : null
      const restoreProject = generation === projectGeneration
      set({
        gpu,
        assets,
        initialized: true,
        ...(restoreProject
          ? { session: restored?.session ?? null, history: restored?.history ?? [], future: restored?.future ?? [] }
          : {})
      })
      if (restoreProject) restored?.session.sources.forEach(loadWaveform)
    } catch {
      set({ initialized: true, error: 'OneTrackCat could not finish starting. Close it and try again.' })
    }
  },
  async loadVideo(providedPath, short = false) {
    let generation = projectGeneration
    try {
      const path = providedPath ?? await chooseVideo()
      if (!path) return
      generation = ++projectGeneration
      set({ busy: 'Opening video…', error: null })
      const [metadata, url] = await Promise.all([
        window.otc.probe(path),
        window.otc.getPathUrl(path)
      ])
      if (generation !== projectGeneration) return
      const session = createSession(metadata, short)
      const source = primarySource(session)
      source.playbackPath = url
      set({ session, history: [], future: [], gesture: null, busy: null })
      loadWaveform(source)
    } catch {
      if (generation === projectGeneration) {
        set({ busy: null, error: 'OneTrackCat could not open this video. Try another file.' })
      }
    }
  },
  async openShort() {
    await get().loadVideo(undefined, true)
  },
  async insertVideo(transitions = {}) {
    const generation = projectGeneration
    try {
      const path = await chooseVideo()
      if (!path || !get().session || generation !== projectGeneration) return
      set({ busy: 'Inserting video…', error: null })
      const [metadata, playbackPath] = await Promise.all([
        window.otc.probe(path),
        window.otc.getPathUrl(path)
      ])
      const sourceId = makeId('source')
      const source: TimelineSource = { id: sourceId, metadata, playbackPath, waveform: [] }
      if (generation !== projectGeneration) return
      set((state) => {
        if (!state.session) return { busy: null }
        return {
          ...mutation(state, (session) => insertSourceAtOutputTime(
            session,
            source,
            session.playhead,
            transitions
          )),
          busy: null
        }
      })
      loadWaveform(source)
    } catch {
      if (generation === projectGeneration) {
        set({ busy: null, error: 'OneTrackCat could not insert this video. Try another file.' })
      }
    }
  },
  async resetProject() {
    const generation = ++projectGeneration
    try {
      await queueSessionWrite(async () => {
        await window.otc.resetSession()
        if (generation === projectGeneration) {
          set({ session: null, history: [], future: [], gesture: null, job: null, busy: null, error: null })
        }
      })
    } catch {
      if (generation === projectGeneration) set({ error: 'OneTrackCat could not reset this project. Try again.' })
    }
  },
  setPlayhead(time) {
    set((state) => {
      if (!state.session) return state
      const duration = timelineDuration(state.session.segments)
      return { session: { ...state.session, playhead: clamp(time, 0, duration) } }
    })
  },
  addMark() {
    set((state) => {
      if (!state.session) return state
      const duration = timelineDuration(state.session.segments)
      const mark = state.session.playhead
      const duplicate = state.session.marks.some((existing) => Math.abs(existing - mark) <= 0.0001)
      if (duplicate || mark <= 0.0001 || mark >= duration - 0.0001) return state
      return mutation(state, (session) => ({
        ...session,
        marks: [...session.marks, mark].sort((left, right) => left - right)
      }))
    })
  },
  clearMarks() {
    set((state) => {
      if (!state.session) return state
      const range = deletionRange(state.session)
      if (!range) return state
      const marks = state.session.marks.filter((mark) =>
        Math.abs(mark - range[0]) > 0.0001 && Math.abs(mark - range[1]) > 0.0001
      )
      if (marks.length === state.session.marks.length) return state
      return mutation(state, (session) => ({ ...session, marks }))
    })
  },
  removeMarked() {
    set((state) => {
      if (!state.session) return state
      const range = deletionRange(state.session)
      if (!range) {
        const position = positionAtOutputTime(state.session.segments, state.session.playhead)
        return position && isFreezeSegment(position.segment)
          ? mutation(state, (session) => removeFreezeFrame(session, position.segment.id))
          : state
      }
      return mutation(state, (session) => {
        const [start, end] = range
        const result = removeOutputRange(session.segments, session.overlays, start, end)
        const duration = timelineDuration(result.segments)
        return {
          ...session,
          ...result,
          playhead: Math.min(start, duration),
          marks: marksAfterRemoval(session.marks, start, end, duration),
          focusZooms: timedRangesAfterRemoval(session.focusZooms, start, end),
          ...(session.faceBlurs === undefined ? {} : { faceBlurs: timedRangesAfterRemoval(session.faceBlurs, start, end) }),
          ...(session.videoTransitions === undefined ? {} : { videoTransitions: timedRangesAfterRemoval(session.videoTransitions, start, end) }),
          selectedOverlayId: result.overlays.some((item) => item.id === session.selectedOverlayId)
            ? session.selectedOverlayId
            : null
        }
      })
    })
  },
  setSpeed(rate) {
    set((state) => {
      if (!state.session) return state
      const range = deletionRange(state.session)
      if (!range || range[1] - range[0] <= 0.0001) return state
      return mutation(state, (session) => applySpeedToOutputRange(session, range[0], range[1], rate))
    })
  },
  addFocusZoom(zoom, focusX, focusY) {
    set((state) => {
      if (!state.session) return state
      const range = deletionRange(state.session)
      if (!range) return state
      return mutation(state, (session) => addFocusZoom(session, range[0], range[1], zoom, focusX, focusY))
    })
  },
  removeFocusZoom() {
    set((state) => {
      if (!state.session) return state
      const range = deletionRange(state.session)
      return range ? mutation(state, (session) => removeFocusZoomFromRange(session, range[0], range[1])) : state
    })
  },
  applyVideoTransition(into, out) {
    set((state) => {
      if (!state.session) return state
      const total = timelineDuration(state.session.segments)
      const range = deletionRange(state.session) ?? [0, total]
      if (range[1] - range[0] <= 0.0001) return state
      return mutation(state, (session) => ({
        ...session,
        videoTransitions: replaceVideoRangeTransition(
          session.videoTransitions ?? [], range[0], range[1], into, out
        )
      }))
    })
  },
  applyFaceBlur(settings: FaceBlurSettings) {
    set((state) => {
      if (!state.session) return state
      const duration = timelineDuration(state.session.segments)
      const range = deletionRange(state.session) ?? [0, duration]
      if (range[1] - range[0] <= 0.0001) return state
      const nextFaceBlurs = replaceFaceBlurRange(state.session.faceBlurs ?? [], range[0], range[1], settings)
      if (nextFaceBlurs.length > faceBlurMaxEffects) {
        return { error: `Face blur limit reached. Remove an existing range before adding another.` }
      }
      return mutation(state, (session) => ({
        ...session,
        faceBlurs: nextFaceBlurs
      }))
    })
  },
  updateFaceBlurSettings(id, settings) {
    set((state) => {
      if (!state.session?.faceBlurs?.some((effect) => effect.id === id)) return state
      return mutation(state, (session) => ({
        ...session,
        faceBlurs: updateFaceBlurById(session.faceBlurs ?? [], id, settings)
      }))
    })
  },
  removeFaceBlur(id) {
    set((state) => {
      const current = state.session?.faceBlurs
      if (!current) return state
      const faceBlurs = removeFaceBlurById(current, id)
      return faceBlurs === current
        ? state
        : mutation(state, (session) => ({ ...session, faceBlurs }))
    })
  },
  insertFreeze(duration) {
    set((state) => mutation(state, (session) => insertFreezeFrame(session, session.playhead, duration)))
  },
  removeFreeze() {
    set((state) => {
      if (!state.session) return state
      const position = positionAtOutputTime(state.session.segments, state.session.playhead)
      if (!position || !isFreezeSegment(position.segment)) return state
      return mutation(state, (session) => removeFreezeFrame(session, position.segment.id))
    })
  },
  insertReplay() {
    set((state) => {
      if (!state.session) return state
      const eligibility = replayEligibility(state.session)
      if (!eligibility.range) return state
      const [start, end] = eligibility.range
      const replayed = insertReplayEdit(state.session, start, end)
      if (replayed.faceBlurs && replayed.faceBlurs.length > faceBlurMaxEffects) {
        return { error: 'Face blur limit reached. Remove an existing range before adding Replay.' }
      }
      return mutation(state, () => replayed)
    })
  },
  removeReplay() {
    set((state) => {
      if (!state.session || !replayEligibility(state.session).removableGroupId) return state
      return mutation(state, removeReplayAtPlayhead)
    })
  },
  setTextAnimation(id, preset) {
    set((state) => mutation(state, (session) => patchedOverlaySession(session, id, { animation: preset } as Partial<Overlay>)))
  },
  addText() {
    set((state) => mutation(state, (session) => {
      const duration = timelineDuration(session.segments)
      const overlay = normalizeOverlay({
        ...defaultTextOverlay(session.playhead, session.overlays.length + 1),
        duration: Math.min(3, duration - session.playhead)
      }, duration)
      return { ...session, overlays: [...session.overlays, overlay], selectedOverlayId: overlay.id }
    }))
  },
  async addAsset(asset) {
    const session = get().session
    if (!session) return
    const generation = projectGeneration
    try {
      const metadata = await window.otc.probeAsset(asset.path)
      if (generation !== projectGeneration) return
      const remaining = Math.max(0.1, timelineDuration(session.segments) - session.playhead)
      const naturalDuration = metadata.duration > 0 ? metadata.duration : 3
      const duration = Math.min(remaining, asset.type === 'image' ? 3 : naturalDuration)
      let overlay: Overlay
      if (asset.type === 'audio') {
        overlay = {
          id: makeId('audio'), type: 'audio', name: asset.name, path: asset.path,
          start: session.playhead, duration, zIndex: session.overlays.length + 1,
          volume: 1, sourceIn: 0
        }
      } else if (asset.type === 'video') {
        overlay = {
          id: makeId('video'), type: 'video', name: asset.name, path: asset.path,
          start: session.playhead, duration, zIndex: session.overlays.length + 1,
          x: 0.6, y: 0.06, width: 0.34, height: 0.34,
          opacity: 1, loop: false, audioEnabled: false, hasAudio: metadata.hasAudio,
          volume: 1, sourceIn: 0, sourceDuration: naturalDuration
        }
      } else if (asset.type === 'gif') {
        overlay = {
          id: makeId('gif'), type: 'gif', name: asset.name, path: asset.path,
          playbackPath: metadata.playbackPath,
          start: session.playhead, duration, zIndex: session.overlays.length + 1,
          x: 0.62, y: 0.08, width: 0.3, height: 0.3, opacity: 1,
          sourceIn: 0, sourceDuration: naturalDuration
        }
      } else {
        overlay = {
          id: makeId('image'), type: 'image', name: asset.name, path: asset.path,
          start: session.playhead, duration, zIndex: session.overlays.length + 1,
          x: 0.62, y: 0.08, width: 0.3, height: 0.3, opacity: 1
        }
      }
      set((state) => mutation(state, (current) => {
        const added = normalizeOverlay(overlay, timelineDuration(current.segments))
        return {
          ...current,
          overlays: [...current.overlays, added],
          selectedOverlayId: added.id
        }
      }))
    } catch {
      if (generation === projectGeneration) set({ error: 'OneTrackCat could not add this item. Try another file.' })
    }
  },
  async addExternalMedia() {
    const generation = projectGeneration
    try {
      const selection = await window.otc.openMedia()
      if (!selection || generation !== projectGeneration) return
      await get().addAsset({
        type: selection.type,
        name: selection.name,
        path: selection.path
      })
    } catch {
      if (generation === projectGeneration) set({ error: 'OneTrackCat could not add this item. Try another file.' })
    }
  },
  selectOverlay(id) {
    set((state) => state.session ? { session: { ...state.session, selectedOverlayId: id } } : state)
  },
  updateOverlay(id, patch) {
    set((state) => mutation(state, (session) => patchedOverlaySession(session, id, patch)))
  },
  beginOverlayGesture() {
    set((state) => state.session && !state.gesture
      ? { gesture: state.session }
      : state)
  },
  updateOverlayGesture(id, patch) {
    set((state) => state.session
      ? { session: patchedOverlaySession(state.session, id, patch) }
      : state)
  },
  commitOverlayGesture() {
    set((state) => {
      if (!state.gesture || !state.session) return state
      if (JSON.stringify(state.gesture.overlays) === JSON.stringify(state.session.overlays)) {
        return { gesture: null }
      }
      return {
        gesture: null,
        history: [...state.history.slice(-49), state.gesture],
        future: []
      }
    })
  },

  cancelOverlayGesture() {
    set((state) => state.gesture
      ? { session: state.gesture, gesture: null }
      : state)
  },

  removeSelectedOverlay() {
    set((state) => mutation(state, (session) => ({
      ...session,
      overlays: session.overlays.filter((overlay) => overlay.id !== session.selectedOverlayId),
      selectedOverlayId: null
    })))
  },

  undo() {
    set((state) => {
      const previous = state.history.at(-1)
      if (!previous || !state.session) return state
      return {
        session: previous,
        gesture: null,
        history: state.history.slice(0, -1),
        future: [state.session, ...state.future].slice(0, 50)
      }
    })
    get().session?.sources.forEach(loadWaveform)
  },

  redo() {
    set((state) => {
      const next = state.future[0]
      if (!next || !state.session) return state
      return {
        session: next,
        gesture: null,
        history: [...state.history, state.session].slice(-50),
        future: state.future.slice(1)
      }
    })
    get().session?.sources.forEach(loadWaveform)
  },

  setJob(job) {
    if (job.kind === 'export') set({ job })
  },
  showError(error) { set({ error }) },
  clearError() { set({ error: null }) }
  }
})
// Development hot reload must retain unsaved edits, not recreate an empty store
// and reload the last disk snapshot. Keep data only; actions use the new code.
if (import.meta.hot?.data) {
  const hotData = import.meta.hot.data as { editorState?: Partial<EditorState> }
  const retained = hotData.editorState
  if (retained) useEditorStore.setState(retained)
  import.meta.hot.dispose((data: { editorState?: Partial<EditorState> }) => {
    const { initialized, session, history, future, gesture, assets, gpu, job, busy, error } = useEditorStore.getState()
    data.editorState = { initialized, session, history, future, gesture, assets, gpu, job, busy, error }
  })
}
