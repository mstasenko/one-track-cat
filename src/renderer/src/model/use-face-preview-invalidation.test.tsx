import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditSession, FacePreviewResult } from '@shared/types'
import { useFacePreview } from './use-face-preview'

const sourceSession: EditSession = {
  canvas: { width: 320, height: 180, fps: 30, fit: 'contain' },
  sources: [{
    id: 'source',
    metadata: {
      path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
      width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: false
    },
    playbackPath: '/source.mp4', waveform: []
  }],
  segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
  overlays: [], selectedOverlayId: null, playhead: 3, marks: [], focusZooms: [],
  faceBlurs: [{
    id: 'face', start: 2, duration: 4, sensitivity: 0.7, detail: 'standard',
    holdSeconds: 0.3, strength: 0.7, style: 'blur'
  }],
  videoTransitions: []
}

const transitionedSession: EditSession = {
  ...sourceSession,
  videoTransitions: [{
    id: 'range-transition', start: 0, duration: 1,
    into: { effect: 'fade', duration: 0.5 }
  }]
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function PreviewHarness({ session }: { session: EditSession }): React.JSX.Element {
  const state = useFacePreview(session, null, vi.fn())
  return <output data-url={state.renderedPreview?.url ?? ''} />
}

function renderSession(currentSession: EditSession): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<PreviewHarness session={currentSession} />) })
}

function outputUrl(): string {
  return container?.querySelector('output')?.getAttribute('data-url') ?? ''
}

function deferredRestore(): { promise: Promise<FacePreviewResult[]>; resolve: (value: FacePreviewResult[]) => void } {
  let resolve!: (value: FacePreviewResult[]) => void
  const promise = new Promise<FacePreviewResult[]>((finish) => { resolve = finish })
  return { promise, resolve }
}

async function advanceRestoreTimer(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  Object.defineProperty(window, 'otc', {
    configurable: true,
    value: {
      cancelJob: vi.fn().mockResolvedValue(true),
      previewFaces: vi.fn().mockResolvedValue('preview-url'),
      restoreFacePreview: vi.fn().mockResolvedValue([])
    }
  })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useFacePreview transition invalidation', () => {
  it('clears and restores the cache when only video transitions change', async () => {
    const restoreFacePreview = vi.mocked(window.otc.restoreFacePreview)
    restoreFacePreview
      .mockResolvedValueOnce([{ url: 'old-preview-url', start: 0, end: 10 }])
      .mockResolvedValueOnce([{ url: 'new-preview-url', start: 0, end: 10 }])

    renderSession(sourceSession)
    await advanceRestoreTimer()
    expect(restoreFacePreview).toHaveBeenCalledTimes(1)
    expect(outputUrl()).toBe('old-preview-url')

    act(() => { root?.render(<PreviewHarness session={transitionedSession} />) })
    expect(outputUrl()).toBe('')
    await advanceRestoreTimer()
    expect(restoreFacePreview).toHaveBeenCalledTimes(2)
    expect(outputUrl()).toBe('new-preview-url')
    expect(restoreFacePreview).toHaveBeenNthCalledWith(2, expect.objectContaining({
      videoTransitions: transitionedSession.videoTransitions
    }))
  })

  it('ignores a pending restore from the old transition collection', async () => {
    const restoreFacePreview = vi.mocked(window.otc.restoreFacePreview)
    const oldRestore = deferredRestore()
    const newRestore = deferredRestore()
    restoreFacePreview.mockReturnValueOnce(oldRestore.promise).mockReturnValueOnce(newRestore.promise)

    renderSession(sourceSession)
    await advanceRestoreTimer()
    expect(restoreFacePreview).toHaveBeenCalledTimes(1)

    act(() => { root?.render(<PreviewHarness session={transitionedSession} />) })
    expect(outputUrl()).toBe('')
    await advanceRestoreTimer()
    expect(restoreFacePreview).toHaveBeenCalledTimes(2)

    oldRestore.resolve([{ url: 'stale-preview-url', start: 0, end: 10 }])
    await act(async () => { await oldRestore.promise; await Promise.resolve() })
    expect(outputUrl()).toBe('')

    newRestore.resolve([{ url: 'current-preview-url', start: 0, end: 10 }])
    await act(async () => { await newRestore.promise; await Promise.resolve() })
    expect(outputUrl()).toBe('current-preview-url')
  })
})
