import { describe, expect, it } from 'vitest'
import type { MediaMetadata, SavedSessionSnapshot } from '@shared/types'
import { parseSavedSession } from '../../../main/validation'
import { applySpeedToOutputRange } from './speed'
import { savedSession } from './store-session'
import { createSession } from './timeline'

const source: MediaMetadata = {
  path: '/video.mp4', name: 'video.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1920, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: true
}

function expectFitted(snapshot: SavedSessionSnapshot): void {
  const transition = snapshot.videoTransitions?.[0]
  if (!transition) throw new Error('saved video transition missing')
  expect(transition.duration).toBeGreaterThan(0)
  expect(transition.into?.duration).toBeLessThanOrEqual(transition.duration)
  expect(transition.out?.duration).toBeLessThanOrEqual(transition.duration)
}

describe('video range transition persistence', () => {
  it('fits a full-range fade after speeding the timeline before save validation', () => {
    const session = createSession(source)
    session.videoTransitions = [{
      id: 'full-range', start: 0, duration: 10,
      into: { effect: 'fade', duration: 10 }
    }]

    const sped = applySpeedToOutputRange(session, 0, 10, 2)
    expect(sped.videoTransitions?.[0]).toMatchObject({ duration: 5, into: { duration: 10 } })

    const saved = savedSession(sped)
    expect(saved.videoTransitions?.[0]).toMatchObject({ duration: 5, into: { duration: 5 } })

    const parsed = parseSavedSession(saved)
    expect(parsed.videoTransitions?.[0]).toMatchObject({
      start: 0,
      duration: 5,
      into: { effect: 'fade', duration: 5 }
    })
  })

  it('keeps a sub-threshold range positive and normalizes stale undo and redo edges', () => {
    const session = createSession(source)
    session.videoTransitions = [{
      id: 'tiny-range', start: 0, duration: 0.04,
      into: { effect: 'fade', duration: 10 },
      out: { effect: 'dissolve', duration: 10 }
    }]

    const saved = savedSession(session, [session], [session])
    for (const snapshot of [saved, ...(saved.history ?? []), ...(saved.future ?? [])]) {
      expectFitted(snapshot)
    }

    const parsed = parseSavedSession(saved)
    const snapshots = [parsed, ...(parsed.history ?? []), ...(parsed.future ?? [])]

    expect(snapshots).toHaveLength(3)
    for (const snapshot of snapshots) {
      expectFitted(snapshot)
      expect(snapshot.videoTransitions?.[0]?.duration).toBeLessThan(0.05)
    }
  })
})
