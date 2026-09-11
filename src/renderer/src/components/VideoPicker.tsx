import { useCallback, useEffect, useRef, useState } from 'react'
import type { VideoDirectory, VideoDirectoryEntry } from '@shared/video-picker'
import { finishVideoChoice, useVideoPickerStore } from '../model/video-picker'

const previewDebounceMs = 150
const previewDurationSeconds = 5

function stopVideo(video: HTMLVideoElement | null): void {
  if (!video) return
  video.pause()
  video.removeAttribute('src')
  video.load()
}

function restoreFocus(target: HTMLElement | null): void {
  if (!target?.isConnected) return
  try {
    target.focus({ preventScroll: true })
  } catch {
    target.focus()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function VideoPicker(): React.JSX.Element {
  const open = useVideoPickerStore((state) => state.open)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const openRef = useRef(open)
  const directoryRequestRef = useRef(0)
  const selectionRequestRef = useRef(0)
  const previewGenerationRef = useRef(0)
  const activePreviewGenerationRef = useRef<number | null>(null)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoveredPathRef = useRef<string | null>(null)
  const focusedPathRef = useRef<string | null>(null)
  const [directory, setDirectory] = useState<VideoDirectory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewingPath, setPreviewingPath] = useState<string | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [fallbackBusy, setFallbackBusy] = useState(false)
  openRef.current = open

  const clearPreviewTimer = useCallback((): void => {
    if (previewTimerRef.current === null) return
    clearTimeout(previewTimerRef.current)
    previewTimerRef.current = null
  }, [])

  const stopPreview = useCallback((): void => {
    clearPreviewTimer()
    previewGenerationRef.current += 1
    activePreviewGenerationRef.current = null
    stopVideo(videoRef.current)
    setPreviewingPath(null)
  }, [clearPreviewTimer])

  const previewIsCurrent = useCallback((generation: number): boolean => (
    openRef.current && generation === previewGenerationRef.current
  ), [])

  const startPreview = useCallback(async (path: string, generation: number): Promise<void> => {
    try {
      const authorized = await window.otc.authorizeVideo(path)
      if (!previewIsCurrent(generation)) return
      const url = await window.otc.getPathUrl(authorized)
      if (!previewIsCurrent(generation)) return
      const video = videoRef.current
      if (!video) return
      video.muted = true
      video.loop = true
      video.src = url
      video.load()
      activePreviewGenerationRef.current = generation
      await video.play()
      // The video node is shared; an old play promise must not tear down a newer owner.
      if (!previewIsCurrent(generation) && activePreviewGenerationRef.current === generation) {
        activePreviewGenerationRef.current = null
        stopVideo(video)
      }
    } catch (cause) {
      if (previewIsCurrent(generation)) {
        if (activePreviewGenerationRef.current === generation) {
          activePreviewGenerationRef.current = null
          stopVideo(videoRef.current)
        }
        setError(`Preview unavailable. ${errorMessage(cause).slice(0, 240)}`)
      }
    }
  }, [previewIsCurrent])

  const schedulePreview = useCallback((path: string): void => {
    clearPreviewTimer()
    previewGenerationRef.current += 1
    activePreviewGenerationRef.current = null
    const generation = previewGenerationRef.current
    stopVideo(videoRef.current)
    setError(null)
    setPreviewingPath(path)
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null
      void startPreview(path, generation)
    }, previewDebounceMs)
  }, [clearPreviewTimer, startPreview])

  const applyPreviewIntent = useCallback((): void => {
    const path = hoveredPathRef.current ?? focusedPathRef.current
    if (path) schedulePreview(path)
    else stopPreview()
  }, [schedulePreview, stopPreview])

  const invalidateRequests = useCallback((): void => {
    directoryRequestRef.current += 1
    selectionRequestRef.current += 1
    hoveredPathRef.current = null
    focusedPathRef.current = null
  }, [])

  const loadDirectory = useCallback(async (requested?: string): Promise<void> => {
    if (!openRef.current) return
    const request = ++directoryRequestRef.current
    selectionRequestRef.current += 1
    hoveredPathRef.current = null
    focusedPathRef.current = null
    stopPreview()
    setDirectory(null)
    setLoading(true)
    setError(null)
    try {
      const result = await window.otc.listVideoDirectory(requested)
      if (request !== directoryRequestRef.current) return
      setDirectory(result)
    } catch (cause) {
      if (request === directoryRequestRef.current) {
        setError(`Could not open this folder. ${errorMessage(cause).slice(0, 320)}`)
      }
    } finally {
      if (request === directoryRequestRef.current) setLoading(false)
    }
  }, [stopPreview])

  const finish = useCallback((path: string | null): void => {
    invalidateRequests()
    stopPreview()
    setBusyPath(null)
    setFallbackBusy(false)
    finishVideoChoice(path)
  }, [invalidateRequests, stopPreview])

  const selectVideo = useCallback(async (path: string): Promise<void> => {
    const request = ++selectionRequestRef.current
    stopPreview()
    setBusyPath(path)
    setError(null)
    try {
      const authorized = await window.otc.authorizeVideo(path)
      if (!openRef.current || request !== selectionRequestRef.current) return
      finish(authorized)
    } catch (cause) {
      if (openRef.current && request === selectionRequestRef.current) {
        setError(`Could not open this video. ${errorMessage(cause).slice(0, 320)}`)
      }
    } finally {
      if (request === selectionRequestRef.current) setBusyPath(null)
    }
  }, [finish, stopPreview])

  const browseVideo = useCallback(async (): Promise<void> => {
    const request = ++selectionRequestRef.current
    stopPreview()
    setFallbackBusy(true)
    setError(null)
    try {
      const selected = await window.otc.openVideo()
      if (!selected || !openRef.current || request !== selectionRequestRef.current) return
      finish(selected)
    } catch (cause) {
      if (openRef.current && request === selectionRequestRef.current) {
        setError(`Could not open this video. ${errorMessage(cause).slice(0, 320)}`)
      }
    } finally {
      if (request === selectionRequestRef.current) setFallbackBusy(false)
    }
  }, [finish, stopPreview])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      if (!returnFocusRef.current) {
        const active = document.activeElement
        returnFocusRef.current = active instanceof HTMLElement && active !== dialog ? active : null
      }
      if (!dialog.open) dialog.showModal()
      cancelRef.current?.focus()
      void loadDirectory()
      return
    }
    invalidateRequests()
    stopPreview()
    setDirectory(null)
    setLoading(false)
    setBusyPath(null)
    setFallbackBusy(false)
    if (dialog.open) dialog.close()
  }, [open, invalidateRequests, loadDirectory, stopPreview])

  useEffect(() => () => {
    invalidateRequests()
    stopPreview()
    finishVideoChoice(null)
  }, [invalidateRequests, stopPreview])

  const handleClose = useCallback((): void => {
    if (openRef.current) finish(null)
    const target = returnFocusRef.current
    returnFocusRef.current = null
    restoreFocus(target)
  }, [finish])

  const handleEntryMouseEnter = useCallback((entry: VideoDirectoryEntry): void => {
    if (entry.kind !== 'video') return
    hoveredPathRef.current = entry.path
    applyPreviewIntent()
  }, [applyPreviewIntent])

  const handleEntryMouseLeave = useCallback((entry: VideoDirectoryEntry): void => {
    if (entry.kind !== 'video' || hoveredPathRef.current !== entry.path) return
    hoveredPathRef.current = null
    applyPreviewIntent()
  }, [applyPreviewIntent])

  const handleEntryFocus = useCallback((entry: VideoDirectoryEntry): void => {
    if (entry.kind !== 'video') return
    focusedPathRef.current = entry.path
    applyPreviewIntent()
  }, [applyPreviewIntent])

  const handleEntryBlur = useCallback((entry: VideoDirectoryEntry): void => {
    if (entry.kind !== 'video' || focusedPathRef.current !== entry.path) return
    focusedPathRef.current = null
    applyPreviewIntent()
  }, [applyPreviewIntent])

  return (
    <dialog
      ref={dialogRef}
      className="video-picker-dialog"
      data-video-picker
      role="dialog"
      aria-modal="true"
      aria-labelledby="video-picker-title"
      onCancel={(event) => { event.preventDefault(); finish(null) }}
      onClose={handleClose}
    >
      <section className="video-picker-panel">
        <h2 id="video-picker-title">Open a video</h2>
        <div className="video-picker-location">
          <button
            type="button"
            aria-label="Go to parent folder"
            disabled={loading || fallbackBusy || !directory?.parent}
            onClick={() => { if (directory?.parent) void loadDirectory(directory.parent) }}
          >
            ↑ Up
          </button>
          <code title={directory?.path}>{directory?.path ?? (loading ? 'Loading…' : 'No folder selected')}</code>
        </div>
        {error && <p className="video-picker-error" role="alert">{error}</p>}
        <div className="video-picker-browser" aria-busy={loading}>
          {loading && <p className="video-picker-status">Loading folder…</p>}
          {!loading && directory && directory.entries.length === 0 && <p className="video-picker-status">No videos in this folder.</p>}
          {!loading && directory?.entries.map((entry) => entry.kind === 'directory'
            ? <button
                type="button"
                className="video-picker-entry video-picker-directory"
                key={entry.path}
                onClick={() => void loadDirectory(entry.path)}
                title={entry.path}
              >
                📁 {entry.name}
              </button>
            : <button
                type="button"
                className="video-picker-entry video-picker-video"
                key={entry.path}
                data-video-path={entry.path}
                aria-busy={busyPath === entry.path}
                onClick={() => void selectVideo(entry.path)}
                onMouseEnter={() => handleEntryMouseEnter(entry)}
                onMouseLeave={() => handleEntryMouseLeave(entry)}
                onFocus={() => handleEntryFocus(entry)}
                onBlur={() => handleEntryBlur(entry)}
                title={entry.path}
              >
                🎞 {entry.name}
              </button>)}
        </div>
        {directory?.truncated && <p className="video-picker-truncated" role="status">This folder has more entries than can be shown.</p>}
        <aside className="video-picker-preview" aria-label={previewingPath ? `Preview of ${previewingPath}` : 'Video preview'}>
          {!previewingPath && <p className="video-picker-preview-placeholder">Hover a video to preview it</p>}
          <video
            ref={videoRef}
            muted
            loop
            playsInline
            preload="none"
            onTimeUpdate={(event) => {
              if (event.currentTarget.currentTime >= previewDurationSeconds) event.currentTarget.currentTime = 0
            }}
            onError={() => {
              if (previewingPath && activePreviewGenerationRef.current === previewGenerationRef.current) {
                setError('Preview unavailable for this video.')
              }
            }}
          />
        </aside>
        <div className="video-picker-actions">
          <button type="button" onClick={() => void browseVideo()} disabled={fallbackBusy}>
            {fallbackBusy ? 'Opening…' : 'Browse…'}
          </button>
          <button type="button" ref={cancelRef} onClick={() => finish(null)}>Cancel</button>
        </div>
      </section>
    </dialog>
  )
}
