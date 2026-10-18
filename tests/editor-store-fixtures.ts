import { vi } from 'vitest'
import type { otcApi, MediaMetadata, SourceSegment, VideoSegment } from '@shared/types'

export const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

export function video(segment: SourceSegment | undefined): VideoSegment {
  if (!segment || segment.kind === 'freeze') throw new Error('video segment missing')
  return segment
}

export function api(): otcApi {
  return {
    openVideo: vi.fn().mockResolvedValue('/source.mp4'),
    openVideoPath: vi.fn().mockResolvedValue('/source.mp4'),
    listVideoDirectory: vi.fn().mockResolvedValue({ path: '/videos', parent: null, entries: [], truncated: false }),
    authorizeVideo: vi.fn().mockResolvedValue('/source.mp4'),
    searchTemplates: vi.fn().mockResolvedValue([]),
    importTemplate: vi.fn().mockResolvedValue({ type: 'image', name: 'template.png', path: '/template.png' }),
    openTemplatePage: vi.fn().mockResolvedValue(undefined),
    openMedia: vi.fn().mockResolvedValue({ path: '/effect.ogg', type: 'audio', name: 'Effect' }),
    probe: vi.fn().mockResolvedValue(metadata),
    probeAsset: vi.fn().mockResolvedValue({ duration: 2, hasAudio: true }),
    waveform: vi.fn().mockResolvedValue([0.1, 0.8]),
    scanAssets: vi.fn().mockResolvedValue([]),
    chooseExportPath: vi.fn().mockResolvedValue('/output.mp4'),
    exportVideo: vi.fn().mockResolvedValue(undefined),
    facePackStatus: vi.fn().mockResolvedValue({ available: false, message: 'Face model pack unavailable' }),
    previewFaces: vi.fn().mockResolvedValue('/preview.mp4'),
    restoreFacePreview: vi.fn().mockResolvedValue([]),
    loadSession: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    clearFaceCache: vi.fn().mockResolvedValue(undefined),
    cancelJob: vi.fn().mockResolvedValue(true),
    getGpuDiagnostics: vi.fn().mockResolvedValue({ hardwareAcceleration: true, videoDecode: 'enabled', gpuCompositing: 'enabled' }),
    getPathUrl: vi.fn((path: string) => Promise.resolve(`media:${path}`)),
    getSvgDataUrl: vi.fn((path: string) => Promise.resolve(`data:image/svg+xml,${path}`)),
    getDroppedPath: vi.fn().mockResolvedValue('/drop.mp4'),
    onOpenPath: vi.fn(() => () => undefined),
    onResetProject: vi.fn(() => () => undefined),
    onJobProgress: vi.fn(() => () => undefined),
    onSaveRequest: vi.fn(() => () => undefined)
  }
}
