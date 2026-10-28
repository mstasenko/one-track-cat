import type { NarrationSubtitleLine } from '@shared/narration-subtitles'
import type { AudioOverlay, EditSession, Overlay, TextOverlay } from '@shared/types'
import { defaultTextOverlay } from './timeline'

const captionX = 0.05
const captionY = 0.82
const captionWidth = 0.9
const captionHeight = 0.12
const targetShortEdge = 1080
const targetFontPixels = 64
const minimumFontPixels = 12
const landscapeCharacterLimit = 44
const portraitCharacterLimit = 24
const estimatedCharacterWidth = 0.6

function singleLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

function subtitleFontSize(session: EditSession, text: string): number {
  const { width, height } = session.canvas
  const shortEdge = Math.min(width, height)
  const targetPixels = Math.max(minimumFontPixels, targetFontPixels * shortEdge / targetShortEdge)
  const portrait = height > width
  const maximumCharacters = portrait ? portraitCharacterLimit : landscapeCharacterLimit
  const characterCount = Math.max(1, text.length)
  const characterFit = targetPixels * Math.min(1, maximumCharacters / characterCount)
  const widthFit = width * captionWidth / (characterCount * estimatedCharacterWidth)
  const pixels = Math.max(minimumFontPixels, Math.min(targetPixels, characterFit, widthFit))
  return pixels * 100 / height
}

/** Generated captions render as text, but are edited only through Re-voice. */
export function isNarrationSubtitle(overlay: Overlay): boolean {
  return overlay.type === 'text' && overlay.narrationId !== undefined
}

/** Create ordinary editable text overlays for generated narration captions. */
export function narrationSubtitleOverlays(
  session: EditSession,
  narration: AudioOverlay,
  lines: readonly NarrationSubtitleLine[]
): TextOverlay[] {
  const highestZIndex = session.overlays.reduce((highest, overlay) => Math.max(highest, overlay.zIndex), 0)
  return lines.map((line, index) => {
    const text = singleLine(line.text)
    const start = narration.start + line.start
    const overlay = defaultTextOverlay(start, highestZIndex + index + 1)
    return {
      ...overlay,
      name: 'Subtitle',
      narrationId: narration.narration?.draftId ?? narration.id,
      start,
      duration: line.end - line.start,
      x: captionX,
      y: captionY,
      width: captionWidth,
      height: captionHeight,
      text,
      fontFamily: 'Roboto',
      fontSize: subtitleFontSize(session, text),
      color: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 1,
      shadow: false,
      align: 'center'
    }
  })
}

function intervalsOverlap(left: Overlay, right: AudioOverlay): boolean {
  return left.start < right.start + right.duration && right.start < left.start + left.duration
}

/** Match captions to a narration revision while keeping split owners range-local. */
export function narrationSubtitleBelongsTo(overlay: Overlay, owner: AudioOverlay): boolean {
  if (overlay.type !== 'text' || overlay.narrationId === undefined) return false
  const draftId = owner.narration?.draftId
  const matchesLink = overlay.narrationId === draftId || overlay.narrationId === owner.id
  return matchesLink && intervalsOverlap(overlay, owner)
}

/** Captions follow the generated narration branch and hide on the original branch. */
export function narrationSubtitleVisible(overlay: Overlay, overlays: readonly Overlay[]): boolean {
  if (overlay.type !== 'text' || overlay.narrationId === undefined) return true
  return overlays.some((candidate) => candidate.type === 'audio' && candidate.narration?.enabled === true &&
    narrationSubtitleBelongsTo(overlay, candidate))
}

/** Remove an owner and only its range-local generated captions. */
export function withoutNarrationOverlay(overlays: Overlay[], id: string | null): Overlay[] {
  const owner = id === null
    ? undefined
    : overlays.find((overlay): overlay is AudioOverlay => overlay.id === id && overlay.type === 'audio')
  return overlays.filter((overlay) => overlay.id !== id && !(owner && narrationSubtitleBelongsTo(overlay, owner)))
}
