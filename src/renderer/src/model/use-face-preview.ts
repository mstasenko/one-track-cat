import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditSession, FaceBlurEffect, FacePreviewResult, JobProgress } from '@shared/types'
import { prepareExportRequest } from './export-request'
import { deletionRange, timelineDuration } from './timeline'

// The preview IPC handler replaces this transport-only field with its app-owned cache path.
const previewOutputPath = ''
const rangeTolerance = 0.0001
const frameEpsilon = 0.000001
const restoreDebounceMs = 200

export type RenderedFacePreview = FacePreviewResult

function contentRenderKey(session: EditSession | null): string {
  if (!session) return ''
  return JSON.stringify({
    canvas: session.canvas,
    sources: session.sources.map(({ id, metadata }) => ({ id, metadata })),
    segments: session.segments,
    overlays: session.overlays,
    focusZooms: session.focusZooms,
    videoTransitions: session.videoTransitions
  })
}

function renderKey(session: EditSession | null): string {
  if (!session) return ''
  return JSON.stringify({ content: contentRenderKey(session), faceBlurs: session.faceBlurs })
}

interface StoredFacePreview {
  result: RenderedFacePreview
  faceBlurs: FaceBlurEffect[]
}

function faceBlursSnapshot(session: EditSession): FaceBlurEffect[] {
  return (session.faceBlurs ?? []).map((effect) => ({ ...effect }))
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd
}

function sameFaceEffect(left: FaceBlurEffect, right: FaceBlurEffect): boolean {
  return left.id === right.id && JSON.stringify(left) === JSON.stringify(right)
}

function previewMatchesFaceBlurs(preview: StoredFacePreview, faceBlurs: FaceBlurEffect[]): boolean {
  const { start, end } = preview.result
  const previous = preview.faceBlurs.filter((effect) => rangesOverlap(effect.start, effect.start + effect.duration, start, end))
  const current = faceBlurs.filter((effect) => rangesOverlap(effect.start, effect.start + effect.duration, start, end))
  return previous.length === current.length && previous.every((effect) => current.some((candidate) => sameFaceEffect(effect, candidate)))
}

function samePreviewRange(preview: RenderedFacePreview, range: [number, number]): boolean {
  return preview.start === range[0] && preview.end === range[1]
}

function frameCeil(value: number, fps: number): number {
  return Math.ceil(value * fps - frameEpsilon) / fps
}

function capturedPreviewRange(session: EditSession, requestedRange: [number, number] | null): [number, number] {
  const duration = timelineDuration(session.segments)
  if (!requestedRange) return [0, duration]
  if (requestedRange[0] <= rangeTolerance && requestedRange[1] >= duration - rangeTolerance) {
    return [0, duration]
  }
  const fps = session.canvas.fps
  const timelineEnd = Math.ceil(duration * fps) / fps
  return [
    Math.max(0, frameCeil(requestedRange[0], fps)),
    Math.min(frameCeil(requestedRange[1], fps), timelineEnd)
  ]
}

function isCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.toLowerCase().includes('cancelled')
}

function cancelJob(job: JobProgress | null): void {
  if (job?.kind !== 'export' || !['queued', 'running'].includes(job.state)) return
  void window.otc.cancelJob(job.id).catch(() => undefined)
}

export interface FacePreviewState {
  rendering: boolean
  renderedPreviews: RenderedFacePreview[]
  // Kept as the most recently completed result for callers that only need a
  // status value; Preview selects from renderedPreviews by playhead.
  renderedPreview: RenderedFacePreview | null
  start: (session: EditSession) => Promise<void>
  invalidate: () => void
}

export function useFacePreview(
  session: EditSession | null,
  job: JobProgress | null,
  showError: (message: string) => void,
  previewRange?: [number, number]
): FacePreviewState {
  const [rendering, setRendering] = useState(false)
  const [storedPreviews, setStoredPreviews] = useState<StoredFacePreview[]>([])
  const generation = useRef(0)
  const activeGeneration = useRef<number | null>(null)
  const cancelledGeneration = useRef<number | null>(null)
  const previewJobId = useRef<string | null>(null)
  const baselineJobId = useRef<string | null>(null)
  const previewOutputKey = useRef<string | null>(null)
  const previewContentKey = useRef(contentRenderKey(session))
  const activePreviewRange = useRef<[number, number] | null>(null)
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionRef = useRef(session)
  const jobRef = useRef(job)
  const errorRef = useRef(showError)
  sessionRef.current = session
  jobRef.current = job
  errorRef.current = showError

  // Preview scope is captured when start() is called, so playhead and panel/mark selection changes
  // do not invalidate an already rendered result.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const contentKey = useMemo(() => contentRenderKey(session), [
    session?.canvas,
    session?.sources,
    session?.segments,
    session?.overlays,
    session?.focusZooms,
    session?.videoTransitions
  ])
  const outputKey = useMemo(
    () => JSON.stringify({ content: contentKey, faceBlurs: session?.faceBlurs }),
    [contentKey, session?.faceBlurs]
  )
  const faceBlursKey = useMemo(() => JSON.stringify(session?.faceBlurs ?? []), [session?.faceBlurs])

  const clearRestoreTimer = useCallback((): void => {
    if (restoreTimer.current === null) return
    clearTimeout(restoreTimer.current)
    restoreTimer.current = null
  }, [])

  const invalidate = useCallback((clearAll = false): void => {
    generation.current += 1
    clearRestoreTimer()
    const range = clearAll ? null : activePreviewRange.current
    setStoredPreviews((current) => range
      ? current.filter(({ result }) => !samePreviewRange(result, range))
      : [])
    previewOutputKey.current = null
    const active = activeGeneration.current
    if (active === null) {
      setRendering(false)
      return
    }
    if (cancelledGeneration.current === active) return
    cancelledGeneration.current = active
    if (previewJobId.current === jobRef.current?.id) cancelJob(jobRef.current)
  }, [clearRestoreTimer])

  useEffect(() => {
    if (previewContentKey.current === contentKey) return
    previewContentKey.current = contentKey
    invalidate(true)
  }, [contentKey, invalidate])

  useEffect(() => {
    const currentFaceBlurs = sessionRef.current?.faceBlurs ?? []
    setStoredPreviews((current) => current.filter((preview) => previewMatchesFaceBlurs(preview, currentFaceBlurs)))
  }, [faceBlursKey])

  const restore = useCallback(async (current: EditSession, currentOutputKey: string, restoreGeneration: number): Promise<void> => {
    if (restoreGeneration !== generation.current || renderKey(sessionRef.current) !== currentOutputKey) return
    try {
      const request = await prepareExportRequest(current, previewOutputPath)
      if (restoreGeneration !== generation.current || renderKey(sessionRef.current) !== currentOutputKey) return
      const results = await window.otc.restoreFacePreview(request)
      if (restoreGeneration !== generation.current || renderKey(sessionRef.current) !== currentOutputKey) return
      previewOutputKey.current = currentOutputKey
      if (results.length > 0) {
        const restored = results.map((result) => ({ result, faceBlurs: faceBlursSnapshot(current) }))
        setStoredPreviews((previews) => [
          ...previews.filter(({ result: existing }) => !restored.some(({ result: candidate }) => samePreviewRange(existing, [candidate.start, candidate.end]))),
          ...restored
        ])
      }
    } catch {
      // A missing or invalid persisted preview is an expected cache miss. The next Apply
      // action will create a fresh preview; restoring a project must stay quiet and cheap.
      if (restoreGeneration === generation.current && renderKey(sessionRef.current) === currentOutputKey) {
        previewOutputKey.current = currentOutputKey
      }
    }
  }, [])

  useEffect(() => {
    if (previewOutputKey.current === outputKey) return
    clearRestoreTimer()
    const current = sessionRef.current
    if (!outputKey || !current?.faceBlurs?.length) return
    const restoreGeneration = generation.current
    restoreTimer.current = setTimeout(() => {
      restoreTimer.current = null
      void restore(current, outputKey, restoreGeneration)
    }, restoreDebounceMs)
    return clearRestoreTimer
  }, [outputKey, clearRestoreTimer, restore])

  useEffect(() => {
    const active = activeGeneration.current
    if (active === null || job?.kind !== 'export' || job.id === baselineJobId.current) return
    previewJobId.current = job.id
    if (cancelledGeneration.current === active) cancelJob(job)
  }, [job])

  const start = useCallback(async (current: EditSession): Promise<void> => {
    if (activeGeneration.current !== null) return
    clearRestoreTimer()
    const currentGeneration = ++generation.current
    const currentOutputKey = renderKey(current)
    const currentContentKey = contentRenderKey(current)
    const currentFaceBlurs = faceBlursSnapshot(current)
    const requestedRange = previewRange ?? deletionRange(current)
    const capturedRange = capturedPreviewRange(current, requestedRange)
    activeGeneration.current = currentGeneration
    activePreviewRange.current = capturedRange
    previewContentKey.current = currentContentKey
    previewOutputKey.current = currentOutputKey
    cancelledGeneration.current = null
    previewJobId.current = null
    baselineJobId.current = jobRef.current?.id ?? null
    setStoredPreviews((previews) => previews
      .filter((preview) => previewMatchesFaceBlurs(preview, currentFaceBlurs))
      .filter(({ result }) => !samePreviewRange(result, capturedRange)))
    setRendering(true)
    try {
      const request = await prepareExportRequest(current, previewOutputPath)
      if (currentGeneration !== generation.current) return
      const mediaUrl = await window.otc.previewFaces({
        ...request,
        previewRange: requestedRange ? capturedRange : undefined
      })
      if (currentGeneration === generation.current && renderKey(sessionRef.current) === currentOutputKey) {
        const result = { url: mediaUrl, start: capturedRange[0], end: capturedRange[1] }
        setStoredPreviews((previews) => [
          ...previews.filter(({ result: existing }) => !samePreviewRange(existing, capturedRange)),
          { result, faceBlurs: currentFaceBlurs }
        ])
      }
    } catch (error) {
      if (currentGeneration === generation.current && !isCancelled(error)) {
        errorRef.current(`OneTrackCat could not render the face-blur preview. ${String(error).slice(0, 800)}`)
      }
    } finally {
      if (activeGeneration.current === currentGeneration) {
        activeGeneration.current = null
        activePreviewRange.current = null
        previewJobId.current = null
        baselineJobId.current = null
        setRendering(false)
      }
    }
  }, [clearRestoreTimer, previewRange])

  useEffect(() => () => {
    generation.current += 1
    clearRestoreTimer()
    activeGeneration.current = null
    activePreviewRange.current = null
  }, [clearRestoreTimer])

  const renderedPreviews = storedPreviews.map(({ result }) => result)
  const renderedPreview = renderedPreviews[renderedPreviews.length - 1] ?? null
  return { rendering, renderedPreviews, renderedPreview, start, invalidate }
}
