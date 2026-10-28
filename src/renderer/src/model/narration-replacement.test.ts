import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioOverlay } from '@shared/types'
import { parseSavedSession } from '../../../main/validation'
import { installNarrationResult } from './narration-history'
import { narrationSubtitleVisible } from './narration-subtitles'
import { createSession, defaultTextOverlay } from './timeline'
import { restoredEditorState, savedSession } from './store-session'
import { useEditorStore } from './store'

const draftId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const original = { id: 'voice', type: 'audio', name: 'Re-voice', path: '/cached.wav', start: 0,
  duration: 10, sourceIn: 2, volume: 1, zIndex: 0,
  narration: { draftId, enabled: true, voiceStyle: 'calm', backgroundVolume: 0.2, slowdown: 0,
    subtitles: true, originals: ['Original words.'], revisions: ['Keep these edits.'], transcriptRange: [2, 12] } } satisfies AudioOverlay
const review: AudioOverlay = { ...original, id: 'replacement', path: '/original-selection.wav', start: 3, duration: 2,
  sourceIn: 0, narration: { draftId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', enabled: false } }

function replace(result = review): void {
  const state = useEditorStore.getState()
  if (!state.session) throw new Error('Missing session')
  useEditorStore.setState(installNarrationResult(state, state.session, result, undefined, undefined, true))
}
function audio(): AudioOverlay[] {
  return (useEditorStore.getState().session?.overlays ?? []).filter((o): o is AudioOverlay => o.type === 'audio')
}
beforeEach(() => {
  Object.defineProperty(window, 'otc', { configurable: true, value: {
    waveform: vi.fn().mockResolvedValue([]), getPathUrl: (path: string) => Promise.resolve(`media:${path}`)
  } })
  const session = createSession({ path: '/video.mp4', name: 'video', size: 1, modifiedAt: 1,
    duration: 10, width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true })
  useEditorStore.setState({ session: { ...session, overlays: [original] }, history: [], future: [], gesture: null })
})

describe('Re-voice replacement', () => {
  it.each([[0, 4], [3, 5], [6, 10], [0, 10]])('replaces only %s–%s and retains cached audio outside it', (start, end) => {
    const before = useEditorStore.getState().session
    replace({ ...review, start, duration: end - start })
    const pieces = audio().filter((o) => o.id !== review.id)
    const expected = [
      ...(start ? [{ start: 0, duration: start, sourceIn: 2 }] : []),
      ...(end < 10 ? [{ start: end, duration: 10 - end, sourceIn: 2 + end }] : [])
    ]
    expect(pieces.map(({ start, duration, sourceIn }) => ({ start, duration, sourceIn }))).toEqual(expected)
    for (const piece of pieces) {
      expect(piece.path).toBe(original.path)
      expect(piece.narration).toEqual(original.narration)
    }
    expect(new Set(audio().map((o) => o.id)).size).toBe(audio().length)
    expect(audio().find((o) => o.id === review.id)).toEqual({ ...review, start, duration: end - start })
    const after = useEditorStore.getState().session
    expect(after).toMatchObject({ sources: before?.sources, segments: before?.segments, canvas: before?.canvas })
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session).toEqual(before)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session).toEqual(after)
  })

  it('clips crossing captions, removes selected captions, and keeps unrelated edits', () => {
    const caption = (id: string, start: number, duration: number) => ({ ...defaultTextOverlay(start, 1),
      id, duration, text: id, narrationId: original.id })
    const before = caption('before', 0, 1)
    const crossing = caption('crossing', 2, 4)
    const inside = caption('inside', 3.2, 1)
    const after = caption('after', 7, 1)
    const userText = { ...defaultTextOverlay(3.5, 2), id: 'user', duration: 1, text: 'Keep me' }
    useEditorStore.setState((s) => ({ session: s.session && { ...s.session,
      overlays: [original, before, crossing, inside, after, userText] } }))
    replace()
    const overlays = useEditorStore.getState().session?.overlays ?? []
    expect(overlays.find((o) => o.id === inside.id)).toBeUndefined()
    const crossingPieces = overlays.filter((o) => o.type === 'text' && o.text === crossing.text)
    expect(crossingPieces.map(({ start, duration }) => ({ start, duration })))
      .toEqual([{ start: 2, duration: 1 }, { start: 5, duration: 1 }])
    for (const caption of [...crossingPieces, ...overlays.filter((o) => o.id === before.id || o.id === after.id)]) {
      expect(caption).toMatchObject({ narrationId: draftId })
      expect(narrationSubtitleVisible(caption, overlays)).toBe(true)
    }
    expect(overlays.find((o) => o.id === userText.id)).toEqual(userText)
  })

  it('regenerates the new piece, preserves siblings, and restores their editable metadata on reopen', async () => {
    replace()
    const state = useEditorStore.getState()
    if (!state.session) throw new Error('Missing session')
    const siblings = audio().filter((o) => o.id !== review.id)
    useEditorStore.setState(installNarrationResult(state, state.session, { ...review, path: '/new.wav',
      narration: { draftId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', enabled: true },
      subtitleLines: [{ start: 0.1, end: 0.8, text: 'New wording.' }] }, review.id, review.path))
    expect(audio().filter((o) => o.id !== review.id)).toEqual(siblings)
    const generated = useEditorStore.getState()
    if (!generated.session) throw new Error('Missing generated session')
    const restored = await restoredEditorState(parseSavedSession(savedSession(generated.session, generated.history, generated.future)))
    expect(restored.session.overlays).toEqual(generated.session.overlays)
    useEditorStore.setState(restored)
    useEditorStore.getState().undo()
    expect(audio()).toEqual([original])
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session?.overlays).toEqual(generated.session.overlays)
  })

  it('replaces across multiple owners while retaining adjacent narration', () => {
    const owners = [0, 2, 6, 8].map((start, i) => ({ ...original, id: `owner-${i}`, start,
      duration: i === 1 ? 4 : 2, sourceIn: start + 1 }))
    useEditorStore.setState((s) => ({ session: s.session && { ...s.session, overlays: owners } }))
    replace({ ...review, start: 3, duration: 4 })
    expect(audio().map(({ start, duration, sourceIn }) => ({ start, duration, sourceIn })))
      .toEqual([{ start: 0, duration: 2, sourceIn: 1 }, { start: 2, duration: 1, sourceIn: 3 },
        { start: 7, duration: 1, sourceIn: 8 }, { start: 8, duration: 2, sourceIn: 9 }, { start: 3, duration: 4, sourceIn: 0 }])
  })

  it.each(['changed', 'added', 'removed'])('rejects an overlapping owner %s during recognition', (change) => {
    const startedWith = useEditorStore.getState().session
    if (!startedWith) throw new Error('Missing session')
    const overlays = change === 'removed' ? [] : change === 'added'
      ? [original, { ...original, id: 'new-owner' }]
      : [{ ...original, narration: { ...original.narration, enabled: false } }]
    useEditorStore.setState({ session: { ...startedWith, overlays } })
    const current = useEditorStore.getState()
    expect(() => installNarrationResult(current, startedWith, review, undefined, undefined, true))
      .toThrow('changed during recognition')
    expect(useEditorStore.getState().session?.overlays).toEqual(overlays)
    expect(useEditorStore.getState().history).toHaveLength(0)
  })

  it('retains an unrelated sibling edit when undoing generation', () => {
    replace()
    const sibling = audio().find((o) => o.id !== review.id)
    if (!sibling?.narration) throw new Error('Missing sibling')
    useEditorStore.getState().updateOverlay(sibling.id, { narration: { ...sibling.narration, backgroundVolume: 0.5 } })
    const before = useEditorStore.getState().session
    const state = useEditorStore.getState()
    if (!state.session) throw new Error('Missing session')
    useEditorStore.setState(installNarrationResult(state, state.session, { ...review, path: '/regenerated.wav' }, review.id, review.path))
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session).toEqual(before)
  })

  it('uses sample-aligned splits and drops only tails below the saved effect minimum', () => {
    const start = 3 + 0.4 / 48000
    replace({ ...review, start, duration: 2 })
    expect(audio().filter((o) => o.id !== review.id).map(({ start, duration, sourceIn }) => ({ start, duration, sourceIn })))
      .toEqual([{ start: 0, duration: 3, sourceIn: 2 }, { start: 5, duration: 5, sourceIn: 7 }])
    useEditorStore.getState().undo()
    replace({ ...review, start: 0.0005, duration: 9.999 })
    expect(audio()).toHaveLength(1)
    const state = useEditorStore.getState()
    const session = state.session
    if (!session) throw new Error('Missing session')
    expect(() => parseSavedSession(savedSession(session, state.history))).not.toThrow()
  })
})
