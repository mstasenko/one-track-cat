import { describe, expect, it } from 'vitest'
import type { EditSession, SourceSegment, TimelineSource, VideoSegment } from '@shared/types'
import type { TimelinePosition } from '../model/timeline'
import {
  overlayNeedsResync,
  overlaySyncTolerances,
  previewMediaVolume,
  secondaryPreviewMedia,
  type SecondaryPreviewMedia
} from './preview-media'

const source = (id: string, path: string): TimelineSource => ({
  id,
  metadata: {
    path, name: path.slice(1), size: 1, modifiedAt: 1, duration: 20,
    width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true
  },
  playbackPath: path,
  waveform: []
})

const video = (id: string, sourceId: string, sourceStart: number, sourceEnd: number, transition?: VideoSegment['transition']): VideoSegment => ({
  id, sourceId, sourceStart, sourceEnd, ...(transition ? { transition } : {})
})

const freeze = (id: string, sourceId: string, sourceTime: number, duration: number): SourceSegment => ({
  kind: 'freeze', id, sourceId, sourceTime, duration
})

function session(segments: SourceSegment[], sources: TimelineSource[] = [source('a', '/a.mp4'), source('b', '/b.mp4')]): EditSession {
  return {
    canvas: { width: 320, height: 180, fps: 30, fit: 'contain' },
    sources, segments, overlays: [], selectedOverlayId: null,
    playhead: 0, marks: [], focusZooms: [], faceBlurs: [], videoTransitions: []
  }
}

function at(segments: SourceSegment[], segmentIndex: number, sourceTime: number): TimelinePosition {
  const segment = segments[segmentIndex]
  if (!segment) throw new Error('test segment missing')
  return { segmentIndex, segment, outputStart: 0, sourceTime }
}

type MediaCase = [
  string,
  EditSession,
  TimelinePosition | null,
  boolean,
  number,
  SecondaryPreviewMedia
]

const current = video('current', 'a', 0, 5)
const next = video('next', 'b', 10, 20)
const plainSegments = [current, next]
const nextFreeze = freeze('next-freeze', 'b', 6, 2)
const sameSourceNext = video('same-next', 'a', 5, 8)
const missingSourceNext = video('missing-next', 'missing', 10, 20)
const transition = { effect: 'fade' as const, duration: 1 }
const transitionNext = video('transition-next', 'b', 10, 20, transition)
const fastCurrent = { ...video('fast-current', 'a', 0, 8), playbackRate: 2 as const }

const mediaCases: MediaCase[] = [
  ['no position', session([]), null, false, 2, { path: '', time: 0, rate: 0 }],
  ['next plain clip', session(plainSegments), at(plainSegments, 0, 4), false, 4, { path: '/b.mp4', time: 10, rate: 0 }],
  ['next freeze clip', session([current, nextFreeze]), at([current, nextFreeze], 0, 4), false, 4, { path: '/b.mp4', time: 6, rate: 0 }],
  ['next clip from the same source', session([current, sameSourceNext], [source('a', '/a.mp4')]), at([current, sameSourceNext], 0, 4), false, 4, { path: '/a.mp4', time: 5, rate: 0 }],
  ['missing next source', session([current, missingSourceNext]), at([current, missingSourceNext], 0, 4), false, 4, { path: '/a.mp4', time: 4, rate: 0 }],
  ['transition warmup at normal speed', session([current, transitionNext]), at([current, transitionNext], 0, 4), false, 4, { path: '/a.mp4', time: 4, rate: 1 }],
  ['transition mid-clip at normal speed', session([current, transitionNext]), at([current, transitionNext], 0, 2), false, 2, { path: '/a.mp4', time: 2, rate: 0 }],
  ['transition warmup at 2x speed', session([fastCurrent, transitionNext]), at([fastCurrent, transitionNext], 0, 6), false, 6, { path: '/a.mp4', time: 6, rate: 2 }],
  ['current freeze clip', session([freeze('current-freeze', 'a', 2, 2)]), at([freeze('current-freeze', 'a', 2, 2)], 0, 2), false, 2, { path: '/a.mp4', time: 2, rate: 0 }],
  ['waiting for the current frame', session(plainSegments), at(plainSegments, 0, 4), true, 1.25, { path: '/a.mp4', time: 1.25, rate: 1 }],
  ['waiting for a freeze frame', session([freeze('waiting-freeze', 'a', 2, 2)]), at([freeze('waiting-freeze', 'a', 2, 2)], 0, 1.25), true, 1.25, { path: '/a.mp4', time: 1.25, rate: 0 }],
  ['waiting at 2x playback speed', session([fastCurrent, transitionNext]), at([fastCurrent, transitionNext], 0, 6), true, 6.5, { path: '/a.mp4', time: 6.5, rate: 2 }]
]

describe('preview media', () => {
  it('keeps browser volume in its valid range while export gain may exceed one', () => {
    expect(previewMediaVolume(2)).toBe(1)
    expect(previewMediaVolume(0.5)).toBe(0.5)
    expect(previewMediaVolume(-1)).toBe(0)
    expect(previewMediaVolume(Number.NaN)).toBe(1)
  })

  it('corrects overlay drift before short effects become visibly late', () => {
    expect(overlaySyncTolerances.audio).toBe(0.04)
    expect(overlayNeedsResync(1, 1.039, 'audio')).toBe(false)
    expect(overlayNeedsResync(1, 1.041, 'audio')).toBe(true)
    expect(overlayNeedsResync(1, 1.061, 'video-audio')).toBe(true)
    expect(overlayNeedsResync(1, 1.16, 'visual')).toBe(false)
  })

  it.each(mediaCases)('plans secondary media for %s', (_name, currentSession, position, waiting, requestedTime, expected) => {
    expect(secondaryPreviewMedia(currentSession, position, waiting, requestedTime)).toEqual(expected)
  })
})
