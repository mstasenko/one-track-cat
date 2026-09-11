import { describe, expect, it } from 'vitest'
import type { MediaMetadata } from '@shared/types'
import { defaultTextOverlay, createSession } from './timeline'
import { patchedOverlaySession } from './store-session'

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
    if (!target || target.type !== 'text') throw new Error('test text overlay missing')

    expect(patchedOverlaySession(session, target.id, { start: -1 })).toBe(session)
    expect(patchedOverlaySession(session, 'missing-overlay', { text: 'ignored' })).toBe(session)
  })

  it('copies only the edited overlay and retains unrelated identity', () => {
    const session = sessionWithOverlays()
    const target = session.overlays[0]
    const unrelated = session.overlays[1]
    if (!target || target.type !== 'text' || !unrelated || unrelated.type !== 'text') {
      throw new Error('test text overlays missing')
    }

    const patched = patchedOverlaySession(session, target.id, { text: 'Edited' })

    expect(patched).not.toBe(session)
    expect(patched.overlays).not.toBe(session.overlays)
    expect(patched.overlays[0]).not.toBe(target)
    const patchedTarget = patched.overlays[0]
    if (!patchedTarget || patchedTarget.type !== 'text') throw new Error('patched text overlay missing')
    expect(patchedTarget.text).toBe('Edited')
    expect(patched.overlays[1]).toBe(unrelated)
    expect(session.overlays[0]).toBe(target)
    expect(target.text).toBe('Your text')
  })
})
