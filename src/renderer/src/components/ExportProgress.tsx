import type { JobProgress } from '@shared/types'

function activeExportJob(job: JobProgress | null): JobProgress | null {
  return job?.kind === 'export' && (job.state === 'queued' || job.state === 'running') ? job : null
}

function progressMessage(job: JobProgress | null): string {
  const message = job?.message ?? 'Preparing export…'
  if (!job || job.phase !== 'encoding' || !/^\d+%$/.test(message)) return message
  const hardware = job.encodingHardwareLabel ?? job.hardwareLabel
  return hardware ? `Encoding video using ${hardware}: ${message}` : `Encoding video: ${message}`
}

function progressPhase(job: JobProgress | null): string {
  const message = job?.message.toLowerCase() ?? ''
  // A cached row is still in the masking phase, but it is not an inference
  // phase. Keep the status truthful when the worker has supplied both fields.
  if (message.includes('cached face analysis')) return 'Applying cached face analysis'
  if (message.includes('detecting faces')) return 'Detecting faces'
  switch (job?.phase) {
    case 'queued': return 'Queued'
    case 'starting': return 'Starting'
    case 'preparing': return 'Preparing'
    case 'masking': return 'Masking faces'
    case 'encoding': return 'Encoding video'
    case 'finalizing': return 'Finalizing export'
    case 'complete': return 'Complete'
    default: {
      if (message.includes('masking')) return 'Masking faces'
      if (message.includes('encoding')) return 'Encoding video'
      if (message.includes('finalizing')) return 'Finalizing export'
      return 'Preparing'
    }
  }
}

function formatEta(job: JobProgress | null): string {
  const seconds = job?.etaSeconds
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return 'Estimating time remaining…'
  if (seconds < 1) return 'Less than a second remaining'
  const rounded = Math.ceil(seconds)
  if (rounded < 60) return `${rounded}s remaining`
  const minutes = Math.floor(rounded / 60)
  const remainder = rounded % 60
  return remainder === 0 ? `${minutes}m remaining` : `${minutes}m ${remainder}s remaining`
}

export function ExportProgress({ exporting, job, title, onCancel }: {
  exporting: boolean
  job: JobProgress | null
  title?: string
  onCancel?: () => void
}): React.JSX.Element | null {
  if (!exporting) return null
  const activeJob = activeExportJob(job)
  return (
    <div className="modal-backdrop export-backdrop">
      <div className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-progress-title">
        <h2 id="export-progress-title">{title ?? 'Exporting video'}</h2>
        <div className="export-progress-track">
          {activeJob
            ? <progress aria-label="Export progress" max="1" value={activeJob.progress} />
            : <progress aria-label="Preparing export" />}
          <span className="export-scanner" aria-hidden="true">
            <span className="export-scanner-sweep" />
          </span>
        </div>
        <p>{progressMessage(activeJob)}</p>
        <div className="export-status" aria-live="polite">
          <span data-testid="export-phase">Phase: {progressPhase(activeJob)}</span>
          <span data-testid="export-eta">Stage ETA: {formatEta(activeJob)}</span>
        </div>
        <button autoFocus disabled={!activeJob} onClick={() => {
          if (onCancel) onCancel()
          else if (activeJob) void window.otc.cancelJob(activeJob.id).catch(() => undefined)
        }}>Cancel</button>
      </div>
    </div>
  )
}
