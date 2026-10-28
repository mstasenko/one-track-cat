import { useEffect, useRef, useState } from 'react'
import { upscaleExportPresentation, type UpscaleSelection } from './upscale-export-presentation'
import { upscalePlan, isFlashSpatialSupported } from '@shared/upscale'
import type { UpscaleMode, UpscaleOptions, UpscaleModelDownloadProgress, UpscalePackStatus, ExportRequest, FocusZoomEffect, ProjectCanvas } from '@shared/types'

export type UpscaleModelDownloadProgressCallback = (progress: UpscaleModelDownloadProgress) => void

export interface UpscaleDialogProps {
  open: boolean
  canvas: ProjectCanvas
  focusZooms?: FocusZoomEffect[]
  timeline?: Pick<ExportRequest, 'sources' | 'segments'>
  defaultOutputName?: string
  getUpscalePackStatus: (spatial?: boolean, mode?: UpscaleMode) => Promise<UpscalePackStatus>
  onBrowse?: () => Promise<string | null>
  onCancel: () => void
  onStart: (upscale?: UpscaleOptions, outputPath?: string) => void
  startModelDownload?: (mode?: UpscaleMode) => Promise<void>
  cancelModelDownload?: () => void
  subscribeModelDownload?: (callback: UpscaleModelDownloadProgressCallback) => () => void
}

interface DownloadSession {
  stale: boolean
  cancelRequested: boolean
  promise: Promise<void>
  upscale: UpscaleOptions
  outputPath?: string
  unsubscribe?: () => void
}


function sessionIsCurrent(session: DownloadSession, current: DownloadSession | null): boolean {
  return !session.stale && current === session
}

function sessionWasCanceled(session: DownloadSession): boolean {
  return session.cancelRequested
}

function unsubscribeDownload(session: DownloadSession): void {
  const unsubscribe = session.unsubscribe
  session.unsubscribe = undefined
  try {
    unsubscribe?.()
  } catch {
    // A stale subscription must never keep the dialog open.
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}

function safeNumber(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function formatBytes(value: number): string {
  const bytes = Math.round(safeNumber(value))
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
  return `${(bytes / 1_000_000_000).toFixed(bytes < 10_000_000_000 ? 1 : 0)} GB`
}

function formatSpeed(value: number | null): string {
  return value !== null && Number.isFinite(value) && value > 0
    ? `${formatBytes(value)}/s`
    : 'Estimating speed…'
}

function formatEta(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Estimating time remaining…'
  if (value < 1) return 'Less than a second remaining'
  const seconds = Math.ceil(value)
  if (seconds < 60) return `${seconds}s remaining`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes}m remaining` : `${minutes}m ${remainder}s remaining`
}

function initialDownloadProgress(status: UpscalePackStatus): UpscaleModelDownloadProgress {
  const totalBytes = safeNumber(status.downloadBytes, 1) || 1
  return {
    phase: 'downloading',
    name: 'Upscaling model',
    downloadedBytes: 0,
    totalBytes,
    percent: 0,
    bytesPerSecond: null,
    etaSeconds: null
  }
}

function restoreFocus(target: HTMLElement | null): void {
  if (!target?.isConnected) return
  try {
    target.focus({ preventScroll: true })
  } catch {
    target.focus()
  }
}

export function UpscaleDialog({
  open,
  canvas,
  focusZooms,
  timeline,
  defaultOutputName,
  getUpscalePackStatus,
  onBrowse,
  onCancel,
  onStart,
  startModelDownload,
  cancelModelDownload,
  subscribeModelDownload
}: UpscaleDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const outputPathRef = useRef<HTMLInputElement>(null)
  const browseRef = useRef<HTMLButtonElement>(null)
  const selectorRef = useRef<HTMLSelectElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const startRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const downloadSessionRef = useRef<DownloadSession | null>(null)
  const plan = upscalePlan(canvas, 'turbo', focusZooms, timeline)
  const needsSpatial = plan.spatial
  const spatialSupported = isFlashSpatialSupported(plan)
  const needsInterpolation = plan.interpolate
  const needsUpscale = needsSpatial || needsInterpolation
  const [selection, setSelection] = useState<UpscaleSelection>('off')
  const selectedMode = selection === 'base' ? 'base' : 'turbo'
  const [outputPath, setOutputPath] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [pathError, setPathError] = useState<string | null>(null)
  const [packStatus, setPackStatus] = useState<UpscalePackStatus | null>(null)
  const checkingPack = open && needsUpscale && spatialSupported && packStatus === null
  const [downloadProgress, setDownloadProgress] = useState<UpscaleModelDownloadProgress | null>(null)
  const [downloadActive, setDownloadActive] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const resetKey = `${open}:${needsUpscale}:${needsSpatial}:${spatialSupported}`
  const [previousResetKey, setPreviousResetKey] = useState(resetKey)
  if (previousResetKey !== resetKey) {
    setPreviousResetKey(resetKey)
    setSelection('off')
    setOutputPath('')
    setBrowsing(false)
    setPathError(null)
    setPackStatus(null)
    setDownloadProgress(null)
    setDownloadActive(false)
    setDownloadError(null)
  }
  const [previousMode, setPreviousMode] = useState(selectedMode)
  if (previousMode !== selectedMode) {
    setPreviousMode(selectedMode)
    setPackStatus(null)
  }

  useEffect(() => {
    const dialog = dialogRef.current
    const cleanup = (): void => {
      const session = downloadSessionRef.current
      if (session) {
        session.stale = true
        unsubscribeDownload(session)
        downloadSessionRef.current = null
        try { cancelModelDownload?.() } catch { /* The owner still retires stale callbacks. */ }
      }
    }
    if (!dialog) return cleanup
    if (!open) {
      if (dialog.open) dialog.close()
      return cleanup
    }
    if (!returnFocusRef.current) {
      const active = document.activeElement
      returnFocusRef.current = active instanceof HTMLElement && active !== dialog ? active : null
    }
    if (!dialog.open) dialog.showModal()
    cancelRef.current?.focus()
    return cleanup
  }, [cancelModelDownload, needsUpscale, needsSpatial, open, spatialSupported])

  useEffect(() => {
    let current = true
    if (!open || !needsUpscale || !spatialSupported) return
    const status = needsSpatial ? getUpscalePackStatus(true, selectedMode) : getUpscalePackStatus(false)
    void status
      .then((status) => {
        if (!current) return
        setPackStatus(status)
      })
      .catch(() => {
        if (!current) return
        setPackStatus({ available: false, message: 'OneTrackCat could not check the Upscaling pack.' })
      })
    return () => { current = false }
  }, [getUpscalePackStatus, needsUpscale, needsSpatial, open, selectedMode, spatialSupported])

  const finishDownloadCancel = (session: DownloadSession): void => {
    if (session.stale || downloadSessionRef.current !== session) return
    unsubscribeDownload(session)
    downloadSessionRef.current = null
    setDownloadActive(false)
    setDownloadProgress(null)
    setDownloadError(null)
    onCancel()
  }

  const finishDownloadError = (session: DownloadSession, error: unknown): void => {
    if (session.stale || downloadSessionRef.current !== session) return
    unsubscribeDownload(session)
    downloadSessionRef.current = null
    setDownloadActive(false)
    setDownloadProgress(null)
    setDownloadError(errorMessage(error, 'The Upscaling model download failed. Try again.'))
  }

  const verifyDownloadedModel = async (session: DownloadSession): Promise<void> => {
    if (!sessionIsCurrent(session, downloadSessionRef.current)) return
    if (sessionWasCanceled(session)) {
      finishDownloadCancel(session)
      return
    }
    try {
      const status = session.upscale.mode
        ? await getUpscalePackStatus(true, session.upscale.mode)
        : await getUpscalePackStatus(false)
      if (!sessionIsCurrent(session, downloadSessionRef.current)) return
      if (sessionWasCanceled(session)) {
        finishDownloadCancel(session)
        return
      }
      if (!status.available) {
        throw new Error(status.message || 'The Upscaling model is still unavailable.')
      }
      setPackStatus(status)
      unsubscribeDownload(session)
      downloadSessionRef.current = null
      setDownloadActive(false)
      setDownloadProgress(null)
      setDownloadError(null)
      if (session.outputPath) onStart(session.upscale, session.outputPath)
      else onStart(session.upscale)
    } catch (error) {
      if (sessionWasCanceled(session)) finishDownloadCancel(session)
      else finishDownloadError(session, error)
    }
  }

  const beginModelDownload = (): void => {
    const upscale = selectedUpscale()
    if (downloadSessionRef.current || !packStatus?.downloadable || !upscale) return
    setDownloadError(null)
    setDownloadProgress(initialDownloadProgress(packStatus))
    setDownloadActive(true)
    const session: DownloadSession = {
      stale: false,
      cancelRequested: false,
      promise: Promise.resolve(),
      upscale,
      outputPath: outputPath.trim() || undefined
    }
    downloadSessionRef.current = session
    const reportProgress = (progress: UpscaleModelDownloadProgress): void => {
      if (!session.stale && downloadSessionRef.current === session) setDownloadProgress(progress)
    }
    try {
      session.unsubscribe = subscribeModelDownload?.(reportProgress)
      if (!startModelDownload) throw new Error('AI model download is not available.')
      session.promise = Promise.resolve(startModelDownload(upscale.mode))
    } catch (error) {
      finishDownloadError(session, error)
      return
    }
    void session.promise.then(
      () => {
        if (session.cancelRequested) finishDownloadCancel(session)
        else void verifyDownloadedModel(session)
      },
      (error: unknown) => {
        if (session.cancelRequested) finishDownloadCancel(session)
        else finishDownloadError(session, error)
      }
    )
  }

  const selectedUpscale = (): UpscaleOptions | undefined => {
    if (!needsUpscale || selection === 'off' || (needsSpatial && !spatialSupported)) return undefined
    if (!needsSpatial) return {}
    return { mode: selection }
  }

  const handleStart = (): void => {
    const upscale = selectedUpscale()
    // Choosing a mode can precede verification; starting its export cannot.
    if (downloadActive || (upscale && checkingPack)) return
    if (!upscale || packStatus?.available) {
      const path = outputPath.trim()
      if (path) onStart(upscale, path)
      else onStart(upscale)
      return
    }
    if (packStatus?.downloadable) beginModelDownload()
  }

  const handleBrowse = async (): Promise<void> => {
    if (!onBrowse || browsing || downloadActive) return
    setBrowsing(true)
    setPathError(null)
    try {
      const selected = await onBrowse()
      if (selected) setOutputPath(selected)
    } catch (error) {
      setPathError(errorMessage(error, 'OneTrackCat could not open the file browser.'))
    } finally {
      setBrowsing(false)
    }
  }

  const handleCancel = (): void => {
    const session = downloadSessionRef.current
    if (!session || !downloadActive) {
      onCancel()
      return
    }
    if (session.cancelRequested) return
    session.cancelRequested = true
    try {
      cancelModelDownload?.()
    } catch {
      // The download promise remains authoritative for when cancellation is complete.
    }
    setDownloadError(null)
  }

  const { upscaleDisabled, statusMessage, selectionOptions, modeDescription, progressPercent, progressStatus } =
    upscaleExportPresentation({ needsUpscale, needsSpatial, spatialSupported, needsInterpolation, closeupsOnly: Boolean(plan.spatialRanges), checkingPack,
      downloadActive, packStatus, downloadError, selection, downloadProgress })

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog"
      data-upscale-export-dialog
      role="dialog"
      aria-modal="true"
      aria-labelledby="upscale-export-dialog-title"
      aria-describedby="upscale-export-dialog-description"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        event.preventDefault()
        const controls = [outputPathRef.current, browseRef.current, selectorRef.current, cancelRef.current, startRef.current]
          .filter((control): control is HTMLInputElement | HTMLSelectElement | HTMLButtonElement => control !== null && !control.disabled)
        if (!controls.length) return
        const currentIndex = controls.indexOf(document.activeElement as HTMLSelectElement | HTMLButtonElement)
        const direction = event.shiftKey ? -1 : 1
        controls[(currentIndex + direction + controls.length) % controls.length]?.focus()
      }}
      onCancel={(event) => {
        event.preventDefault()
        handleCancel()
      }}
      onClose={() => {
        const target = returnFocusRef.current
        returnFocusRef.current = null
        restoreFocus(target)
      }}
    >
      <section className="confirmation-dialog-panel">
        <h2 id="upscale-export-dialog-title">Export video</h2>
        <p id="upscale-export-dialog-description">{modeDescription}</p>
        <label className="upscale-export-path-label" htmlFor="upscale-export-path">Output file or folder</label>
        <div className="upscale-export-path-row">
          <input
            ref={outputPathRef}
            id="upscale-export-path"
            data-upscale-export-path
            value={outputPath}
            placeholder={defaultOutputName ? `/path/to/${defaultOutputName}` : '/path/to/video.mp4'}
            spellCheck={false}
            disabled={downloadActive || browsing}
            onChange={(event) => { setOutputPath(event.currentTarget.value); setPathError(null) }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              handleStart()
            }}
          />
          <button ref={browseRef} type="button" disabled={!onBrowse || downloadActive || browsing} onClick={() => void handleBrowse()}>
            {browsing ? 'Opening…' : 'Browse…'}
          </button>
        </div>
        {pathError && <p className="upscale-export-path-error" role="alert">{pathError}</p>}
        <p>
          <label htmlFor="upscale-select">Upscale</label>{' '}
          <select
            ref={selectorRef}
            id="upscale-select"
            value={selection}
            disabled={upscaleDisabled}
            onChange={(event) => setSelection(event.currentTarget.value as UpscaleSelection)}
            aria-describedby={statusMessage ? 'upscale-export-pack-status' : progressStatus ? 'upscale-export-download-status' : 'upscale-export-dialog-description'}
            data-upscale-select
          >
            {selectionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </p>
        {statusMessage && <p id="upscale-export-pack-status" role="status">{statusMessage}</p>}
        {downloadProgress && downloadActive && (
          <div data-upscale-download-progress-container>
            <p id="upscale-export-download-status" role="status">{progressStatus}</p>
            <div className="export-progress-track upscale-export-progress-track">
              <progress
                data-upscale-download-progress
                aria-label={progressStatus ?? 'AI model download progress'}
                aria-valuetext={`${progressPercent.toFixed(0)}%`}
                max={100}
                value={progressPercent}
              />
              <span className="export-scanner" aria-hidden="true">
                <span className="export-scanner-sweep" />
              </span>
            </div>
            <div className="export-status upscale-export-download-status" aria-live="polite">
              <span data-upscale-download-bytes>{formatBytes(downloadProgress.downloadedBytes)} / {formatBytes(downloadProgress.totalBytes)}</span>
              <span data-upscale-download-speed>{formatSpeed(downloadProgress.bytesPerSecond)}</span>
              <span data-upscale-download-eta>{formatEta(downloadProgress.etaSeconds)}</span>
            </div>
          </div>
        )}
        <div className="confirmation-dialog-actions">
          <button type="button" ref={cancelRef} data-upscale-export-cancel onClick={handleCancel}>{downloadActive ? 'Cancel download' : 'Cancel'}</button>
          <button type="button" ref={startRef} data-upscale-export-start className="confirmation-dialog-destructive" disabled={downloadActive || (selection !== 'off' && checkingPack)} onClick={handleStart}>Start</button>
        </div>
      </section>
    </dialog>
  )
}
