import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FaceBlurEffect, FaceBlurSettings, MediaMetadata } from '@shared/types'
import { useEditorStore } from './store'
import { savedSession } from './store-session'
import { replaceFaceBlurRange, removeFaceBlurById, updateFaceBlurById } from './face-blur'
import { insertOutputGap, createSession } from './timeline'
import { applySpeedToOutputRange } from './speed'
import { insertFreezeFrame, removeFreezeFrame } from './freeze'
import { insertReplay, removeReplayAtPlayhead } from './replay'

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

const settings: FaceBlurSettings = {
  sensitivity: 0.7,
  detail: 'standard',
  holdSeconds: 0.25,
  strength: 0.8,
  style: 'blur'
}

function effect(id: string, start: number, duration: number): FaceBlurEffect {
  return { ...settings, id, start, duration }
}

describe('face blur ranges', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'otc', {
      value: { waveform: vi.fn().mockResolvedValue([]) }, configurable: true
    })
    useEditorStore.setState({ session: null, history: [], future: [] })
  })

  it('replaces an overlap while preserving both outside pieces', () => {
    const result = replaceFaceBlurRange([effect('old', 2, 8)], 4, 6, { ...settings, style: 'pixelate' })
    expect(result).toHaveLength(3)
    expect(result.map(({ start, duration, style }) => ({ start, duration, style }))).toEqual([
      { start: 2, duration: 2, style: 'blur' },
      { start: 4, duration: 2, style: 'pixelate' },
      { start: 6, duration: 4, style: 'blur' }
    ])
    expect(new Set(result.map(({ id }) => id)).size).toBe(3)
  })

  it('orders reversed ranges and ignores an effectively empty replacement', () => {
    const original = [effect('old', 2, 2)]
    expect(replaceFaceBlurRange(original, 6, 4, { ...settings, style: 'pixelate' }).map(({ start, duration, style }) => ({ start, duration, style }))).toEqual([
      { start: 2, duration: 2, style: 'blur' },
      { start: 4, duration: 2, style: 'pixelate' }
    ])
    expect(replaceFaceBlurRange(original, 4, 4.00005, settings)).toBe(original)
  })

  it('does not retain a right fragment when replacement reaches its end', () => {
    const result = replaceFaceBlurRange([effect('old', 2, 2)], 3, 4, settings)
    expect(result.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 2, duration: 1 },
      { start: 3, duration: 1 }
    ])
  })

  it('keeps legacy sessions without optional face ranges through timing edits', () => {
    const legacy = createSession(metadata)
    delete legacy.faceBlurs
    expect(insertOutputGap(legacy, 2, 1).faceBlurs).toBeUndefined()
    expect(applySpeedToOutputRange(legacy, 0, 2, 0.5).faceBlurs).toBeUndefined()
    const frozen = insertFreezeFrame(legacy, 2, 1)
    expect(frozen.faceBlurs).toBeUndefined()
    const freezeId = frozen.segments.find((segment) => segment.kind === 'freeze')?.id
    if (!freezeId) throw new Error('legacy freeze segment missing')
    expect(removeFreezeFrame(frozen, freezeId).faceBlurs).toBeUndefined()

    const replayed = insertReplay(legacy, 2, 4)
    expect(replayed.faceBlurs).toBeUndefined()
    replayed.playhead = 5
    expect(removeReplayAtPlayhead(replayed).faceBlurs).toBeUndefined()
  })

  it('applies to the selected partition and to the whole timeline without a selection', () => {
    const session = createSession(metadata)
    session.marks = [2, 5]
    session.playhead = 3
    useEditorStore.setState({ session, history: [], future: [] })

    useEditorStore.getState().applyFaceBlur(settings)
    expect(useEditorStore.getState().session?.faceBlurs?.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 2, duration: 3 }
    ])
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.faceBlurs).toEqual([])
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session?.faceBlurs).toHaveLength(1)
    const selected = useEditorStore.getState().session?.faceBlurs?.[0]
    if (!selected) throw new Error('selected face blur missing')

    useEditorStore.getState().removeFaceBlur(selected.id)
    expect(useEditorStore.getState().session?.faceBlurs).toEqual([])
  })

  it('applies the whole timeline when no marked partition is selected', () => {
    const session = createSession(metadata)
    useEditorStore.setState({ session, history: [], future: [] })
    useEditorStore.getState().applyFaceBlur(settings)
    expect(useEditorStore.getState().session?.faceBlurs?.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 0, duration: 10 }
    ])
  })

  it('includes face blur parameters in saved snapshots', () => {
    const session = createSession(metadata)
    session.faceBlurs = [effect('face', 1, 2)]
    expect(savedSession(session).faceBlurs).toEqual(session.faceBlurs)
  })

  it('rejects a split that would exceed the persisted effect limit', () => {
    const session = createSession(metadata)
    session.faceBlurs = Array.from({ length: 100 }, (_, index) => effect(`face-${index}`, index / 10, 0.1))
    session.marks = [0.05]
    session.playhead = 0.02
    useEditorStore.setState({ session, history: [], future: [], error: null })
    useEditorStore.getState().applyFaceBlur(settings)
    expect(useEditorStore.getState().error).toContain('Face blur limit')
    expect(useEditorStore.getState().session?.faceBlurs).toBe(session.faceBlurs)
  })

  it('rejects replay duplication when copied coverage would exceed the limit', () => {
    const session = createSession(metadata)
    session.faceBlurs = Array.from({ length: 100 }, (_, index) => effect(`face-${index}`, 2 + index * 0.02, 0.02))
    session.marks = [2, 4]
    session.playhead = 3
    useEditorStore.setState({ session, history: [], future: [], error: null })
    useEditorStore.getState().insertReplay()
    expect(useEditorStore.getState().error).toContain('Face blur limit')
    expect(useEditorStore.getState().session).toBe(session)
  })

  it('ripples through insertion, speed, freeze, replay, and removal edits', () => {
    const initial = createSession(metadata)
    initial.faceBlurs = [effect('blur', 2, 4)]
    const inserted = insertOutputGap(initial, 4, 2)
    expect(inserted.faceBlurs?.[0]).toMatchObject({ start: 2, duration: 6 })

    const sped = applySpeedToOutputRange(initial, 0, 5, 0.5)
    expect(sped.faceBlurs?.[0]).toMatchObject({ start: 4, duration: 7 })

    const cutSession = createSession(metadata)
    cutSession.faceBlurs = [effect('blur', 2, 8)]
    cutSession.marks = [5]
    cutSession.playhead = 7
    useEditorStore.setState({ session: cutSession, history: [], future: [] })
    useEditorStore.getState().removeMarked()
    expect(useEditorStore.getState().session?.faceBlurs?.[0]).toMatchObject({ start: 2, duration: 3 })

    const frozen = insertFreezeFrame(initial, 3, 1)
    expect(frozen.faceBlurs?.[0]).toMatchObject({ start: 2, duration: 5 })
    const freezeId = frozen.segments.find((segment) => segment.kind === 'freeze')?.id
    if (!freezeId) throw new Error('freeze segment missing')
    expect(removeFreezeFrame(frozen, freezeId).faceBlurs?.[0]).toMatchObject({ start: 2, duration: 4 })

    const boundaryFreeze = createSession(metadata)
    boundaryFreeze.faceBlurs = [effect('end', 1, 1)]
    const frozenAtEnd = insertFreezeFrame(boundaryFreeze, 2, 1)
    expect(frozenAtEnd.faceBlurs?.[0]).toMatchObject({ start: 1, duration: 2 })

    const replaySession = createSession(metadata)
    replaySession.faceBlurs = [effect('blur', 0, 10)]
    replaySession.marks = [2, 4]
    replaySession.playhead = 3
    const replayed = insertReplay(replaySession, 2, 4)
    expect(replayed.faceBlurs?.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 0, duration: 4 },
      { start: 4, duration: 4 },
      { start: 8, duration: 6 }
    ])
    replayed.playhead = 5
    const restored = removeReplayAtPlayhead(replayed)
    expect(restored.faceBlurs?.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 0, duration: 4 },
      { start: 4, duration: 6 }
    ])

    const boundarySession = createSession(metadata)
    boundarySession.faceBlurs = [effect('boundary', 2, 1)]
    const boundaryReplay = insertReplay(boundarySession, 2, 4)
    expect(boundaryReplay.faceBlurs?.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 2, duration: 1 },
      { start: 4, duration: 2 }
    ])
  })

  it('splits crossing coverage before copying every selected replay intersection', () => {
    const session = createSession(metadata)
    session.faceBlurs = [effect('before-and-after', 3, 3), effect('earlier', 0, 2)]

    const replayed = insertReplay(session, 0, 5)
    const ranges = replayed.faceBlurs?.map(({ start, duration }) => ({ start, duration }))

    expect(ranges).toEqual([
      { start: 0, duration: 2 },
      { start: 3, duration: 2 },
      { start: 5, duration: 4 },
      { start: 11, duration: 4 },
      { start: 15, duration: 1 }
    ])
    expect(ranges?.every((range, index) => index === 0 || range.start >= (ranges[index - 1]?.start ?? 0) + (ranges[index - 1]?.duration ?? 0) - 0.0001)).toBe(true)
  })

  it('extends the covering face range when a freeze starts at its boundary', () => {
    const session = createSession(metadata)
    session.faceBlurs = [effect('face', 5, 5)]
    const frozen = insertFreezeFrame(session, 5, 3)
    expect(frozen.faceBlurs?.map(({ start, duration }) => ({ start, duration }))).toEqual([
      { start: 5, duration: 8 }
    ])
  })

  it('prefers the range covering an adjacent freeze boundary', () => {
    const session = createSession(metadata)
    session.faceBlurs = [
      { ...effect('before', 0, 5), style: 'pixelate' },
      { ...effect('after', 5, 5), style: 'mask' }
    ]
    const frozen = insertFreezeFrame(session, 5, 3)
    expect(frozen.faceBlurs?.map(({ start, duration, style }) => ({ start, duration, style }))).toEqual([
      { start: 0, duration: 5, style: 'pixelate' },
      { start: 5, duration: 8, style: 'mask' }
    ])
  })

  it('removes only the requested effect ID', () => {
    const effects = [effect('first', 0, 1), effect('second', 2, 1)]
    expect(removeFaceBlurById(effects, 'first').map(({ id }) => id)).toEqual(['second'])
    expect(removeFaceBlurById(effects, 'missing')).toBe(effects)
  })

  it('updates settings without changing an effect ID or range', () => {
    const effects = [effect('first', 1, 3), effect('second', 5, 2)]
    const updated = updateFaceBlurById(effects, 'first', { ...settings, style: 'mask' })
    expect(updated).toEqual([
      { ...settings, style: 'mask', id: 'first', start: 1, duration: 3 },
      effects[1]
    ])
    expect(updateFaceBlurById(effects, 'missing', settings)).toBe(effects)
    expect(updateFaceBlurById(effects, 'first', settings)).toBe(effects)
  })

  it('updates a face range as one undoable edit and ignores a missing ID', () => {
    const session = createSession(metadata)
    session.faceBlurs = [effect('face', 1, 3)]
    useEditorStore.setState({ session, history: [], future: [], error: null })

    useEditorStore.getState().updateFaceBlurSettings('face', { ...settings, style: 'mask', strength: 0.4 })
    const updated = useEditorStore.getState().session?.faceBlurs?.[0]
    expect(updated).toMatchObject({ id: 'face', start: 1, duration: 3, style: 'mask', strength: 0.4 })
    expect(useEditorStore.getState().history).toHaveLength(1)

    const currentSession = useEditorStore.getState().session
    useEditorStore.getState().updateFaceBlurSettings('missing', { ...settings, style: 'pixelate' })
    expect(useEditorStore.getState().session).toBe(currentSession)
    expect(useEditorStore.getState().history).toHaveLength(1)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().session?.faceBlurs).toEqual([effect('face', 1, 3)])
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().session?.faceBlurs?.[0]).toMatchObject({ id: 'face', start: 1, duration: 3, style: 'mask', strength: 0.4 })
  })
})
