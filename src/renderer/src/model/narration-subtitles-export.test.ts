import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioOverlay, MediaMetadata } from '@shared/types'
import { createSession, defaultTextOverlay } from './timeline'
import { narrationSubtitleOverlays } from './narration-subtitles'
import { prepareExportRequest } from './export-request'
import { renderTextBitmap } from './text-render'

vi.mock('./text-render', () => ({
  renderTextBitmap: vi.fn(() => Promise.resolve({
    dataUrl: 'data:image/png;base64,AA==', x: 0, y: 0, anchorX: 0, anchorY: 0
  }))
}))

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 20,
  width: 1920, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: true
}

function narration(enabled: boolean): AudioOverlay {
  return {
    id: 'narration-owner', type: 'audio', name: 'AI Narration', path: '/narration.wav',
    start: 4, duration: 8, zIndex: 2, volume: 1, sourceIn: 0,
    narration: { draftId: 'draft-1', enabled }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('narration subtitle export visibility', () => {
  it('filters original-branch captions but rasterizes enabled captions and preserves associations', async () => {
    const session = createSession(metadata)
    const owner = narration(false)
    const manual = defaultTextOverlay(1, 1)
    const caption = narrationSubtitleOverlays(session, owner, [{ start: 0.5, end: 1.5, text: 'Generated caption.' }])[0]
    if (!caption) throw new Error('caption overlay missing')
    session.overlays = [owner, manual, caption]

    const originalRequest = await prepareExportRequest(session, '/original.mp4')
    expect(originalRequest.overlays.map((overlay) => overlay.id)).toEqual([owner.id, manual.id])
    expect(originalRequest.overlays.some((overlay) => overlay.type === 'text' && overlay.narrationId === owner.narration?.draftId)).toBe(false)
    expect(vi.mocked(renderTextBitmap)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renderTextBitmap).mock.calls[0]?.[0]).toBe(manual)

    vi.mocked(renderTextBitmap).mockClear()
    const enabledOwner = narration(true)
    session.overlays = [enabledOwner, manual, caption]
    const enabledRequest = await prepareExportRequest(session, '/ai.mp4')
    const exportedCaption = enabledRequest.overlays.find((overlay) => overlay.type === 'text' && overlay.narrationId === enabledOwner.narration?.draftId)
    const exportedOwner = enabledRequest.overlays.find((overlay) => overlay.id === enabledOwner.id)

    expect(enabledRequest.overlays.map((overlay) => overlay.id)).toEqual([enabledOwner.id, manual.id, caption.id])
    expect(exportedOwner).toEqual(enabledOwner)
    expect(exportedCaption).toMatchObject({ id: caption.id, narrationId: enabledOwner.narration?.draftId, text: caption.text })
    expect(exportedCaption).toHaveProperty('renderedTextBitmap.dataUrl', 'data:image/png;base64,AA==')
    expect(vi.mocked(renderTextBitmap)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(renderTextBitmap).mock.calls.map(([overlay]) => overlay.id)).toEqual([manual.id, caption.id])
  })
})
