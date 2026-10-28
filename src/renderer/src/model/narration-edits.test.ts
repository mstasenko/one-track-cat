import { describe, expect, it } from 'vitest'
import type { AudioOverlay } from '@shared/types'
import { parseSavedSession } from '../../../main/validation'
import { createSession, removeOutputRange } from './timeline'
import { savedSession } from './store-session'
import { applySpeedToOutputRange } from './speed'
import { insertReplay } from './replay'

const overlay: AudioOverlay = { id: 'voice', type: 'audio', name: 'AI Narration', path: '/voice.wav', sourceIn: 0,
  start: 1, duration: 8, volume: 1, zIndex: 0,
  narration: { draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true, revisions: ['Please wait.'],
    originals: ['Um, please wait.'], voiceStyle: 'cosy' } }
function project() {
  return { ...createSession({ path: '/video.mp4', name: 'video', size: 1, modifiedAt: 1, width: 1280, height: 720,
    duration: 10, fps: 30, videoCodec: 'h264', hasAudio: true }), overlays: [overlay] }
}
describe('Narration editing', () => {
  it('preserves reviewed text, media references, and Original/AI choice in saved projects', () => {
    const session = project()
    expect(parseSavedSession(savedSession(session)).overlays).toEqual([overlay])
    const bad = { ...overlay, narration: { ...overlay.narration, voiceStyle: 'unknown' } }
    expect(() => parseSavedSession({ ...savedSession(session), overlays: [bad] })).toThrow('voice style')
  })
  it('persists source-relative transcript edits through later cuts', () => {
    const edited: AudioOverlay = { ...overlay, narration: { ...overlay.narration, draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true, transcriptRange: [0, 8] as [number, number] } }
    const session = { ...project(), overlays: [edited] }
    expect(parseSavedSession(savedSession(session)).overlays).toEqual([edited])
    const cut = removeOutputRange(session.segments, session.overlays, 3, 4)
    expect(cut.overlays.every((item) => item.type === 'audio' && item.narration?.transcriptRange?.[1] === 8)).toBe(true)
    for (const transcriptRange of [[-1, 8], [1, 1], [0, Infinity]]) {
      expect(() => parseSavedSession({ ...savedSession(session), overlays: [{ ...edited,
        narration: { ...edited.narration, transcriptRange } }] })).toThrow('transcript range')
    }
  })
  it('trims/ripples generated audio through cuts without rerunning inference', () => {
    const session = project()
    const cut = removeOutputRange(session.segments, session.overlays, 0, 2)
    expect(cut.overlays[0]).toMatchObject({ start: 0, sourceIn: 1, duration: 7, narration: overlay.narration })
  })
  it('does not copy narration into Replay or stretch it through the repeated footage', () => {
    const replayed = insertReplay(project(), 2, 4)
    const narration = replayed.overlays.filter((item) => item.type === 'audio')
    expect(narration).toHaveLength(2)
    const first = narration[0]
    const second = narration[1]
    expect(first).toMatchObject({ start: 1, duration: 3, sourceIn: 0 })
    expect(second).toMatchObject({ start: 8, duration: 5, sourceIn: 3 })
  })
  it('disables outdated narration after a speed edit and requires reanalysis before enabling it', () => {
    const updated = applySpeedToOutputRange(project(), 2, 4, 2)
    expect(updated.overlays[0]).toMatchObject({ narration: { enabled: false, invalidated: true } })
    expect(() => parseSavedSession(savedSession(updated))).not.toThrow()
    expect(() => parseSavedSession(savedSession(applySpeedToOutputRange(project(), 0, 10, 4)))).not.toThrow()
    const stale = { ...overlay, narration: { ...overlay.narration, draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true, invalidated: true } }
    expect(() => parseSavedSession(savedSession({ ...updated, overlays: [stale] }))).toThrow('Reanalyze')
  })
})
