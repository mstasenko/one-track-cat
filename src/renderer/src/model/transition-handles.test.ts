import { describe, expect, it, vi } from 'vitest'
import type { EditSession, MediaMetadata, SourceSegment, VideoSegment } from '@shared/types'
import { transitionPreviewAtOutputTime } from './transitions'
import { createSession, defaultTextOverlay, timelineDuration } from './timeline'
import { restoreTransitionHandles } from './transition-handles'
import { restoredEditorState, savedSession } from './store-session'

const source: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

function video(segment: SourceSegment | undefined): VideoSegment {
  if (!segment || segment.kind === 'freeze') throw new Error('video segment missing')
  return segment
}

function legacySession(): EditSession {
  const session = createSession(source)
  const sourceId = session.sources[0]?.id
  if (!sourceId) throw new Error('source missing')
  const inserted = { ...source, path: '/inserted.mp4', name: 'inserted.mp4', duration: 2 }
  session.sources.push({ id: 'inserted', metadata: inserted, playbackPath: inserted.path, waveform: [] })
  session.segments = [
    { id: 'source-segment', sourceId, sourceStart: 0, sourceEnd: source.duration },
    { id: 'inserted-segment', sourceId: 'inserted', sourceStart: 0, sourceEnd: inserted.duration, transition: { effect: 'fade', duration: 1 } }
  ]
  session.overlays = [
    { ...defaultTextOverlay(8, 1), id: 'spanning', duration: 4 },
    { ...defaultTextOverlay(10.5, 2), id: 'after', duration: 1 }
  ]
  session.marks = [2, 10.5, 11]
  session.focusZooms = [{ id: 'focus', start: 8, duration: 4, zoom: 1.5, focusX: 0.5, focusY: 0.5 }]
  session.faceBlurs = [{ id: 'blur', start: 8, duration: 4, sensitivity: 0.5, detail: 'standard', holdSeconds: 0.2, strength: 0.5, style: 'blur' }]
  session.videoTransitions = [{ id: 'range', start: 8, duration: 4, into: { effect: 'fade', duration: 1 } }]
  session.playhead = 10.5
  return session
}

describe('legacy transition handles', () => {
  it('repairs saved current, undo, and redo snapshots on reopening', async () => {
    const session = legacySession()
    vi.stubGlobal('otc', undefined)
    Object.defineProperty(window, 'otc', { configurable: true, value: { getPathUrl: vi.fn((path: string) => Promise.resolve(path)) } })
    try {
      const restored = await restoredEditorState(savedSession(session, [session], [session]))
      for (const item of [restored.session, ...restored.history, ...restored.future]) {
        expect(video(item.segments[0]).sourceEnd).toBe(9)
        expect(item.playhead).toBe(9.5)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reserves an EOF handle and ripples attached timeline ranges', () => {
    const session = legacySession()
    const sourceBefore = structuredClone(session.sources)
    const result = restoreTransitionHandles(session)

    expect(video(result.segments[0]).sourceEnd).toBe(9)
    expect(video(result.segments[1]).transition).toEqual({ effect: 'fade', duration: 1 })
    expect(timelineDuration(result.segments)).toBe(11)
    expect(result.playhead).toBe(9.5)
    expect(result.marks).toEqual([2, 9.5, 10])
    expect(result.overlays.map(({ id, start, duration }) => ({ id, start, duration }))).toEqual([
      { id: 'spanning', start: 8, duration: 3 },
      { id: 'after', start: 9.5, duration: 1 }
    ])
    expect(result.focusZooms).toEqual([{ id: 'focus', start: 8, duration: 3, zoom: 1.5, focusX: 0.5, focusY: 0.5 }])
    expect(result.faceBlurs).toEqual([expect.objectContaining({ id: 'blur', start: 8, duration: 3 })])
    expect(result.videoTransitions).toEqual([expect.objectContaining({ id: 'range', start: 8, duration: 3 })])
    expect(result.sources).toEqual(sourceBefore)
    expect(video(session.segments[0]).sourceEnd).toBe(source.duration)

    const early = transitionPreviewAtOutputTime(result, 9.25)
    const late = transitionPreviewAtOutputTime(result, 9.75)
    if (!early || !late) throw new Error('transition preview missing')
    expect(early.previousSourceTime).toBe(9.25)
    expect(late.previousSourceTime).toBe(9.75)
    expect(late.previousSourceTime).toBeGreaterThan(early.previousSourceTime)
    expect(late.previousSourceTime).toBeLessThan(source.duration)
  })

  it('is idempotent after the missing handle has been reserved', () => {
    const repaired = restoreTransitionHandles(legacySession())
    expect(restoreTransitionHandles(repaired)).toBe(repaired)
  })
})
