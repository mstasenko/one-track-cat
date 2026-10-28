import { describe, expect, it } from 'vitest'
import type { MediaMetadata } from '@shared/types'
import { defaultTextOverlay, createSession } from './timeline'
import { useEditorStore } from './store'
import { patchedOverlaySession, restoredEditorState, savedSession } from './store-session'

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

function sessionWithOverlays() {
  const session = createSession(metadata)
  session.overlays = [defaultTextOverlay(0, 1), defaultTextOverlay(4, 2)]
  return session
}

describe('overlay session patches', () => {
  it('returns the existing session for clamped no-ops and missing IDs', () => {
    const session = sessionWithOverlays()
    const target = session.overlays[0]
    if (target?.type !== 'text') throw new Error('test text overlay missing')

    expect(patchedOverlaySession(session, target.id, { start: -1 })).toBe(session)
    expect(patchedOverlaySession(session, 'missing-overlay', { text: 'ignored' })).toBe(session)
  })

  it('keeps generated subtitles unselectable and immutable through ordinary editing', () => {
    const session = sessionWithOverlays()
    const caption = { ...defaultTextOverlay(0, 3), narrationId: 'draft-1' }
    session.overlays.push(caption)
    session.selectedOverlayId = session.overlays[0]?.id ?? null
    useEditorStore.setState({ session, history: [], future: [] })
    useEditorStore.getState().selectOverlay(caption.id)
    expect(useEditorStore.getState().session?.selectedOverlayId).toBe(session.selectedOverlayId)
    expect(patchedOverlaySession(session, caption.id, { text: 'Changed', start: 2 })).toBe(session)
  })

  it('clears saved subtitle selections in the project and Undo/Redo snapshots', async () => {
    const session = sessionWithOverlays()
    const caption = { ...defaultTextOverlay(0, 3), narrationId: 'draft-1' }
    session.overlays.push(caption)
    session.selectedOverlayId = caption.id
    Object.defineProperty(window, 'otc', { configurable: true,
      value: { getPathUrl: (path: string) => Promise.resolve(`media:${path}`) } })
    const restored = await restoredEditorState(savedSession(session, [session], [session]))
    expect([restored.session, ...restored.history, ...restored.future].map((snapshot) => snapshot.selectedOverlayId))
      .toEqual([null, null, null])
    expect(restored.session.overlays).toContainEqual(caption)
  })

  it('copies only the edited overlay and retains unrelated identity', () => {
    const session = sessionWithOverlays()
    const target = session.overlays[0]
    const unrelated = session.overlays[1]
    if (target?.type !== 'text' || unrelated?.type !== 'text') {
      throw new Error('test text overlays missing')
    }

    const patched = patchedOverlaySession(session, target.id, { text: 'Edited' })

    expect(patched).not.toBe(session)
    expect(patched.overlays).not.toBe(session.overlays)
    expect(patched.overlays[0]).not.toBe(target)
    const patchedTarget = patched.overlays[0]
    if (patchedTarget?.type !== 'text') throw new Error('patched text overlay missing')
    expect(patchedTarget.text).toBe('Edited')
    expect(patched.overlays[1]).toBe(unrelated)
    expect(session.overlays[0]).toBe(target)
    expect(target.text).toBe('Your text')
  })
})
