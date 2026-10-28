import { describe, expect, it } from 'vitest'
import { parseSavedSession } from '../../../main/validation'
import type { AudioOverlay, EditSession, MediaMetadata, Overlay, TextOverlay } from '@shared/types'
import { createSession, defaultTextOverlay } from './timeline'
import {
  narrationSubtitleBelongsTo,
  narrationSubtitleOverlays,
  narrationSubtitleVisible,
  withoutNarrationOverlay
} from './narration-subtitles'

const source: MediaMetadata = {
  path: '/video.mp4', name: 'video.mp4', size: 100, modifiedAt: 1, duration: 20,
  width: 1920, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: true
}

function narration(patch: Partial<AudioOverlay> = {}): AudioOverlay {
  return {
    id: 'narration-1', type: 'audio', name: 'Narration', path: '/narration.wav',
    start: 5, duration: 8, zIndex: 4, volume: 1, sourceIn: 0, ...patch
  }
}

function sessionFor(short: boolean): EditSession {
  return createSession(source, short)
}

describe('narration subtitle overlays', () => {
  it('creates centered, bottom-safe landscape overlays with absolute timing', () => {
    const session = sessionFor(false)
    session.overlays = [{ ...defaultTextOverlay(0, 8), id: 'existing-text' }]
    const owner = narration({ narration: { draftId: 'draft-1', enabled: true } })
    const overlays = narrationSubtitleOverlays(session, owner, [
      { start: 0.4, end: 1.6, text: 'A short generated caption.' },
      { start: 2, end: 3.25, text: 'Another caption.' }
    ])

    expect(overlays).toHaveLength(2)
    expect(overlays[0]).toMatchObject({
      name: 'Subtitle', narrationId: 'draft-1', start: 5.4,
      x: 0.05, y: 0.82, width: 0.9, height: 0.12,
      text: 'A short generated caption.', fontFamily: 'Roboto', color: '#ffffff',
      outlineColor: '#000000', outlineWidth: 1, shadow: false, align: 'center'
    })
    expect(overlays[0]?.duration).toBeCloseTo(1.2)
    expect((overlays[0]?.y ?? 0) + (overlays[0]?.height ?? 0)).toBeLessThanOrEqual(0.94)
    expect((overlays[0]?.fontSize ?? 0) * session.canvas.height / 100).toBeCloseTo(64, 5)
    expect(overlays[0]?.zIndex).toBe(9)
    expect(overlays[1]?.zIndex).toBe(10)
    expect(overlays[0]?.animation).toBeUndefined()
    expect(overlays[0]?.id).toMatch(/^text-[0-9a-f-]{36}$/)
  })

  it('scales portrait text to the short edge and fits longer lines conservatively', () => {
    const session = sessionFor(true)
    const overlays = narrationSubtitleOverlays(session, narration({ start: 2 }), [
      { start: 1.25, end: 2.5, text: 'Short portrait caption' },
      { start: 3, end: 4, text: 'This portrait caption is deliberately longer than twenty four characters.' }
    ])

    const shortPixels = (overlays[0]?.fontSize ?? 0) * session.canvas.height / 100
    const longPixels = (overlays[1]?.fontSize ?? 0) * session.canvas.height / 100
    expect(overlays[0]?.start).toBe(3.25)
    expect(overlays[0]?.duration).toBe(1.25)
    expect(shortPixels).toBeCloseTo(64, 5)
    expect(longPixels).toBeGreaterThanOrEqual(12)
    expect(longPixels).toBeLessThan(shortPixels)
    expect(overlays.every((overlay) => overlay.x === 0.05 && overlay.width === 0.9)).toBe(true)
    expect(overlays.every((overlay) => overlay.y + overlay.height <= 0.94)).toBe(true)
  })

  it('does not change the normal Add Text defaults or mutate the session', () => {
    const session = sessionFor(false)
    const before = structuredClone(session)
    const manual = defaultTextOverlay(0, 1)
    const overlays = narrationSubtitleOverlays(session, narration(), [
      { start: 0.5, end: 1.5, text: 'Caption with\nline break.' }
    ])

    expect(manual).toMatchObject({
      name: 'Text', x: 0.15, y: 0.72, width: 0.7, height: 0.2,
      text: 'Your text', fontFamily: 'Anton', fontSize: 7
    })
    expect(manual.narrationId).toBeUndefined()
    expect(overlays[0]?.text).toBe('Caption with line break.')
    expect(session).toEqual(before)
  })

  it('round-trips generated captions through saved-session validation', () => {
    const session = sessionFor(false)
    const overlays = narrationSubtitleOverlays(session, narration(), [
      { start: 0.25, end: 1.75, text: 'Saved caption.' }
    ])
    const saved = {
      canvas: session.canvas,
      sources: session.sources.map(({ id, metadata }) => ({ id, metadata })),
      segments: session.segments,
      overlays,
      selectedOverlayId: null,
      playhead: 0,
      marks: []
    }

    expect(parseSavedSession(saved).overlays).toEqual(overlays)
  })

  it('shows ordinary text and only enabled narration captions', () => {
    const session = sessionFor(false)
    const owner = narration({ narration: { draftId: 'draft', enabled: true } })
    const caption = narrationSubtitleOverlays(session, owner, [{ start: 0, end: 1, text: 'Caption' }])[0]
    const ordinary: TextOverlay = defaultTextOverlay(0, 1)
    if (!caption) throw new Error('caption overlay missing')

    expect(narrationSubtitleVisible(ordinary, [owner])).toBe(true)
    expect(narrationSubtitleVisible(caption, [owner])).toBe(true)
    expect(narrationSubtitleVisible(caption, [{ ...owner, narration: { draftId: 'draft', enabled: false } }])).toBe(false)
    expect(narrationSubtitleVisible(caption, [])).toBe(false)
  })

  it('keeps split narration captions attached to their matching time range', () => {
    const session = sessionFor(false)
    const draftId = 'shared-draft'
    const left = narration({
      id: 'narration-left', start: 0, duration: 5,
      narration: { draftId, enabled: true }
    })
    const right = narration({
      id: 'narration-right', start: 5, duration: 5,
      narration: { draftId, enabled: true }
    })
    const before = narrationSubtitleOverlays(session, left, [{ start: 0.5, end: 1.5, text: 'Before the cut.' }])[0]
    const after = narrationSubtitleOverlays(session, right, [{ start: 0.5, end: 1.5, text: 'After the cut.' }])[0]
    if (!before || !after) throw new Error('split captions missing')

    expect(before.narrationId).toBe(draftId)
    expect(after.narrationId).toBe(draftId)
    expect(narrationSubtitleBelongsTo(before, left)).toBe(true)
    expect(narrationSubtitleBelongsTo(before, right)).toBe(false)
    expect(narrationSubtitleBelongsTo(after, left)).toBe(false)
    expect(narrationSubtitleBelongsTo(after, right)).toBe(true)
    expect(narrationSubtitleVisible(before, [left, right])).toBe(true)
    expect(narrationSubtitleVisible(after, [left, right])).toBe(true)

    right.narration = { draftId, enabled: false }
    expect(narrationSubtitleVisible(before, [left, right])).toBe(true)
    expect(narrationSubtitleVisible(after, [left, right])).toBe(false)
  })

  it('supports the owner-ID fallback for captions saved before draft links', () => {
    const session = sessionFor(false)
    const owner = narration({ id: 'legacy-owner', start: 5, duration: 2 })
    const caption = narrationSubtitleOverlays(session, owner, [{ start: 0.25, end: 0.75, text: 'Legacy caption.' }])[0]
    if (!caption) throw new Error('legacy caption missing')

    expect(caption.narrationId).toBe(owner.id)
    expect(narrationSubtitleBelongsTo(caption, owner)).toBe(true)
  })

  it('removes only captions belonging to the selected narration range', () => {
    const session = sessionFor(false)
    const draftId = 'shared-draft'
    const left = narration({ id: 'narration-left', start: 0, duration: 5, narration: { draftId, enabled: true } })
    const right = narration({ id: 'narration-right', start: 5, duration: 5, narration: { draftId, enabled: true } })
    const before = narrationSubtitleOverlays(session, left, [{ start: 0.5, end: 1.5, text: 'Before.' }])[0]
    const after = narrationSubtitleOverlays(session, right, [{ start: 0.5, end: 1.5, text: 'After.' }])[0]
    const manual = defaultTextOverlay(0, 1)
    if (!before || !after) throw new Error('split captions missing')
    const overlays: Overlay[] = [left, right, before, after, manual]

    expect(withoutNarrationOverlay(overlays, left.id).map((overlay) => overlay.id)).toEqual([
      right.id, after.id, manual.id
    ])
    expect(withoutNarrationOverlay(overlays, manual.id).map((overlay) => overlay.id)).toEqual([
      left.id, right.id, before.id, after.id
    ])
    expect(withoutNarrationOverlay(overlays, null)).toEqual(overlays)
  })
})
