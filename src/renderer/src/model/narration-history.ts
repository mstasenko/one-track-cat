import type { AudioOverlay, EditSession, Overlay } from '@shared/types'
import type { NarrationGeneratedAudio } from '@shared/narration-api'
import type { EditorState } from './editor-state'
import { mutation } from './store-session'
import { narrationSampleRate } from '@shared/narration'
import { narrationSubtitleBelongsTo, narrationSubtitleOverlays } from './narration-subtitles'
import { makeId } from './timeline'

/** Keep the cached audio/captions outside a replacement without moving the video. */
function outsideRange(overlay: Overlay, start: number, end: number): Overlay[] {
  const overlayEnd = overlay.start + overlay.duration
  if (overlayEnd <= start || overlay.start >= end) return [overlay]
  const pieces: Overlay[] = []
  // Sub-millisecond rounding tails cannot be saved as standalone effects.
  if (start - overlay.start >= 0.001) pieces.push({ ...overlay, duration: start - overlay.start })
  if (overlayEnd - end >= 0.001) pieces.push({ ...overlay,
    id: pieces.length ? makeId(overlay.type) : overlay.id,
    start: end, duration: overlayEnd - end,
    ...(overlay.type === 'audio' ? { sourceIn: overlay.sourceIn + end - overlay.start } : {}) })
  return pieces
}

function otherEdits(session: EditSession, id: string, range: AudioOverlay): string {
  const owner = session.overlays.find((item) => item.id === id && item.type === 'audio')
  const narrations = session.overlays.filter((item): item is AudioOverlay => item.type === 'audio' && !!item.narration)
  const start = Math.round(range.start * narrationSampleRate) / narrationSampleRate
  const end = Math.round((range.start + range.duration) * narrationSampleRate) / narrationSampleRate
  return JSON.stringify({ ...session, playhead: 0, selectedOverlayId: null,
    overlays: session.overlays.flatMap<unknown>((item) => {
      if (item.id === id || owner?.type === 'audio' && narrationSubtitleBelongsTo(item, owner)) return []
      const narration = narrations.find((audio) => audio.id === item.id || narrationSubtitleBelongsTo(item, audio))
      if (!narration) return [item]
      // Compare retained content, not the new IDs created by splitting its cache.
      return outsideRange(item, start, end).map((piece) => ({ ...piece, id: undefined,
        ...(piece.type === 'text' ? { narrationId: narration.narration?.draftId } : {}) }))
    }),
    sources: session.sources.map(({ id, metadata }) => ({ id, metadata })) })
}

/** Commit generated audio as one effect, not a stack of preparation states.
 * Immutable audio stays available for Redo without running the models again. */
export function installNarrationResult(state: EditorState, startedWith: EditSession,
  result: NarrationGeneratedAudio, replacedId?: string, originalPath?: string, replaceOverlaps = false): Partial<EditorState> {
  const id = replacedId ?? result.id
  const { subtitleLines, ...audio } = result
  const change = mutation(state, (current) => {
    if (JSON.stringify(current.segments) !== JSON.stringify(startedWith.segments) || current.sources !== startedWith.sources ||
        (replacedId && !current.overlays.some((item) => item.id === replacedId))) {
      throw new Error('The project changed during narration processing; recognize again')
    }
    // Audio joins are sample-aligned; floating-point tails must not count as overlap.
    const start = Math.round(result.start * narrationSampleRate)
    const end = Math.round((result.start + result.duration) * narrationSampleRate)
    const inRange = (item: Overlay): item is AudioOverlay => item.id !== id && item.type === 'audio' && !!item.narration &&
        Math.round(item.start * narrationSampleRate) < end &&
        Math.round((item.start + item.duration) * narrationSampleRate) > start
    const overlapping = current.overlays.filter(inRange)
    if (replaceOverlaps && JSON.stringify(overlapping) !== JSON.stringify(startedWith.overlays.filter(inRange))) {
      throw new Error('The Re-voice section changed during recognition; try again')
    }
    // Recognize may replace marked speech; regenerating an existing owner must
    // still reject a result that spills into another section.
    if (overlapping.length && (!replaceOverlaps || replacedId)) {
      throw new Error('Remove the overlapping Re-voice effect before applying this selection')
    }
    const previous = current.overlays.find((item) => item.id === id && item.type === 'audio')
    const retained = current.overlays.flatMap((item) => {
      if (item.id === id || previous?.type === 'audio' && narrationSubtitleBelongsTo(item, previous)) return []
      if (overlapping.some((owner) => owner.id === item.id)) return outsideRange(item, start / narrationSampleRate, end / narrationSampleRate)
      const owner = overlapping.find((owner) => narrationSubtitleBelongsTo(item, owner))
      // Legacy captions linked to the old overlay ID must follow both cached pieces.
      if (owner && item.type === 'text') return outsideRange({ ...item, narrationId: owner.narration?.draftId ?? owner.id },
        start / narrationSampleRate, end / narrationSampleRate)
      return [item]
    })
    const subtitles = narrationSubtitleOverlays(current, { ...audio, id }, subtitleLines ?? [])
    if (retained.length + subtitles.length + 1 > 10_000) throw new Error('Too many overlays for subtitles; use a shorter Re-voice section')
    return { ...current, selectedOverlayId: id, overlays: [...retained, { ...audio, id }, ...subtitles] }
  })
  if (!originalPath || !change.history) return change
  const history = [...change.history]
  while (history.length > 1) {
    const prepared = history.at(-1)
    const previous = history.at(-2)
    if (!prepared || !previous || !prepared.overlays.some((item) => item.id === id && item.type === 'audio' && item.path === originalPath) ||
        otherEdits(prepared, id, audio) !== otherEdits(previous, id, audio)) break
    // Collapse only this effect's pending draft/text/style edits. Never consume
    // an unrelated edit or the previously generated audio being replaced.
    history.pop()
  }
  return { ...change, history }
}
