import { describe, expect, it, vi } from 'vitest'
import { createSession } from './timeline'
import {
  nudgeShortFrame,
  remapShortFramePoints,
  shortFramePointsAfterInsertion,
  shortFramePointsAfterRemoval
} from './short-frame'
import { applySpeedToOutputRange } from './speed'
import { insertFreezeFrame, removeFreezeFrame } from './freeze'
import { insertReplay } from './replay'
import { shortFrameMaxPoints, type ShortFramePoint } from '@shared/types'
import { legacyShortFrameMovesToPoints, shortFramePositionAtTime } from '@shared/short-frame'
import { restoredEditorState, savedSession } from './store-session'
import { parseSavedSession } from '../../../main/validation'

const source = {
  path: '/video.mp4', name: 'video.mp4', size: 1, modifiedAt: 1, duration: 10,
  width: 1920, height: 1080, fps: 60, videoCodec: 'h264', hasAudio: true
}

const points: ShortFramePoint[] = [
  { id: 'first', time: 1, position: 0 },
  { id: 'later', time: 7, position: 1 }
]

describe('Short frame edits', () => {
  it('round-trips distinct framing points in the project, Undo, and Redo snapshots', async () => {
    const session = createSession(source, true)
    session.shortFramePoints = points
    const history = { ...session, shortFramePoints: [{ id: 'old', time: 2, position: 0.4 }] }
    const future = { ...session, shortFramePoints: [{ id: 'next', time: 8, position: 0.7 }] }
    vi.stubGlobal('otc', { getPathUrl: (path: string) => Promise.resolve(path) })
    try {
      const restored = await restoredEditorState(parseSavedSession(savedSession(session, [history], [future])))
      expect(restored.session.shortFramePoints).toEqual(points)
      expect(restored.history[0]?.shortFramePoints).toEqual(history.shortFramePoints)
      expect(restored.future[0]?.shortFramePoints).toEqual(future.shortFramePoints)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('migrates legacy framing in all saved history snapshots without losing their initial position', async () => {
    const saved = savedSession(createSession(source, true))
    delete saved.shortFramePoints
    saved.canvas = { ...saved.canvas, shortFramePosition: 0.3 }
    saved.shortFrameMoves = [{ id: 'old-move', start: 2, duration: 2, direction: 'right' }]
    saved.history = [{ ...saved, canvas: { ...saved.canvas, shortFramePosition: 0.2 } }]
    saved.future = [{ ...saved, canvas: { ...saved.canvas, shortFramePosition: 0.4 } }]
    vi.stubGlobal('otc', { getPathUrl: (path: string) => Promise.resolve(path) })
    try {
      const restored = await restoredEditorState(parseSavedSession(saved))
      expect(shortFramePositionAtTime(restored.session.shortFramePoints ?? [], 0)).toBe(0.3)
      expect(shortFramePositionAtTime(restored.history[0]?.shortFramePoints ?? [], 0)).toBe(0.2)
      expect(shortFramePositionAtTime(restored.future[0]?.shortFramePoints ?? [], 0)).toBe(0.4)
      expect(savedSession(restored.session)).not.toHaveProperty('shortFrameMoves')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('nudges from the interpolated current position and replaces a same-time point', () => {
    const session = createSession(source, true)
    session.shortFramePoints = points
    session.playhead = 4
    const result = nudgeShortFrame(session, 'right')
    expect(result?.shortFramePoints).toEqual([points[0], expect.objectContaining({ time: 4, position: 0.55 }), points[1]])
    expect(typeof result?.shortFramePoints?.[1]?.id).toBe('string')
    const atPoint = { ...session, playhead: 1 }
    const replaced = nudgeShortFrame(atPoint, 'right')
    expect(replaced?.shortFramePoints).toEqual([
      { id: 'first', time: 1, position: 0.05 },
      points[1]
    ])
  })

  it('returns the same session at a clamped edge and rejects only a new point over the cap', () => {
    const edge = createSession(source, true)
    edge.shortFramePoints = [{ id: 'edge', time: 0, position: 0 }]
    expect(nudgeShortFrame(edge, 'left')).toBe(edge)
    const full = createSession(source, true)
    full.shortFramePoints = Array.from({ length: shortFrameMaxPoints }, (_, index) => ({ id: `p${index}`, time: index, position: 0.5 }))
    full.playhead = shortFrameMaxPoints
    expect(nudgeShortFrame(full, 'right')).toBeNull()
  })

  it('keeps points sorted and preserves same-role points through insert/remove remaps', () => {
    expect(shortFramePointsAfterInsertion(points, 4, 2)).toEqual([
      points[0], { ...points[1], time: 9 }
    ])
    expect(shortFramePointsAfterRemoval([
      { id: 'left', time: 1, position: 0 },
      { id: 'removed', time: 2, position: 0.5 },
      { id: 'right', time: 3, position: 1 }
    ], 1, 3)).toEqual([{ id: 'right', time: 1, position: 1 }])
    expect(remapShortFramePoints(points, (time) => time - 2)).toEqual([
      { id: 'first', time: 0, position: 0 }, { id: 'later', time: 5, position: 1 }
    ])
  })

  it('preserves initial framing when inserting a new prefix, including legacy anchors', () => {
    const initial = [{ id: 'initial', time: 0, position: 0.3 }, { id: 'later', time: 2, position: 0.8 }]
    expect(shortFramePointsAfterInsertion(initial, 0, 3)).toEqual([
      initial[0], { ...initial[1], time: 5 }
    ])
    const legacy = legacyShortFrameMovesToPoints([
      { id: 'move', start: 0, duration: 2, direction: 'right' }
    ], 0.3, true)
    const inserted = shortFramePointsAfterInsertion(legacy, 0, 3)
    expect(shortFramePositionAtTime(inserted, 0)).toBe(0.3)
    expect(inserted.at(-1)?.time).toBe(5)
  })

  it('deduplicates a collapsed deletion boundary with the later point winning', () => {
    expect(shortFramePointsAfterRemoval([
      { id: 'before', time: 1, position: 0 },
      { id: 'after', time: 3, position: 1 }
    ], 1, 3)).toEqual([{ id: 'after', time: 1, position: 1 }])
  })

  it('keeps framing aligned through speed and freeze edits', () => {
    const session = createSession(source, true)
    session.shortFramePoints = [{ id: 'move', time: 2, position: 0 }, { id: 'later', time: 6, position: 1 }]
    const sped = applySpeedToOutputRange(session, 0, 4, 2)
    expect(sped.shortFramePoints).toEqual([
      { id: 'move', time: 1, position: 0 }, { id: 'later', time: 4, position: 1 }
    ])

    const frozen = insertFreezeFrame(sped, 0.5, 3)
    expect(frozen.shortFramePoints).toEqual([
      { id: 'move', time: 4, position: 0 }, { id: 'later', time: 7, position: 1 }
    ])
    const freeze = frozen.segments.find((segment) => segment.kind === 'freeze')
    if (!freeze) throw new Error('freeze segment missing')
    expect(removeFreezeFrame(frozen, freeze.id).shortFramePoints).toEqual(sped.shortFramePoints)
  })

  it('ripples existing points through a replay gap without copying them into Replay', () => {
    const session = createSession(source, true)
    session.shortFramePoints = [
      { id: 'before', time: 1, position: 0.2 },
      { id: 'after', time: 5, position: 0.8 }
    ]
    const replayed = insertReplay(session, 2, 4)
    expect(replayed.shortFramePoints).toEqual([
      { id: 'before', time: 1, position: 0.2 },
      { id: 'after', time: 9, position: 0.8 }
    ])
  })
})
