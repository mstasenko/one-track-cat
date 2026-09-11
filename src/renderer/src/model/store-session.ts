import type { EditSession, Overlay, SavedSession, SavedSessionSnapshot } from '@shared/types'
import type { EditorState } from './editor-state'
import { clamp, timelineDuration } from './timeline'
import { restoreTransitionHandles } from './transition-handles'
import { fitVideoRangeTransition } from '@shared/video-range-transition'

let sessionWriteQueue: Promise<void> = Promise.resolve()

export function queueSessionWrite(callback: () => Promise<void>): Promise<void> {
  const write = sessionWriteQueue.catch(() => undefined).then(callback)
  sessionWriteQueue = write
  return write
}

export function mutation(
  state: EditorState,
  update: (session: EditSession) => EditSession
): Partial<EditorState> {
  if (!state.session) return {}
  const previous = state.session
  let next = update(previous)
  if (next.videoTransitions) {
    const fitted = next.videoTransitions.map(fitVideoRangeTransition)
    if (fitted.some((effect, index) => effect !== next.videoTransitions?.[index])) next = { ...next, videoTransitions: fitted }
  }
  const changed = next !== previous && (Object.keys(previous) as (keyof EditSession)[]).some((key) => {
    const nextValue = next[key]
    const previousValue = previous[key]
    return nextValue !== previousValue && JSON.stringify(nextValue) !== JSON.stringify(previousValue)
  })
  if (!changed) return {}
  return {
    session: next,
    // Session edits are immutable, so Undo can share large waveform/source arrays safely.
    history: [...state.history.slice(-49), previous],
    future: []
  }
}

export function normalizeOverlay(overlay: Overlay, duration: number): Overlay {
  const overlayDuration = clamp(overlay.duration, 0.001, duration)
  const normalized = {
    ...overlay,
    start: clamp(overlay.start, 0, Math.max(0, duration - overlayDuration)),
    duration: overlayDuration
  }
  if (normalized.type === 'audio') return normalized
  const opacity = Number.isFinite(normalized.opacity) ? clamp(normalized.opacity, 0, 1) : 1
  return { ...normalized, opacity }
}

export function patchedOverlaySession(
  session: EditSession,
  id: string,
  patch: Partial<Overlay>
): EditSession {
  const duration = timelineDuration(session.segments)
  const index = session.overlays.findIndex((overlay) => overlay.id === id)
  const current = session.overlays[index]
  if (!current) return session
  const changed = { ...current, ...patch } as Overlay
  if (patch.duration !== undefined && patch.start === undefined) {
    changed.duration = Math.min(patch.duration, Math.max(0.001, duration - current.start))
  }
  const candidate = normalizeOverlay(changed, duration)
  if (JSON.stringify(candidate) === JSON.stringify(current)) return session
  const overlays = [...session.overlays]
  overlays[index] = candidate
  return { ...session, overlays }
}

function savedSnapshot(session: EditSession): SavedSessionSnapshot {
  const duration = timelineDuration(session.segments)
  return {
    canvas: session.canvas,
    sources: session.sources.map(({ id, metadata }) => ({ id, metadata })),
    segments: session.segments,
    overlays: session.overlays.map((overlay) => normalizeOverlay(overlay, duration)),
    selectedOverlayId: session.selectedOverlayId,
    playhead: session.playhead,
    marks: session.marks,
    focusZooms: session.focusZooms,
    ...(session.videoTransitions === undefined ? {} : { videoTransitions: session.videoTransitions.map(fitVideoRangeTransition) }),
    ...(session.faceBlurs === undefined ? {} : { faceBlurs: session.faceBlurs })
  }
}

export function savedSession(
  session: EditSession,
  history: EditSession[] = [],
  future: EditSession[] = []
): SavedSession {
  return {
    ...savedSnapshot(session),
    history: history.slice(-50).map(savedSnapshot),
    future: future.slice(0, 50).map(savedSnapshot)
  }
}

async function restoredSession(
  saved: SavedSessionSnapshot,
  pathUrl: (path: string) => Promise<string>
): Promise<EditSession> {
  const sources = await Promise.all(saved.sources.map(async (source) => ({
    ...source,
    playbackPath: await pathUrl(source.metadata.path),
    waveform: []
  })))
  const duration = timelineDuration(saved.segments)
  return restoreTransitionHandles({
    ...saved,
    sources,
    overlays: saved.overlays.map((overlay) => normalizeOverlay(overlay, duration)),
    focusZooms: saved.focusZooms ?? [],
    videoTransitions: saved.videoTransitions ?? [],
    ...(saved.faceBlurs === undefined ? {} : { faceBlurs: saved.faceBlurs })
  })
}

export async function restoredEditorState(saved: SavedSession): Promise<{
  session: EditSession
  history: EditSession[]
  future: EditSession[]
}> {
  const urls = new Map<string, Promise<string>>()
  const pathUrl = (path: string): Promise<string> => {
    const existing = urls.get(path)
    if (existing) return existing
    const pending = window.otc.getPathUrl(path)
    urls.set(path, pending)
    return pending
  }
  const [session, history, future] = await Promise.all([
    restoredSession(saved, pathUrl),
    Promise.all((saved.history ?? []).map((snapshot) => restoredSession(snapshot, pathUrl))),
    Promise.all((saved.future ?? []).map((snapshot) => restoredSession(snapshot, pathUrl)))
  ])
  return { session, history, future }
}
