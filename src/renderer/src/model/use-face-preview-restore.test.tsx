import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditSession, FacePreviewResult, JobProgress } from '@shared/types'
import { useFacePreview, type FacePreviewState } from './use-face-preview'

const session: EditSession = {
  canvas: { width: 320, height: 180, fps: 30, fit: 'contain' },
  sources: [], segments: [], overlays: [], selectedOverlayId: null,
  playhead: 0, marks: [], focusZooms: [], faceBlurs: []
}

const selectedSession: EditSession = {
  ...session,
  sources: [{
    id: 'source',
    metadata: {
      path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
      width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: false
    },
    playbackPath: '/source.mp4', waveform: []
  }],
  segments: [{ id: 'segment', sourceId: 'source', sourceStart: 0, sourceEnd: 10 }],
  playhead: 3,
  marks: [2, 6]
}

const persistedFaceSession: EditSession = {
  ...selectedSession,
  faceBlurs: [{
    id: 'saved-face', start: 2, duration: 4, sensitivity: 0.7, detail: 'standard',
    holdSeconds: 0.3, strength: 0.7, style: 'blur'
  }]
}

let root: Root | undefined
let container: HTMLDivElement | undefined
let currentState: FacePreviewState | undefined

function PreviewHarness({ session: currentSession = session, job, onError = vi.fn(), previewRange }: { session?: EditSession; job: JobProgress | null; onError?: (message: string) => void; previewRange?: [number, number] }): React.JSX.Element {
  currentState = useFacePreview(currentSession, job, onError, previewRange)
  return <output
    data-rendering={String(currentState.rendering)}
    data-url={currentState.renderedPreview?.url ?? ''}
    data-start={currentState.renderedPreview ? String(currentState.renderedPreview.start) : ''}
    data-end={currentState.renderedPreview ? String(currentState.renderedPreview.end) : ''}
  />
}

function render(job: JobProgress | null = null, onError: (message: string) => void = vi.fn(), currentSession: EditSession = session, previewRange?: [number, number]): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<PreviewHarness session={currentSession} job={job} onError={onError} previewRange={previewRange} />) })
}

function outputElement(): HTMLOutputElement {
  const output = container?.querySelector('output')
  if (!(output instanceof HTMLOutputElement)) throw new Error('preview output missing')
  return output
}

function deferredRestore(): { promise: Promise<FacePreviewResult[]>; resolve: (value: FacePreviewResult[]) => void } {
  let resolve!: (value: FacePreviewResult[]) => void
  const promise = new Promise<FacePreviewResult[]>((finish) => { resolve = finish })
  return { promise, resolve }
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  currentState = undefined
  const cancelJob = vi.fn().mockResolvedValue(true)
  Object.defineProperty(window, 'otc', {
    configurable: true,
    value: {
      cancelJob,
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
  currentState = undefined
  vi.restoreAllMocks()
})

describe('useFacePreview', () => {
  it('restores a persisted face preview after remount without starting inference', async () => {
    const restored = { url: 'restored-preview-url', start: 0, end: 10 }
    const restoreFacePreview = vi.mocked(window.otc.restoreFacePreview)
    restoreFacePreview.mockResolvedValue([restored])
    render(null, vi.fn(), persistedFaceSession)
    await vi.waitFor(() => expect(restoreFacePreview).toHaveBeenCalledOnce())
    expect(restoreFacePreview).toHaveBeenCalledWith(expect.objectContaining({
      outputPath: '', faceBlurs: persistedFaceSession.faceBlurs
    }))
    expect(window.otc.previewFaces).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(outputElement().getAttribute('data-url')).toBe(restored.url))

    act(() => { root?.unmount() })
    container?.remove()
    root = undefined
    container = undefined
    restoreFacePreview.mockClear()
    render(null, vi.fn(), persistedFaceSession)
    await vi.waitFor(() => expect(restoreFacePreview).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(outputElement().getAttribute('data-url')).toBe(restored.url))
    expect(outputElement().getAttribute('data-start')).toBe('0')
    expect(outputElement().getAttribute('data-end')).toBe('10')

    const lookupCount = restoreFacePreview.mock.calls.length
    const moved = { ...persistedFaceSession, playhead: 6, marks: [1, 8] }
    act(() => { root?.render(<PreviewHarness session={moved} job={null} />) })
    await new Promise((resolve) => setTimeout(resolve, 240))
    expect(restoreFacePreview).toHaveBeenCalledTimes(lookupCount)
    expect(outputElement().getAttribute('data-url')).toBe(restored.url)
  })

  it('loads all disjoint results returned by plural restore', async () => {
    const first = { url: 'first-restored', start: 2, end: 3 }
    const second = { url: 'second-restored', start: 7, end: 8 }
    const restoreFacePreview = vi.mocked(window.otc.restoreFacePreview)
    restoreFacePreview.mockResolvedValue([first, second])
    render(null, vi.fn(), persistedFaceSession)
    await vi.waitFor(() => expect(currentState?.renderedPreviews).toEqual([first, second]))
    expect(window.otc.previewFaces).not.toHaveBeenCalled()
  })

  it('keeps cache misses and restore failures silent without falling back to inference', async () => {
    const restoreFacePreview = vi.mocked(window.otc.restoreFacePreview)
    const showError = vi.fn()
    restoreFacePreview.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('invalid cache'))
    render(null, showError, persistedFaceSession)
    await vi.waitFor(() => expect(restoreFacePreview).toHaveBeenCalledOnce())
    expect(window.otc.previewFaces).not.toHaveBeenCalled()
    expect(showError).not.toHaveBeenCalled()

    const changed = { ...persistedFaceSession, canvas: { ...persistedFaceSession.canvas, width: 640 } }
    act(() => { root?.render(<PreviewHarness session={changed} job={null} onError={showError} />) })
    await vi.waitFor(() => expect(restoreFacePreview).toHaveBeenCalledTimes(2))
    expect(window.otc.previewFaces).not.toHaveBeenCalled()
    expect(showError).not.toHaveBeenCalled()
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('')
  })

  it('ignores a restore result after a content edit', async () => {
    const restoreFacePreview = vi.mocked(window.otc.restoreFacePreview)
    const deferred = deferredRestore()
    restoreFacePreview.mockReturnValueOnce(deferred.promise)
    render(null, vi.fn(), persistedFaceSession)
    await vi.waitFor(() => expect(restoreFacePreview).toHaveBeenCalledOnce())

    const edited = { ...persistedFaceSession, canvas: { ...persistedFaceSession.canvas, width: 640 } }
    act(() => { root?.render(<PreviewHarness session={edited} job={null} />) })
    act(() => { deferred.resolve([{ url: 'stale-edit', start: 0, end: 10 }]) })
    await act(async () => { await Promise.resolve() })
    expect(outputElement().getAttribute('data-url')).toBe('')
  })

  it('keeps the Apply result when a restore started earlier resolves afterward', async () => {
    const restoreFacePreview = vi.mocked(window.otc.restoreFacePreview)
    const deferred = deferredRestore()
    restoreFacePreview.mockReturnValueOnce(deferred.promise)
    render(null, vi.fn(), persistedFaceSession)
    await vi.waitFor(() => expect(restoreFacePreview).toHaveBeenCalledOnce())

    let resolvePreview!: (url: string) => void
    window.otc.previewFaces = vi.fn(() => new Promise<string>((resolve) => { resolvePreview = resolve }))
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(persistedFaceSession) })
    await act(async () => { await Promise.resolve() })
    act(() => { resolvePreview('fresh-apply') })
    await act(async () => { await pending })
    act(() => { deferred.resolve([{ url: 'stale-start', start: 0, end: 10 }]) })
    await act(async () => { await Promise.resolve() })
    expect(outputElement().getAttribute('data-url')).toBe('fresh-apply')
  })

  it('ignores a restore result after cancellation', async () => {
    const restoreFacePreview = vi.mocked(window.otc.restoreFacePreview)
    const deferred = deferredRestore()
    restoreFacePreview.mockReturnValueOnce(deferred.promise)
    render(null, vi.fn(), persistedFaceSession)
    await vi.waitFor(() => expect(restoreFacePreview).toHaveBeenCalledOnce())
    act(() => {
      currentState?.invalidate()
      deferred.resolve([{ url: 'stale-cancel', start: 0, end: 10 }])
    })
    await act(async () => { await Promise.resolve() })
    expect(outputElement().getAttribute('data-url')).toBe('')
  })

  it('discards a restore result after unmount', async () => {
    const restoreFacePreview = vi.mocked(window.otc.restoreFacePreview)
    const deferred = deferredRestore()
    restoreFacePreview.mockReturnValueOnce(deferred.promise)
    render(null, vi.fn(), persistedFaceSession)
    await vi.waitFor(() => expect(restoreFacePreview).toHaveBeenCalledOnce())
    act(() => { root?.unmount() })
    act(() => { deferred.resolve([{ url: 'stale-unmount', start: 0, end: 10 }]) })
    await act(async () => { await Promise.resolve() })
  })
})
