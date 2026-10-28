import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NarrationGeneratedAudio } from '@shared/narration-api'
import type { AudioOverlay } from '@shared/types'
import { parseSavedSession } from '../../../main/validation'
import { installNarrationResult } from './narration-history'
import { useEditorStore } from './store'
import { savedSession, restoredEditorState } from './store-session'
import { createSession, defaultTextOverlay } from './timeline'

const draft: AudioOverlay = { id: 'voice', type: 'audio', name: 'Re-voice', path: '/original.wav', start: 0,
  duration: 10, sourceIn: 0, volume: 1, zIndex: 0,
  narration: { draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: false } }
const generated: AudioOverlay = { ...draft, id: 'worker-result', path: '/voice-v1.wav',
  narration: { draftId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', enabled: true } }

function install(result: NarrationGeneratedAudio, previousId?: string, originalPath?: string): void {
  const state = useEditorStore.getState()
  if (!state.session) throw new Error('Missing fixture session')
  useEditorStore.setState(installNarrationResult(state, state.session, result, previousId, originalPath))
}

beforeEach(() => {
  Object.defineProperty(window, 'otc', { configurable: true, value: {
    waveform: vi.fn().mockResolvedValue([]), getPathUrl: (path: string) => Promise.resolve(`media:${path}`)
  } })
  useEditorStore.setState({ session: createSession({ path: '/video.mp4', name: 'video', size: 1, modifiedAt: 1,
    duration: 10, width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true }), history: [], future: [], gesture: null })
})

describe('Narration history', () => {
  it('persists generated captions through save/load while stripping transient audio lines', async () => {
    install({ ...generated, subtitleLines: [{ start: 0.4, end: 1.2, text: 'Please wait.' }] })
    const state = useEditorStore.getState()
    if (!state.session) throw new Error('Missing fixture session')
    const audio = state.session.overlays.find((overlay) => overlay.type === 'audio')
    const caption = state.session.overlays.find((overlay) => overlay.type === 'text')
    expect(audio).not.toHaveProperty('subtitleLines')
    expect(caption).toMatchObject({ type: 'text', narrationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', start: 0.4, text: 'Please wait.' })
    expect(caption?.duration).toBeCloseTo(0.8)
    const restored = await restoredEditorState(parseSavedSession(savedSession(state.session, state.history, state.future)))
    expect(restored.session.overlays).toEqual(state.session.overlays)
  })

  it('replaces only its own captions while retaining other narration sections and user text', () => {
    install(draft)
    install({ ...generated, id: 'first-result', start: 0, duration: 2, subtitleLines: [{ start: 0.2, end: 0.8, text: 'Old line' }] }, 'voice', '/original.wav')
    const state = useEditorStore.getState()
    if (!state.session) throw new Error('Missing fixture session')
    const other: AudioOverlay = { ...generated, id: 'other-section', path: '/other.wav', start: 3, duration: 2,
      narration: { draftId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', enabled: true } }
    const otherCaption = { ...defaultTextOverlay(3.2, 20), id: 'other-caption', text: 'Other section', narrationId: 'other-section' }
    const userText = { ...defaultTextOverlay(6, 21), id: 'user-text', text: 'Keep this edit' }
    useEditorStore.setState({ session: { ...state.session, overlays: [...state.session.overlays, other, otherCaption, userText] } })
    install({ ...generated, id: 'second-result', path: '/voice-v2.wav', start: 0, duration: 2,
      subtitleLines: [{ start: 0.3, end: 0.9, text: 'New line' }] }, 'voice', '/original.wav')
    const overlays = useEditorStore.getState().session?.overlays ?? []
    expect(overlays.find((overlay) => overlay.type === 'audio' && overlay.id === 'voice')).toMatchObject({ path: '/voice-v2.wav' })
    expect(overlays.some((overlay) => overlay.type === 'text' && overlay.text === 'Old line')).toBe(false)
    expect(overlays.some((overlay) => overlay.type === 'text' && overlay.narrationId === 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' && overlay.text === 'New line')).toBe(true)
    expect(overlays.find((overlay) => overlay.id === 'other-section')).toEqual(other)
    expect(overlays.find((overlay) => overlay.id === 'other-caption')).toEqual(otherCaption)
    expect(overlays.find((overlay) => overlay.id === 'user-text')).toEqual(userText)
  })

  it('undoes and redoes generated audio and its captions as one atomic effect', () => {
    install(draft)
    install({ ...generated, subtitleLines: [{ start: 0.4, end: 1, text: 'Please wait.' }] }, 'voice', '/original.wav')
    const store = useEditorStore.getState()
    const applied = store.session?.overlays
    expect(applied).toHaveLength(2)
    expect(useEditorStore.getState().history).toHaveLength(1)
    store.undo()
    expect(useEditorStore.getState().session?.overlays).toEqual([])
    store.redo()
    expect(useEditorStore.getState().session?.overlays).toEqual(applied)
  })

  it('removing a generated audio owner also removes only its captions', () => {
    install({ ...generated, subtitleLines: [{ start: 0.4, end: 1, text: 'Generated line' }] })
    const state = useEditorStore.getState()
    if (!state.session) throw new Error('Missing fixture session')
    const userText = { ...defaultTextOverlay(6, 20), id: 'user-text', text: 'Keep this edit' }
    useEditorStore.setState({ session: { ...state.session, overlays: [...state.session.overlays, userText] } })
    useEditorStore.getState().removeSelectedOverlay()
    const overlays = useEditorStore.getState().session?.overlays ?? []
    expect(overlays).toEqual([userText])
  })

  it('keeps split captions range-local when regenerating and removing one shared-draft section', () => {
    const draftId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const left: AudioOverlay = { ...generated, id: 'left', path: '/left.wav', start: 0, duration: 5,
      narration: { draftId, enabled: true } }
    const right: AudioOverlay = { ...generated, id: 'right', path: '/right-old.wav', start: 5, duration: 5,
      narration: { draftId, enabled: true } }
    const leftCaption = { ...defaultTextOverlay(0.8, 10), id: 'left-caption', text: 'Left section', narrationId: draftId }
    const rightCaption = { ...defaultTextOverlay(5.8, 11), id: 'right-caption', text: 'Old right section', narrationId: draftId }
    const state = useEditorStore.getState()
    if (!state.session) throw new Error('Missing fixture session')
    useEditorStore.setState({ session: { ...state.session, overlays: [left, leftCaption, right, rightCaption], selectedOverlayId: 'right' }, history: [], future: [] })
    install({ ...right, path: '/right-new.wav', subtitleLines: [{ start: 0.4, end: 1, text: 'New right section' }] }, 'right')
    const regenerated = useEditorStore.getState().session?.overlays ?? []
    expect(regenerated.find((overlay) => overlay.id === 'left')).toEqual(left)
    expect(regenerated.find((overlay) => overlay.id === 'left-caption')).toEqual(leftCaption)
    expect(regenerated.find((overlay) => overlay.id === 'right')).toMatchObject({ path: '/right-new.wav' })
    expect(regenerated.find((overlay) => overlay.id === 'right-caption')).toBeUndefined()
    expect(regenerated.find((overlay) => overlay.type === 'text' && overlay.text === 'New right section')).toMatchObject({
      narrationId: draftId, start: 5.4
    })
    useEditorStore.getState().removeSelectedOverlay()
    expect(useEditorStore.getState().session?.overlays).toEqual([left, leftCaption])
  })

  it('accepts sample-adjacent sections despite fractional timestamp rounding', () => {
    install({ ...draft, start: 0.1, duration: 0.2 })
    expect(() => install({ ...generated, id: 'next', start: 0.3, duration: 1 })).not.toThrow()
    expect(useEditorStore.getState().session?.overlays).toHaveLength(2)
    expect(() => install({ ...generated, id: 'overlap', start: 0.29, duration: 1 })).toThrow('overlapping Re-voice')
  })

  it('undoes the initial effect in one step and redoes its exact cached audio', () => {
    install(draft)
    const store = useEditorStore.getState()
    store.beginOverlayGesture()
    for (let index = 0; index < 100; index++) store.updateOverlayGesture('voice', {
      narration: { ...draft.narration, draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: false, revisions: [`Edit ${index}`] }
    })
    store.commitOverlayGesture()
    expect(useEditorStore.getState().history).toHaveLength(2)
    install(generated, 'voice', '/original.wav')
    const applied = useEditorStore.getState().session
    expect(applied?.overlays).toEqual([{ ...generated, id: 'voice' }])
    expect(useEditorStore.getState().history).toHaveLength(1)
    store.undo()
    expect(useEditorStore.getState().session?.overlays).toEqual([])
    store.redo()
    expect(useEditorStore.getState().session?.overlays).toEqual(applied?.overlays)
  })

  it('restores the previous generated version after recognizing and generating again', () => {
    install(draft)
    install(generated, 'voice', '/original.wav')
    const first = useEditorStore.getState().session?.overlays
    install({ ...draft, path: '/new-original.wav' }, 'voice')
    install({ ...generated, path: '/voice-v2.wav' }, 'voice', '/new-original.wav')
    const second = useEditorStore.getState().session?.overlays
    expect(useEditorStore.getState().history).toHaveLength(2)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.overlays).toEqual(first)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session?.overlays).toEqual(second)
  })

  it('preserves unrelated edits instead of collapsing them into narration', () => {
    install(draft)
    useEditorStore.getState().setPlayhead(5)
    useEditorStore.getState().addMark()
    install(generated, 'voice', '/original.wav')
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session).toMatchObject({ marks: [5], overlays: [{ path: '/original.wav' }] })
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session).toMatchObject({ marks: [], overlays: [{ path: '/original.wav' }] })
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.overlays).toEqual([])
  })

  it('retains applied Undo/Redo across a saved-project round trip', async () => {
    install(draft)
    install(generated, 'voice', '/original.wav')
    const state = useEditorStore.getState()
    if (!state.session) throw new Error('Missing fixture session')
    const restored = await restoredEditorState(parseSavedSession(savedSession(state.session, state.history, state.future)))
    useEditorStore.setState(restored)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.overlays).toEqual([])
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session?.overlays).toEqual([{ ...generated, id: 'voice' }])
  })

  it('rejects stale or overlapping results without changing history', () => {
    const initial = useEditorStore.getState()
    const startedWith = initial.session
    if (!startedWith) throw new Error('Missing fixture session')
    expect(() => install(generated, 'missing', '/original.wav')).toThrow('project changed')
    install(draft)
    expect(() => install({ ...draft, id: 'overlap' })).toThrow('overlapping Re-voice')
    const state = useEditorStore.getState()
    expect(() => installNarrationResult(state, { ...startedWith, segments: [] }, generated, 'voice')).toThrow('project changed')
    expect(useEditorStore.getState().history).toHaveLength(1)
  })
})
