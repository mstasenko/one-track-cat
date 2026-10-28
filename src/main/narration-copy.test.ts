import { describe, expect, it } from 'vitest'
import type { ExportRequest } from '../types'
import { narrationCopyArgs } from './narration-copy'
import { validateNarrationOverlay } from './narration-validation'

function project(): ExportRequest {
  return { canvas: { width: 1280, height: 720, fps: 30, fit: 'contain' }, outputPath: '/output.mp4',
    sources: [{ id: 's', metadata: { path: '/source.mp4', name: 'source', size: 1, modifiedAt: 1, duration: 10,
      width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true } }],
    segments: [{ id: 'v', sourceId: 's', sourceStart: 0, sourceEnd: 10 }],
    overlays: [{ id: 'n', type: 'audio', name: 'AI Narration', path: '/mix.wav', sourceIn: 0, start: 1, duration: 8,
      volume: 1, zIndex: 0, narration: { draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true } }] }
}
describe('Narration video preservation', () => {
  it('copies unchanged video, replaces audio, and strips source metadata', () => {
    const args = narrationCopyArgs(project(), '/temp.mp4')
    expect(args).toContain('copy')
    expect(args).toContain('0:v:0')
    expect(args).toContain('-map_metadata:g')
    expect(args).toContain('/mix.wav')
    expect(args).not.toContain('-r')
  })
  it('keeps the normal video renderer for crops, zooms, rate changes, and visual edits', () => {
    const request = project()
    expect(narrationCopyArgs({ ...request, canvas: { ...request.canvas, width: 720 } }, '/temp.mp4')).toBeNull()
    expect(narrationCopyArgs({ ...request, upscale: {} }, '/temp.mp4')).toBeNull()
    expect(narrationCopyArgs({ ...request, focusZooms: [{ id: 'z', start: 1, duration: 1, zoom: 3, focusX: 0.5, focusY: 0.5 }] }, '/temp.mp4')).toBeNull()
    expect(narrationCopyArgs({ ...request, overlays: [] }, '/temp.mp4')).toBeNull()
    expect(narrationCopyArgs({ ...request, segments: [{ id: 'v', sourceId: 's', sourceStart: 1, sourceEnd: 10 }] }, '/temp.mp4')).toBeNull()
  })
  it('validates persisted narration settings without permitting level changes or path-like IDs', () => {
    expect(() => validateNarrationOverlay({ volume: 1, narration: { draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true, revisions: ['Wait.'] } })).not.toThrow()
    expect(() => validateNarrationOverlay({ volume: 1 })).not.toThrow()
    for (const narration of [null, [], { draftId: '../outside', enabled: true }, { draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: 'yes' }]) {
      expect(() => validateNarrationOverlay({ volume: 1, narration })).toThrow()
    }
    const narration = { draftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true }
    expect(() => validateNarrationOverlay({ volume: 1, narration: { ...narration, revisions: [4] } })).toThrow('revisions')
    expect(() => validateNarrationOverlay({ volume: 2, narration })).toThrow('background level')
  })
})
