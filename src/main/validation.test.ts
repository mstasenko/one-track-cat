import { describe, expect, it } from 'vitest'
import { mediaAnimationPresets } from '../types'
import { parseDefaultName, parseExportRequest, parseMediaMetadata, parseSavedSession } from './validation'

const metadata = {
  path: '/video.mp4', name: 'video.mp4', size: 10, modifiedAt: 100, duration: 3,
  width: 320, height: 180, fps: 24, videoCodec: 'h264',
  hasAudio: true
}

function savedSnapshot(marks: number[] = [1, 2]): Record<string, unknown> {
  return {
    canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
    sources: [{ id: 'source', metadata }],
    segments: [
      { id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 1 },
      {
        id: 'segment', sourceId: 'source', sourceStart: 1, sourceEnd: 3,
        transition: { effect: 'circleopen', duration: 0.5 }
      }
    ],
    overlays: [], selectedOverlayId: null, playhead: 1, marks,
    videoTransitions: [{ id: 'range-transition', start: 0, duration: 1, into: { effect: 'fade', duration: 0.5 } }]
  }
}

describe('IPC input validation', () => {
  it('accepts bounded media metadata and rejects invalid values', () => {
    expect(parseMediaMetadata(metadata)).toEqual(metadata)
    expect(parseMediaMetadata({ ...metadata, size: 8 * 1024 * 1024 * 1024 }).size).toBe(8 * 1024 * 1024 * 1024)
    expect(() => parseMediaMetadata({ ...metadata, duration: Number.NaN })).toThrow('duration')
    expect(() => parseMediaMetadata({ ...metadata, width: -1 })).toThrow('width')
  })

  it('validates the complete export structure', () => {
    const request = {
      canvas: { width: metadata.width, height: metadata.height, fps: metadata.fps, fit: 'contain' },
      sources: [{ id: 'source', metadata }],
      outputPath: '/edited.mp4',
      segments: [
        { id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 1 },
        {
          id: 'segment', sourceId: 'source', sourceStart: 1, sourceEnd: 3,
          transition: { effect: 'dissolve', duration: 0.65 }
        }
      ],
      overlays: [{
        id: 'audio', type: 'audio', name: 'Effect', path: '/effect.wav',
        start: 1, duration: 1, zIndex: 1, volume: 1, sourceIn: 0.5
      }]
    }
    expect(parseExportRequest(request)).toEqual(request)
    const migratedGlobal = parseExportRequest({
      ...request,
      canvas: { width: 1080, height: 1920, fps: metadata.fps, fit: 'cover', shortFramePosition: 0.45 },
      segments: [{ id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }]
    })
    expect(migratedGlobal.canvas.shortFramePosition).toBeUndefined()
    expect(migratedGlobal.shortFramePoints).toEqual([{ id: 'short-frame-initial', time: 0, position: 0.45 }])
    for (const shortFramePosition of [-0.05, 1.05, Number.NaN]) {
      expect(() => parseExportRequest({ ...request, canvas: { ...request.canvas, shortFramePosition } })).toThrow('Short frame position')
    }
    expect(parseExportRequest({ ...request, aiEnhance: {} })).toMatchObject({ aiEnhance: {} })
    expect(parseExportRequest({ ...request, aiEnhance: { mode: 'turbo' } })).toMatchObject({ aiEnhance: { mode: 'turbo' } })
    expect(parseExportRequest({ ...request, aiEnhance: { mode: 'base' } })).toMatchObject({ aiEnhance: { mode: 'base' } })
    for (const value of [true, false, 'yes', null, [], 1]) {
      expect(() => parseExportRequest({ ...request, aiEnhance: value })).toThrow('AI enhancement')
    }
    for (const value of [
      { mode: 'rife' }, { mode: 'temporal' }, { mode: 'per-frame' }, { mode: null }, { mode: undefined },
      { mode: 60 }, { mode: 'turbo', extra: true }, { spatial: true }
    ]) {
      expect(() => parseExportRequest({ ...request, aiEnhance: value })).toThrow('AI enhancement')
    }
    expect(() => parseExportRequest({
      ...request,
      segments: [{ ...request.segments[0], kind: 'audio' }, request.segments[1]]
    })).toThrow('Segment kind')
    expect(() => parseExportRequest({ ...request, segments: [{ id: 'bad', sourceId: 'source', sourceStart: 2, sourceEnd: 1 }] })).toThrow('positive')
    expect(() => parseExportRequest({
      ...request,
      segments: [request.segments[0], { ...request.segments[1], transition: { effect: 'spin', duration: 1 } }]
    })).toThrow('Transition effect')
    expect(() => parseExportRequest({
      ...request,
      segments: [request.segments[0], { ...request.segments[1], transition: { effect: 'fade', duration: 4 } }]
    })).toThrow('Transition duration')
    expect(() => parseExportRequest({
      ...request,
      segments: [{ ...request.segments[0], transition: { effect: 'fade', duration: 0.5 } }]
    })).toThrow('first timeline segment')
    expect(() => parseExportRequest({
      ...request,
      overlays: [{ ...request.overlays[0], volume: 5 }]
    })).toThrow('volume')
  })

  it('rejects invalid canvases and segment source references', () => {
    const request = {
      canvas: { width: 1080, height: 1920, fps: 24, fit: 'cover' },
      sources: [{ id: 'source', metadata }],
      outputPath: '/edited.mp4',
      segments: [{ id: 'segment', sourceId: 'missing', sourceStart: 0, sourceEnd: 1 }],
      overlays: []
    }
    expect(() => parseExportRequest(request)).toThrow('unknown video source')
    expect(() => parseExportRequest({ ...request, canvas: { ...request.canvas, fit: 'stretch' } })).toThrow('Canvas fit')
    expect(() => parseExportRequest({
      ...request,
      sources: [{ id: 'source', metadata }, { id: 'source', metadata }]
    })).toThrow('unique')
  })

  it('accepts bounded Short frame points and migrates legacy moves only on a Short canvas', () => {
    const request = {
      canvas: { width: 1080, height: 1920, fps: 24, fit: 'cover' },
      sources: [{ id: 'source', metadata }], outputPath: '/short.mp4',
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }], overlays: [],
      shortFramePoints: [
        { id: 'left', time: 0, position: 0 },
        { id: 'right', time: 2, position: 1 }
      ]
    }
    expect(parseExportRequest(request)).toEqual(request)
    expect(() => parseExportRequest({
      ...request,
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' }
    })).toThrow('YouTube Short')
    expect(() => parseExportRequest({
      ...request,
      shortFramePoints: [{ id: 'bad', time: 0, position: 1.1 }]
    })).toThrow('position')
    expect(() => parseExportRequest({
      ...request,
      shortFramePoints: [
        { id: 'one', time: 1, position: 0 },
        { id: 'two', time: 1.00001, position: 1 }
      ]
    })).toThrow('unique times')
    expect(() => parseExportRequest({
      ...request,
      shortFramePoints: Array.from({ length: 202 }, (_, index) => ({ id: `point-${index}`, time: index / 100, position: 0.5 }))
    })).toThrow('at most 201')

    const legacy = parseExportRequest({
      ...request,
      shortFramePoints: undefined,
      shortFrameMoves: [
        { id: 'left', start: 0, duration: 1, direction: 'left' },
        { id: 'right', start: 2, duration: 1, direction: 'right' }
      ]
    })
    expect(legacy.shortFramePoints).toEqual([
      { id: 'short-frame-legacy-0-start', time: 0, position: 0.5 },
      { id: 'short-frame-legacy-0-end', time: 1, position: 0 },
      { id: 'short-frame-legacy-1-start', time: 2, position: 0 },
      { id: 'short-frame-legacy-1-end', time: 3, position: 1 }
    ])
    expect(legacy).not.toHaveProperty('shortFrameMoves')
    const clampedLegacy = parseExportRequest({
      ...request,
      shortFramePoints: undefined,
      shortFrameMoves: [{ id: 'near-end', start: 2.99995, duration: 0.0001, direction: 'right' }]
    })
    expect(clampedLegacy.shortFramePoints?.at(-1)?.time).toBe(3)
    expect(() => parseExportRequest({
      ...request,
      shortFramePoints: undefined,
      shortFrameMoves: [{ id: 'bad', start: 0, duration: 1, direction: 'up' }]
    })).toThrow('direction')
    expect(() => parseExportRequest({
      ...request,
      shortFramePoints: undefined,
      shortFrameMoves: [
        { id: 'one', start: 0, duration: 2, direction: 'left' },
        { id: 'two', start: 1, duration: 1, direction: 'right' }
      ]
    })).toThrow('overlap')
    expect(() => parseExportRequest({
      ...request,
      shortFramePoints: undefined,
      shortFrameMoves: [{ id: 'past-end', start: 2.5, duration: 1, direction: 'right' }]
    })).toThrow('past the timeline')
    expect(() => parseExportRequest({
      ...request,
      shortFramePoints: [{ id: 'point', time: 1, position: 0.5 }],
      canvas: { ...request.canvas, shortFramePosition: 0.5 }
    })).toThrow('combined')
  })

  it('rejects duplicate segment, overlay, and focus zoom IDs', () => {
    const request = {
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
      sources: [{ id: 'source', metadata }],
      outputPath: '/edited.mp4',
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }],
      overlays: [{
        id: 'audio', type: 'audio', name: 'Effect', path: '/effect.wav',
        start: 0, duration: 1, zIndex: 1, volume: 1, sourceIn: 0
      }]
    }
    expect(() => parseExportRequest({
      ...request,
      overlays: [request.overlays[0], { ...request.overlays[0], start: 1 }]
    })).toThrow('Overlay IDs must be unique')
    expect(() => parseExportRequest({
      ...request,
      segments: [request.segments[0], { ...request.segments[0], sourceStart: 1, sourceEnd: 2 }]
    })).toThrow('Timeline segment IDs must be unique')
    const focusZoom = { id: 'zoom', start: 0, duration: 1, zoom: 1.5, focusX: 0.5, focusY: 0.5 }
    expect(() => parseExportRequest({
      ...request,
      focusZooms: [focusZoom, { ...focusZoom, start: 1 }]
    })).toThrow('Focus zoom IDs must be unique')
  })

  it('validates focus zooms and genuine freeze segments', () => {
    const request = {
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
      sources: [{ id: 'source', metadata }], outputPath: '/edited.mp4', overlays: [],
      segments: [{ kind: 'freeze', id: 'freeze', sourceId: 'source', sourceTime: 1, duration: 1, replayGroupId: 'replay-safe_1' }],
      focusZooms: [{ id: 'zoom', start: 0, duration: 1, zoom: 1.5, focusX: 0.75, focusY: 0.25 }]
    }
    expect(parseExportRequest(request)).toEqual(request)
    for (const duration of [0.5, 1, 2, 3, 4, 5]) {
      expect(parseExportRequest({ ...request, segments: [{ ...request.segments[0], duration }], focusZooms: [] }).segments[0]).toMatchObject({ duration })
    }
    for (const zoom of [1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(parseExportRequest({ ...request, focusZooms: [{ ...request.focusZooms[0], zoom }] }).focusZooms?.[0]?.zoom).toBe(zoom)
    }
    expect(() => parseExportRequest({ ...request, segments: [{ ...request.segments[0], duration: 6 }] })).toThrow('Freeze duration')
    expect(() => parseExportRequest({ ...request, segments: [{ ...request.segments[0], sourceTime: 4 }] })).toThrow('Freeze source time')
    expect(() => parseExportRequest({ ...request, focusZooms: [{ ...request.focusZooms[0], zoom: 1.25 }] })).toThrow('amount')
    expect(() => parseExportRequest({ ...request, focusZooms: [{ ...request.focusZooms[0], focusX: -1 }] })).toThrow('Focus x')
    expect(parseExportRequest({ ...request, focusZooms: [{ ...request.focusZooms[0], transitionDuration: 0.35 }] }).focusZooms?.[0]?.transitionDuration).toBe(0.35)
    for (const transitionDuration of [0.049, 5.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, '0.5']) {
      expect(() => parseExportRequest({ ...request, focusZooms: [{ ...request.focusZooms[0], transitionDuration }] })).toThrow('transition duration')
    }
    expect(() => parseExportRequest({ ...request, focusZooms: [request.focusZooms[0], { ...request.focusZooms[0], id: 'overlap' }] })).toThrow('overlap')
    expect(() => parseExportRequest({ ...request, segments: [{ ...request.segments[0], replayGroupId: 'bad replay!' }] })).toThrow('Replay group ID')
  })

  it('validates optional face blur ranges and bounded settings', () => {
    const effect = {
      id: 'face', start: 0.5, duration: 1, sensitivity: 0.75, detail: 'small',
      holdSeconds: 0.4, strength: 0.8, style: 'pixelate'
    }
    const request = {
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
      sources: [{ id: 'source', metadata }], outputPath: '/edited.mp4',
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }], overlays: [],
      faceBlurs: [effect]
    }
    expect(parseExportRequest(request).faceBlurs).toEqual([effect])
    expect(parseExportRequest({ ...request, faceBlurs: [{ ...effect, duration: 0.0005 }] }).faceBlurs?.[0]?.duration).toBe(0.0005)
    expect(parseExportRequest({ ...request, faceBlurs: [{ ...effect, holdSeconds: 2 }] }).faceBlurs?.[0]?.holdSeconds).toBe(2)
    expect(() => parseExportRequest({ ...request, faceBlurs: [{ ...effect, duration: 0 }] })).toThrow('Face blur duration')
    expect(parseExportRequest({ ...request, faceBlurs: [{ ...effect, style: 'blur' }] }).faceBlurs?.[0]?.style).toBe('blur')
    expect(parseExportRequest({ ...request, faceBlurs: [{ ...effect, style: 'mask' }] }).faceBlurs?.[0]?.style).toBe('mask')
    expect(parseExportRequest({ ...request, faceBlurs: [{ ...effect, detail: 'standard' }] }).faceBlurs?.[0]?.detail).toBe('standard')
    for (const [field, label, tooHigh] of [
      ['sensitivity', 'Face blur sensitivity', 1.1],
      ['holdSeconds', 'Face blur hold seconds', 2.01],
      ['strength', 'Face blur strength', 1.1]
    ] as const) {
      for (const value of [-0.1, tooHigh, Number.NaN, Number.POSITIVE_INFINITY, null, '1']) {
        expect(() => parseExportRequest({ ...request, faceBlurs: [{ ...effect, [field]: value }] })).toThrow(label)
      }
    }
    expect(() => parseExportRequest({ ...request, faceBlurs: [{ ...effect, detail: 'tiny' }] })).toThrow('Face blur detail')
    expect(() => parseExportRequest({ ...request, faceBlurs: [{ ...effect, style: 'circle' }] })).toThrow('Face blur style')
    expect(() => parseExportRequest({ ...request, faceBlurs: [{ ...effect, start: 2.5 }] })).toThrow('extends past')
    expect(() => parseExportRequest({ ...request, faceBlurs: [effect, { ...effect, id: 'second', start: 1 }] })).toThrow('overlap')
    expect(() => parseExportRequest({ ...request, faceBlurs: [effect, { ...effect, start: 2 }] })).toThrow('unique')
    expect(() => parseExportRequest({ ...request, faceBlurs: Array(101).fill(effect) })).toThrow('at most 100')
  })

  it('accepts a two-second face blur hold in saved sessions and rejects longer values', () => {
    const faceEffect = {
      id: 'face', start: 0.5, duration: 1, sensitivity: 0, detail: 'small' as const,
      holdSeconds: 2, strength: 0.8, style: 'pixelate' as const
    }
    const saved = { ...savedSnapshot(), faceBlurs: [faceEffect] }
    expect(parseSavedSession(saved)).toEqual(saved)
    expect(() => parseSavedSession({ ...saved, faceBlurs: [{ ...faceEffect, holdSeconds: 2.01 }] })).toThrow('Face blur hold seconds')
  })

  it('validates video range transitions', () => {
    const transition = {
      id: 'range-transition', start: 0.5, duration: 2,
      into: { effect: 'dissolve', duration: 0.5 },
      out: { effect: 'hblur', duration: 1 }
    }
    const request = {
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
      sources: [{ id: 'source', metadata }], outputPath: '/edited.mp4',
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }],
      overlays: [], videoTransitions: [transition]
    }
    expect(parseExportRequest(request).videoTransitions).toEqual([transition])
    expect(parseExportRequest({
      ...request,
      sources: [{ id: 'source', metadata: { ...metadata, duration: 12 } }],
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 12 }],
      videoTransitions: [{ id: 'long', start: 0, duration: 12, into: { effect: 'fade', duration: 12 } }]
    }).videoTransitions?.[0]?.into?.duration).toBe(12)
    const intoOnly = { id: transition.id, start: transition.start, duration: transition.duration, into: transition.into }
    expect(parseExportRequest({ ...request, videoTransitions: [intoOnly] }).videoTransitions).toEqual([intoOnly])
    const earlier = { ...transition, id: 'earlier', start: 0.5, duration: 0.5 }
    const adjacent = { ...transition, id: 'adjacent', start: 1, duration: 0.5 }
    expect(parseExportRequest({ ...request, videoTransitions: [adjacent, earlier] }).videoTransitions?.map(({ id }) => id))
      .toEqual(['earlier', 'adjacent'])
    expect(parseExportRequest({
      ...request,
      videoTransitions: [earlier, { ...adjacent, id: 'roundoff', start: 0.99995 }]
    }).videoTransitions).toHaveLength(2)
    expect(() => parseExportRequest({
      ...request,
      videoTransitions: [earlier, { ...adjacent, id: 'overlap', start: 0.9 }]
    })).toThrow('overlap')
    expect(() => parseExportRequest({
      ...request,
      videoTransitions: [earlier, { ...adjacent, id: 'just-overlap', start: 0.99989 }]
    })).toThrow('overlap')
    expect(() => parseExportRequest({ ...request, videoTransitions: 'bad' })).toThrow('array')
    expect(() => parseExportRequest({ ...request, videoTransitions: [{ ...transition, start: 2 }] })).toThrow('past')
    expect(() => parseExportRequest({ ...request, videoTransitions: [{ ...transition, into: { effect: 'wipeleft', duration: 0.5 } }] })).toThrow('not supported')
    expect(() => parseExportRequest({ ...request, videoTransitions: [{ ...transition, into: undefined, out: undefined }] })).toThrow('start or end')
    expect(() => parseExportRequest({ ...request, videoTransitions: [transition, { ...transition }] })).toThrow('unique')
    expect(() => parseSavedSession({
      ...savedSnapshot(),
      videoTransitions: [
        { id: 'first-range', start: 0, duration: 1, into: { effect: 'fade', duration: 0.5 } },
        { id: 'overlap-range', start: 0.5, duration: 1, out: { effect: 'hblur', duration: 0.5 } }
      ]
    })).toThrow('overlap')
  })

  it('validates text presets and prepared local bitmap geometry', () => {
    const text = {
      id: 'text', type: 'text', name: 'Title', start: 0, duration: 2, zIndex: 1,
      x: 0.1, y: 0.1, width: 0.8, height: 0.2, opacity: 1, text: 'Hello',
      fontFamily: 'Anton', fontSize: 7, color: '#fff', outlineColor: '#000',
      outlineWidth: 2, shadow: false, align: 'center', animation: 'pop',
      renderedTextBitmap: { dataUrl: 'data:image/png;base64,AA==', x: 20, y: 10, anchorX: 160, anchorY: 36 }
    }
    const request = {
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
      sources: [{ id: 'source', metadata }], outputPath: '/edited.mp4',
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }], overlays: [text]
    }
    for (const animation of ['none', 'pop', 'fade', 'bounce', 'shake']) {
      expect(parseExportRequest({ ...request, overlays: [{ ...text, animation }] }).overlays[0]).toMatchObject({ animation })
    }
    const timing = { animationDuration: 0, animationFadeIn: 5, animationFadeOut: 5 }
    expect(parseExportRequest({ ...request, overlays: [{ ...text, ...timing }] })).toEqual({ ...request, overlays: [{ ...text, ...timing }] })
    expect(parseExportRequest({ ...request, overlays: [{ ...text, text: '' }] }).overlays[0]).toMatchObject({ text: '' })
    expect(() => parseExportRequest({ ...request, overlays: [{ ...text, animation: 'spin' }] })).toThrow('Text animation')
    expect(() => parseExportRequest({ ...request, overlays: [{ ...text, renderedTextBitmap: { ...text.renderedTextBitmap, anchorX: 999 } }] })).toThrow('anchor x')
    expect(() => parseExportRequest({ ...request, overlays: [{ ...text, renderedTextBitmap: { ...text.renderedTextBitmap, dataUrl: 'bad' } }] })).toThrow('PNG')
    for (const [field, label] of [['animationDuration', 'Animation duration'], ['animationFadeIn', 'Animation fade in'], ['animationFadeOut', 'Animation fade out']] as const) {
      for (const value of [-0.1, 5.1, Number.NaN, Number.POSITIVE_INFINITY, null, '1']) {
        expect(() => parseExportRequest({ ...request, overlays: [{ ...text, [field]: value }] })).toThrow(label)
      }
    }
  })

  it('validates optional fades, game sound levels, and boosted volume', () => {
    const overlay = {
      id: 'audio', type: 'audio', name: 'Boom', path: '/boom.wav', start: 0,
      duration: 1, zIndex: 1, volume: 2, sourceIn: 0,
      fadeIn: 0.25, fadeOut: 1, duckGameAudio: true, gameAudioLevel: 0.3
    }
    const request = {
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
      sources: [{ id: 'source', metadata }], outputPath: '/edited.mp4',
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }],
      overlays: [overlay]
    }
    expect(parseExportRequest(request).overlays[0]).toEqual(overlay)
    for (const fade of [0, 0.1, 0.25, 0.5, 1]) {
      expect(() => parseExportRequest({ ...request, overlays: [{ ...overlay, fadeIn: fade }] })).not.toThrow()
    }
    for (const level of [0.5, 0.3, 0.15]) {
      expect(() => parseExportRequest({ ...request, overlays: [{ ...overlay, gameAudioLevel: level }] })).not.toThrow()
    }
    expect(() => parseExportRequest({ ...request, overlays: [{ ...overlay, fadeOut: 0.2 }] })).toThrow('Fade out')
    expect(() => parseExportRequest({ ...request, overlays: [{ ...overlay, gameAudioLevel: 0.2 }] })).toThrow('Game audio level')
    expect(() => parseExportRequest({ ...request, overlays: [{ ...overlay, duckGameAudio: 'yes' }] })).toThrow('Lower game sound')
    const silentVideo = {
      id: 'silent', type: 'video', name: 'Silent', path: '/silent.mp4', start: 0, duration: 1,
      zIndex: 2, x: 0, y: 0, width: 1, height: 1, opacity: 1, loop: false,
      audioEnabled: true, hasAudio: false, volume: 1, sourceIn: 0, sourceDuration: 1
    }
    expect(() => parseExportRequest({ ...request, overlays: [silentVideo] })).toThrow('no audio stream')
  })

  it('validates image and video animation presets while preserving legacy omission', () => {
    const image = {
      id: 'image', type: 'image', name: 'Badge', path: '/badge.png', start: 0, duration: 1,
      zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1
    }
    const video = {
      id: 'video', type: 'video', name: 'Clip', path: '/clip.mp4', start: 1, duration: 1,
      zIndex: 2, x: 0, y: 0, width: 1, height: 1, opacity: 1, loop: false,
      audioEnabled: false, hasAudio: false, volume: 1, sourceIn: 0, sourceDuration: 1
    }
    const request = {
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
      sources: [{ id: 'source', metadata }], outputPath: '/edited.mp4',
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }], overlays: [image, video]
    }
    expect(parseExportRequest(request).overlays).toEqual(request.overlays)
    for (const animation of mediaAnimationPresets) {
      expect(parseExportRequest({ ...request, overlays: [{ ...image, animation }] }).overlays[0]).toMatchObject({ animation })
      expect(parseExportRequest({ ...request, overlays: [{ ...video, animation }] }).overlays[0]).toMatchObject({ animation })
    }
    const timing = { animationDuration: 0, animationFadeIn: 5, animationFadeOut: 5 }
    expect(parseExportRequest({ ...request, overlays: [{ ...image, ...timing }] })).toEqual({ ...request, overlays: [{ ...image, ...timing }] })
    expect(parseExportRequest({ ...request, overlays: [{ ...video, ...timing }] })).toEqual({ ...request, overlays: [{ ...video, ...timing }] })
    expect(() => parseExportRequest({ ...request, overlays: [{ ...image, animation: 'spin' }] })).toThrow('Media animation')
    expect(() => parseExportRequest({ ...request, overlays: [{ ...video, animation: null }] })).toThrow('Media animation')
    for (const value of [-0.1, 5.1, Number.NaN, Number.POSITIVE_INFINITY, null, '1']) {
      expect(() => parseExportRequest({ ...request, overlays: [{ ...image, animationDuration: value }] })).toThrow('Animation duration')
      expect(() => parseExportRequest({ ...request, overlays: [{ ...image, animationFadeIn: value }] })).toThrow('Animation fade in')
      expect(() => parseExportRequest({ ...request, overlays: [{ ...video, animationFadeOut: value }] })).toThrow('Animation fade out')
    }
  })

  it('validates restorable editor state', () => {
    const saved = savedSnapshot()
    expect(parseSavedSession(saved)).toEqual(saved)
    expect(parseSavedSession({ ...saved, aiEnhance: {} })).not.toHaveProperty('aiEnhance')
    expect(parseSavedSession({ ...saved, dirty: true })).toEqual(saved)
    const legacyOverlay = {
      id: 'audio', type: 'audio', name: 'Effect', path: '/effect.wav', start: 2.5, duration: 1,
      zIndex: 1, volume: 1, sourceIn: 0, sourceDuration: 1
    }
    expect(parseSavedSession({ ...saved, overlays: [legacyOverlay] }).overlays).toEqual([legacyOverlay])
    const savedWithHistory = {
      ...saved,
      history: [{ ...saved, playhead: 0, marks: [] }],
      future: [{ ...saved, playhead: 2 }]
    }
    expect(parseSavedSession(savedWithHistory)).toEqual(savedWithHistory)
    expect(() => parseSavedSession({ ...saved, history: Array(51).fill(saved) })).toThrow('Undo history')
    expect(() => parseSavedSession({ ...saved, playhead: 4 })).toThrow('Playhead')
    expect(() => parseSavedSession({ ...saved, marks: 'bad' })).toThrow('Marks')
  })

  it('migrates legacy mark fields through the current snapshot and undo/redo history', () => {
    const current = savedSnapshot()
    const legacyBase: Record<string, unknown> = { ...current }
    delete legacyBase.marks
    const legacy = {
      ...legacyBase,
      cutPoints: [1, 2],
      history: [{ ...legacyBase, playhead: 0, cutPoints: [] }],
      future: [{ ...legacyBase, playhead: 2, cutPoints: [1] }]
    }
    expect(parseSavedSession(legacy)).toEqual({
      ...current,
      history: [{ ...current, playhead: 0, marks: [] }],
      future: [{ ...current, playhead: 2, marks: [1] }]
    })
    expect(parseSavedSession({ ...legacy, marks: [2] })).toMatchObject({ marks: [2] })
    expect(() => parseSavedSession({ ...legacy, marks: 'bad' })).toThrow('Marks')
    expect(() => parseSavedSession({ ...legacy, marks: null })).toThrow('Marks')
    expect(() => parseSavedSession({ ...legacy, marks: undefined })).toThrow('Marks')
  })

  it('migrates legacy Short framing into explicit points, including the full legacy bound', () => {
    const shortMetadata = { ...metadata, duration: 301 }
    const legacyMoves = Array.from({ length: 100 }, (_, index) => ({
      id: `move-${index}`,
      start: index * 3 + 1,
      duration: 1,
      direction: index % 2 === 0 ? 'left' : 'right'
    }))
    const legacy = {
      canvas: { width: 1080, height: 1920, fps: 24, fit: 'cover', shortFramePosition: 0.3 },
      sources: [{ id: 'source', metadata: shortMetadata }],
      segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 301 }],
      overlays: [], selectedOverlayId: null, playhead: 0, marks: [], shortFrameMoves: legacyMoves
    }
    const migrated = parseSavedSession(legacy)
    expect(migrated.canvas.shortFramePosition).toBeUndefined()
    expect(migrated.shortFramePoints).toHaveLength(201)
    expect(migrated.shortFramePoints?.[0]).toEqual({ id: 'short-frame-initial', time: 0, position: 0.3 })
    expect(migrated).not.toHaveProperty('shortFrameMoves')
    expect(parseExportRequest({ ...migrated, outputPath: '/short.mp4' }).shortFramePoints).toHaveLength(201)
  })

  it('allows only plain MP4 export names', () => {
    expect(parseDefaultName('holiday-edited.mp4')).toBe('holiday-edited.mp4')
    expect(() => parseDefaultName('../escape.mp4')).toThrow('MP4 filename')
    expect(() => parseDefaultName('video.mkv')).toThrow('MP4 filename')
  })
})
