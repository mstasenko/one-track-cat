import { describe, expect, it } from 'vitest'
import type { MediaMetadata } from '@shared/types'
import { stepOutputFrame } from './frame'
import { createSession } from './timeline'

const source: MediaMetadata = { path: '/v.mp4', name: 'v.mp4', size: 1, modifiedAt: 1, duration: 1, width: 10, height: 10, fps: 60, videoCodec: 'h264', hasAudio: false }

describe('output frame stepping', () => {
  it('moves on the frame grid and clamps to the timeline', () => {
    const session = createSession(source)
    expect(stepOutputFrame(session, 1, 0)).toBeCloseTo(1 / 60)
    expect(stepOutputFrame(session, -1, 0)).toBe(0)
    expect(stepOutputFrame(session, 1, 1)).toBe(1)
  })

  it('skips repeated output frames in slow or low-FPS video', () => {
    const slowed = createSession(source)
    const segment = slowed.segments[0]
    if (!segment || segment.kind === 'freeze') throw new Error('video segment missing')
    slowed.segments[0] = { ...segment, playbackRate: 0.5 }
    expect(stepOutputFrame(slowed, 1, 0)).toBeCloseTo(2 / 60)
    expect(stepOutputFrame(slowed, -1, 2 / 60)).toBeCloseTo(1 / 60)

    const lowFps = createSession({ ...source, fps: 30 })
    lowFps.canvas.fps = 60
    expect(stepOutputFrame(lowFps, 1, 0)).toBeCloseTo(2 / 60)
  })

  it('still advances one output frame while inside a freeze', () => {
    const session = createSession(source)
    const sourceId = session.sources[0]?.id ?? ''
    session.segments = [{ kind: 'freeze', id: 'freeze', sourceId, sourceTime: 0.5, duration: 1 }]
    expect(stepOutputFrame(session, 1, 0)).toBeCloseTo(1 / 60)
  })
})
