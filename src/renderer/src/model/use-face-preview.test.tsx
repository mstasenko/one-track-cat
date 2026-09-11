import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditSession, JobProgress } from '@shared/types'
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
  it('forwards the selected marked range and preserves full-video scope without a selection', async () => {
    render(null, vi.fn(), selectedSession)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(selectedSession) })
    await act(async () => { await pending })
    expect(window.otc.previewFaces).toHaveBeenCalledWith(expect.objectContaining({ previewRange: [2, 6] }))
    expect(container?.querySelector('output')?.getAttribute('data-start')).toBe('2')
    expect(container?.querySelector('output')?.getAttribute('data-end')).toBe('6')

    const previewFaces = vi.mocked(window.otc.previewFaces)
    previewFaces.mockClear()
    const fullSession = { ...selectedSession, marks: [] }
    act(() => { root?.render(<PreviewHarness session={fullSession} job={null} />) })
    const fullVideoStart = currentState?.start
    if (!fullVideoStart) throw new Error('preview state missing')
    act(() => { pending = fullVideoStart(fullSession) })
    await act(async () => { await pending })
    expect(previewFaces).toHaveBeenCalledWith(expect.objectContaining({ previewRange: undefined }))
    expect(container?.querySelector('output')?.getAttribute('data-start')).toBe('0')
    expect(container?.querySelector('output')?.getAttribute('data-end')).toBe('10')
  })

  it('aligns an explicit selected-effect range and captures it in the result', async () => {
    const selectedEffectRange: [number, number] = [3, 4]
    render(null, vi.fn(), selectedSession, selectedEffectRange)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(selectedSession) })
    await act(async () => { await pending })
    expect(window.otc.previewFaces).toHaveBeenCalledWith(expect.objectContaining({ previewRange: selectedEffectRange }))
    expect(container?.querySelector('output')?.getAttribute('data-start')).toBe('3')
    expect(container?.querySelector('output')?.getAttribute('data-end')).toBe('4')
  })

  it('keeps disjoint partial previews available at their respective playheads', async () => {
    const firstFace = {
      id: 'first-face', start: 1, duration: 1, sensitivity: 0.7, detail: 'standard' as const,
      holdSeconds: 0.3, strength: 0.7, style: 'blur' as const
    }
    const secondFace = {
      id: 'second-face', start: 6, duration: 1, sensitivity: 0.7, detail: 'standard' as const,
      holdSeconds: 0.3, strength: 0.7, style: 'blur' as const
    }
    const firstSession = { ...selectedSession, playhead: 1.5, faceBlurs: [firstFace] }
    const bothSession = { ...firstSession, playhead: 6.5, faceBlurs: [firstFace, secondFace] }
    const previewFaces = vi.mocked(window.otc.previewFaces)
    previewFaces.mockResolvedValueOnce('first-preview').mockResolvedValueOnce('second-preview')

    render(null, vi.fn(), firstSession, [1, 2])
    const firstStart = currentState?.start
    if (!firstStart) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = firstStart(firstSession) })
    await act(async () => { await pending })

    act(() => { root?.render(<PreviewHarness session={bothSession} job={null} previewRange={[6, 7]} />) })
    const secondStart = currentState?.start
    if (!secondStart) throw new Error('preview state missing')
    act(() => { pending = secondStart(bothSession) })
    await act(async () => { await pending })
    expect(currentState?.renderedPreviews.map(({ url }) => url)).toEqual(['first-preview', 'second-preview'])

    const firstPlayhead = { ...bothSession, playhead: 1.5 }
    act(() => { root?.render(<PreviewHarness session={firstPlayhead} job={null} previewRange={[1, 2]} />) })
    expect(currentState?.renderedPreviews.map(({ url }) => url)).toEqual(['first-preview', 'second-preview'])
  })

  it('evicts an overlapping preview when face settings change, then replaces it', async () => {
    const original = {
      id: 'face', start: 2, duration: 2, sensitivity: 0.7, detail: 'standard' as const,
      holdSeconds: 0.3, strength: 0.7, style: 'blur' as const
    }
    const changed = { ...original, style: 'pixelate' as const }
    const originalSession = { ...selectedSession, playhead: 2.5, faceBlurs: [original] }
    const changedSession = { ...originalSession, faceBlurs: [changed] }
    const previewFaces = vi.mocked(window.otc.previewFaces)
    previewFaces.mockResolvedValueOnce('old-preview').mockResolvedValueOnce('new-preview')

    render(null, vi.fn(), originalSession, [2, 4])
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(originalSession) })
    await act(async () => { await pending })
    expect(currentState?.renderedPreviews.map(({ url }) => url)).toEqual(['old-preview'])

    act(() => { root?.render(<PreviewHarness session={changedSession} job={null} previewRange={[2, 4]} />) })
    expect(currentState?.renderedPreviews).toEqual([])
    const replacementStart = currentState?.start
    if (!replacementStart) throw new Error('preview state missing')
    act(() => { pending = replacementStart(changedSession) })
    await act(async () => { await pending })
    expect(currentState?.renderedPreviews.map(({ url }) => url)).toEqual(['new-preview'])
  })

  it('evicts every stored partial preview after a non-face content edit', async () => {
    const first = { id: 'first-face', start: 1, duration: 1, sensitivity: 0.7, detail: 'standard' as const, holdSeconds: 0.3, strength: 0.7, style: 'blur' as const }
    const second = { id: 'second-face', start: 6, duration: 1, sensitivity: 0.7, detail: 'standard' as const, holdSeconds: 0.3, strength: 0.7, style: 'blur' as const }
    const bothSession = { ...selectedSession, playhead: 6.5, faceBlurs: [first, second] }
    const previewFaces = vi.mocked(window.otc.previewFaces)
    previewFaces.mockResolvedValueOnce('first-preview').mockResolvedValueOnce('second-preview')

    render(null, vi.fn(), { ...bothSession, faceBlurs: [first] }, [1, 2])
    const firstStart = currentState?.start
    if (!firstStart) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = firstStart({ ...bothSession, faceBlurs: [first] }) })
    await act(async () => { await pending })
    act(() => { root?.render(<PreviewHarness session={bothSession} job={null} previewRange={[6, 7]} />) })
    const secondStart = currentState?.start
    if (!secondStart) throw new Error('preview state missing')
    act(() => { pending = secondStart(bothSession) })
    await act(async () => { await pending })
    expect(currentState?.renderedPreviews).toHaveLength(2)

    const edited = { ...bothSession, canvas: { ...bothSession.canvas, width: 640 } }
    act(() => { root?.render(<PreviewHarness session={edited} job={null} previewRange={[6, 7]} />) })
    expect(currentState?.renderedPreviews).toEqual([])
  })

  it('keeps the rendered result through playhead, mark-selection, and face-panel changes', async () => {
    render(null, vi.fn(), selectedSession)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(selectedSession) })
    await act(async () => { await pending })
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('preview-url')

    const changedSelection = { ...selectedSession, playhead: 4, marks: [1, 8] }
    act(() => { root?.render(<PreviewHarness session={changedSelection} job={null} previewRange={[1, 8]} />) })
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('preview-url')

    const changedFacePanelSelection = { ...changedSelection, playhead: 7 }
    act(() => { root?.render(<PreviewHarness session={changedFacePanelSelection} job={null} previewRange={[7, 9]} />) })
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('preview-url')
  })

  it('invalidates the rendered result for actual content edits', async () => {
    render(null, vi.fn(), selectedSession)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(selectedSession) })
    await act(async () => { await pending })
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('preview-url')

    const contentEdit = {
      ...selectedSession,
      canvas: { ...selectedSession.canvas, width: 640 },
      overlays: [{ id: 'overlay', type: 'text' as const, name: 'Text', start: 0, duration: 1, zIndex: 0, x: 0, y: 0, width: 1, height: 1, opacity: 1, text: 'changed', fontFamily: 'Anton', fontSize: 12, color: '#fff', outlineColor: '#000', outlineWidth: 0, shadow: false, align: 'center' as const }],
      focusZooms: [{ id: 'focus', start: 0, duration: 1, zoom: 1.5 as const, focusX: 0.5, focusY: 0.5 }],
      faceBlurs: [{ id: 'face', start: 0, duration: 1, sensitivity: 0.5, detail: 'standard' as const, holdSeconds: 0, strength: 0.5, style: 'blur' as const }]
    }
    act(() => { root?.render(<PreviewHarness session={contentEdit} job={null} previewRange={[1, 2]} />) })
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('')
  })

  it('keeps the request and result range captured when selection changes during rendering', async () => {
    let resolvePreview!: (url: string) => void
    const previewFaces = vi.fn(() => new Promise<string>((resolve) => { resolvePreview = resolve }))
    window.otc.previewFaces = previewFaces
    const firstRange: [number, number] = [3.001, 4.001]
    render(null, vi.fn(), selectedSession, firstRange)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(selectedSession) })
    await act(async () => { await Promise.resolve() })
    act(() => { root?.render(<PreviewHarness session={selectedSession} job={null} previewRange={[6, 7]} />) })
    resolvePreview('captured-preview-url')
    await act(async () => { await pending })
    expect(previewFaces).toHaveBeenCalledWith(expect.objectContaining({ previewRange: [91 / 30, 121 / 30] }))
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('captured-preview-url')
    expect(container?.querySelector('output')?.getAttribute('data-start')).toBe(String(91 / 30))
    expect(container?.querySelector('output')?.getAttribute('data-end')).toBe(String(121 / 30))
  })

  it('keeps a preview started with the freshly applied session during the output-key update', async () => {
    const selectedEffectRange: [number, number] = [3, 4]
    const appliedSession: EditSession = {
      ...selectedSession,
      faceBlurs: [{
        id: 'new-face-blur', start: 2, duration: 4, sensitivity: 0.7, detail: 'standard',
        holdSeconds: 0.3, strength: 0.7, style: 'pixelate'
      }]
    }
    const previewFaces = vi.fn().mockResolvedValue('fresh-preview-url')
    window.otc.previewFaces = previewFaces
    render(null, vi.fn(), selectedSession, selectedEffectRange)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => {
      pending = start(appliedSession)
      root?.render(<PreviewHarness session={appliedSession} job={null} previewRange={selectedEffectRange} />)
    })
    await act(async () => { await pending })

    expect(previewFaces).toHaveBeenCalledOnce()
    expect(previewFaces).toHaveBeenCalledWith(expect.objectContaining({ faceBlurs: appliedSession.faceBlurs }))
    expect(previewFaces).toHaveBeenCalledWith(expect.objectContaining({ previewRange: selectedEffectRange }))
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('fresh-preview-url')
  })

  it('clears the previous rendered result when a fresh preview starts', async () => {
    render(null, vi.fn(), selectedSession)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(selectedSession) })
    await act(async () => { await pending })
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('preview-url')

    let resolveFresh!: (url: string) => void
    window.otc.previewFaces = vi.fn(() => new Promise<string>((resolve) => { resolveFresh = resolve }))
    act(() => { pending = currentState?.start(selectedSession) })
    await act(async () => { await Promise.resolve() })
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('')
    resolveFresh('fresh-preview-url')
    await act(async () => { await pending })
    expect(container?.querySelector('output')?.getAttribute('data-url')).toBe('fresh-preview-url')
  })

  it('does not start IPC when invalidated while preparing the request', async () => {
    render()
    const start = currentState?.start
    const invalidate = currentState?.invalidate
    if (!start || !invalidate) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => {
      pending = start(session)
      invalidate()
    })
    await act(async () => { await pending })
    expect(window.otc.previewFaces).not.toHaveBeenCalled()
  })

  it('ignores a duplicate start while an earlier render is active', async () => {
    let resolvePreview!: (url: string) => void
    const previewFaces = vi.fn(() => new Promise<string>((resolve) => { resolvePreview = resolve }))
    window.otc.previewFaces = previewFaces
    render()
    const start = currentState?.start
    const invalidate = currentState?.invalidate
    if (!start || !invalidate) throw new Error('preview state missing')
    let first: Promise<void> | undefined
    let second: Promise<void> | undefined
    act(() => {
      first = start(session)
      second = start(session)
    })
    await act(async () => { await Promise.resolve() })
    expect(previewFaces).toHaveBeenCalledOnce()
    act(() => { invalidate() })
    resolvePreview('preview-url')
    await act(async () => { await first; await second })
  })

  it('cancels the newly reported preview job after an early invalidation', async () => {
    let resolvePreview!: (url: string) => void
    const previewFaces = vi.fn(() => new Promise<string>((resolve) => { resolvePreview = resolve }))
    const cancelJob = vi.fn().mockResolvedValue(true)
    window.otc.previewFaces = previewFaces
    window.otc.cancelJob = cancelJob
    const previousJob: JobProgress = { id: 'previous', kind: 'export', state: 'completed', progress: 1, message: 'done' }
    render(previousJob)
    const start = currentState?.start
    const invalidate = currentState?.invalidate
    if (!start || !invalidate) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(session) })
    await act(async () => { await Promise.resolve() })
    act(() => { invalidate() })
    const newJob: JobProgress = { id: 'preview', kind: 'export', state: 'running', progress: 0, message: 'rendering' }
    act(() => { root?.render(<PreviewHarness job={newJob} />) })
    expect(cancelJob).toHaveBeenCalledWith('preview')
    resolvePreview('preview-url')
    await act(async () => { await pending })
  })

  it('reports a non-cancellation preview failure with the underlying detail', async () => {
    const previewFaces = vi.fn().mockRejectedValue(new Error('face pack is unavailable'))
    const showError = vi.fn()
    window.otc.previewFaces = previewFaces
    render(null, showError)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(session) })
    await act(async () => { await pending })
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('face pack is unavailable'))
  })

  it('does not report a cancelled preview failure, including string errors', async () => {
    const previewFaces = vi.fn().mockRejectedValue('preview cancelled by user')
    const showError = vi.fn()
    window.otc.previewFaces = previewFaces
    render(null, showError)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(session) })
    await act(async () => { await pending })
    expect(showError).not.toHaveBeenCalled()
  })

  it('cancels an active running preview job only once across repeated invalidation', async () => {
    let resolvePreview!: (url: string) => void
    const previewFaces = vi.fn(() => new Promise<string>((resolve) => { resolvePreview = resolve }))
    const cancelJob = vi.fn().mockResolvedValue(true)
    const showError = vi.fn()
    window.otc.previewFaces = previewFaces
    window.otc.cancelJob = cancelJob
    const previousJob: JobProgress = { id: 'previous', kind: 'export', state: 'completed', progress: 1, message: 'done' }
    render(previousJob, showError)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(session) })
    await act(async () => { await Promise.resolve() })
    expect(previewFaces).toHaveBeenCalledOnce()

    const runningJob: JobProgress = { id: 'preview', kind: 'export', state: 'running', progress: 0, message: 'rendering' }
    act(() => { root?.render(<PreviewHarness job={runningJob} onError={showError} />) })
    expect(cancelJob).not.toHaveBeenCalled()
    const invalidate = currentState?.invalidate
    if (!invalidate) throw new Error('preview state missing')
    act(() => { invalidate() })
    expect(cancelJob).toHaveBeenCalledWith('preview')
    act(() => { invalidate() })
    expect(cancelJob).toHaveBeenCalledOnce()

    resolvePreview('preview-url')
    await act(async () => { await pending })
  })

  it('does not send cancellation IPC for a completed preview job', async () => {
    let resolvePreview!: (url: string) => void
    const previewFaces = vi.fn(() => new Promise<string>((resolve) => { resolvePreview = resolve }))
    const cancelJob = vi.fn().mockResolvedValue(true)
    const showError = vi.fn()
    window.otc.previewFaces = previewFaces
    window.otc.cancelJob = cancelJob
    const previousJob: JobProgress = { id: 'previous', kind: 'export', state: 'completed', progress: 1, message: 'done' }
    render(previousJob, showError)
    const start = currentState?.start
    if (!start) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(session) })
    await act(async () => { await Promise.resolve() })
    const completedJob: JobProgress = { id: 'completed-preview', kind: 'export', state: 'completed', progress: 1, message: 'done' }
    act(() => { root?.render(<PreviewHarness job={completedJob} onError={showError} />) })
    const invalidate = currentState?.invalidate
    if (!invalidate) throw new Error('preview state missing')
    act(() => { invalidate() })
    expect(cancelJob).not.toHaveBeenCalled()
    resolvePreview('preview-url')
    await act(async () => { await pending })
  })

  it('suppresses a stale failure after invalidation', async () => {
    let rejectPreview!: (error: unknown) => void
    const previewFaces = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectPreview = reject }))
    const showError = vi.fn()
    window.otc.previewFaces = previewFaces
    render(null, showError)
    const start = currentState?.start
    const invalidate = currentState?.invalidate
    if (!start || !invalidate) throw new Error('preview state missing')
    let pending: Promise<void> | undefined
    act(() => { pending = start(session) })
    await act(async () => { await Promise.resolve() })
    expect(previewFaces).toHaveBeenCalledOnce()
    act(() => { invalidate() })
    rejectPreview(new Error('temporary disk failure'))
    await act(async () => { await pending })
    expect(showError).not.toHaveBeenCalled()
  })
})
