import { useEffect, useRef } from 'react'
import type { NarrationReview } from '@shared/narration-api'
import { narrationMaxTextLength } from '@shared/narration'
import { formatTime } from '../model/timeline'
import './narration-transcript.css'

function speedChange(tempo: number | undefined): string {
  if (tempo === undefined || !Number.isFinite(tempo) || tempo <= 0) return ''
  const percent = Math.round((tempo - 1) * 1000) / 10
  if (percent === 0) return '0% faster'
  return `${Math.abs(percent)}% ${percent > 0 ? 'faster' : 'slower'}`
}

export function NarrationTranscript({ open, draft, playhead, error, onEdit, onClose, onRetry, retryDisabled, retryFrom = 0 }: {
  open: boolean
  draft: NarrationReview
  playhead?: number
  error?: string
  onEdit: (id: string, value: string) => void
  onClose: () => void
  onRetry?: () => void
  retryDisabled?: boolean
  retryFrom?: number
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const position = (playhead ?? draft.range[0]) - draft.range[0]
  const nextPhrase = draft.phrases.findIndex((phrase) => phrase.end > position)
  const currentPhrase = nextPhrase < 0 ? draft.phrases.length - 1 : nextPhrase
  useEffect(() => {
    const element = dialog.current
    if (!element || !open) return
    const previous = document.activeElement
    element.showModal()
    const field = element.querySelector<HTMLElement>('textarea[aria-invalid="true"]:not([readonly])') ??
      element.querySelector<HTMLElement>('textarea[data-playhead]:not([readonly])') ??
      element.querySelector<HTMLElement>('textarea:not([readonly])')
    // Position only on opening; typing must not pull the editor back to the playhead.
    field?.focus({ preventScroll: true })
    field?.closest('.transcript-phrase')?.scrollIntoView({ block: 'center' })
    return () => {
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])
  return <dialog ref={dialog} className="confirmation-dialog transcript-dialog" aria-labelledby="narration-transcript-title"
    onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); onClose() }}>
    <header className="transcript-heading"><h2 id="narration-transcript-title">Edit narration transcript</h2></header>
    {error && <p role="alert">{error}</p>}
    <div className="transcript-scroll">
      {!draft.phrases.length && <p>No speech starts in this section.</p>}
      {draft.phrases.map((phrase, index) => {
        const speed = speedChange(phrase.generatedTempo)
        const overrun = draft.overruns?.find((issue) => issue.id === phrase.id)
        const readOnly = !!onRetry && index < retryFrom
        return <label className={`stacked-control transcript-phrase${overrun ? ' transcript-overrun' : ''}`} key={phrase.id}>
          <span>{formatTime(phrase.start + draft.range[0])} – {formatTime(phrase.end + draft.range[0])}
            {speed && <small className="empty-note" title="Speed applied during generation"> · {speed}</small>}
          </span>
          {readOnly && <span className="empty-note">Already generated · read-only</span>}
          {phrase.needsTimingReview && <span role="alert">Uncertain speech timing. Recognize a clearer selection.</span>}
          {overrun && <span role="alert" id={`overrun-${phrase.id}`}>
            Phrase {index + 1}: {(Math.ceil(overrun.extraSeconds * 10) / 10).toFixed(1)} s too long after maximum speed adjustment.
          </span>}
          <textarea aria-label={`Revised phrase ${index + 1}`} readOnly={readOnly} data-playhead={index === currentPhrase || undefined}
            title="Use [500ms] or [1s] for a pause"
            aria-invalid={overrun ? true : undefined} aria-describedby={overrun ? `overrun-${phrase.id}` : undefined}
            maxLength={narrationMaxTextLength} value={phrase.revisedText}
            onChange={(event) => { if (!readOnly) onEdit(phrase.id, event.target.value) }} />
        </label>
      })}
    </div>
    <footer className="transcript-footer">
      {onRetry ? <button disabled={retryDisabled} onClick={onRetry}>Retry generation</button>
        : <button onClick={onClose}>Apply</button>}
    </footer>
  </dialog>
}
