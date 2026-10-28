import { describe, expect, it } from 'vitest'
import { parseExportRequest } from './validation'

const request = {
  canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
  sources: [{ id: 'source', metadata: { path: '/video.mp4', name: 'video.mp4', size: 10, modifiedAt: 100,
    duration: 3, width: 320, height: 180, fps: 24, videoCodec: 'h264', hasAudio: true } }],
  outputPath: '/edited.mp4', segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }], overlays: [],
  focusZooms: [{ id: 'zoom', start: 0, duration: 1, zoom: 1.5, focusX: 0.75, focusY: 0.25 }]
}

describe('Focus zoom mode validation', () => {
  it('accepts omitted, frame, and circle modes and rejects other values', () => {
    expect(parseExportRequest(request).focusZooms?.[0]?.mode).toBeUndefined()
    for (const mode of ['frame', 'circle'] as const) {
      expect(parseExportRequest({ ...request, focusZooms: [{ ...request.focusZooms[0], mode }] }).focusZooms?.[0]?.mode).toBe(mode)
    }
    for (const mode of ['square', '', null, 1, true]) {
      expect(() => parseExportRequest({ ...request, focusZooms: [{ ...request.focusZooms[0], mode }] })).toThrow('Focus zoom mode')
    }
  })
})
