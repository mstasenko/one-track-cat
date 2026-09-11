import { useEffect, useRef } from 'react'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}

function restoreFocus(target: HTMLElement | null): void {
  if (!target?.isConnected) return
  try {
    target.focus({ preventScroll: true })
  } catch {
    target.focus()
  }
}

export function ConfirmDialog({ open, title, description, confirmLabel, onCancel, onConfirm }: ConfirmDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

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
    } else if (dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog"
      data-confirm-dialog
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-description"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        event.preventDefault()
        const controls = [cancelRef.current, confirmRef.current].filter((control): control is HTMLButtonElement => control !== null)
        if (!controls.length) return
        const current = controls.indexOf(document.activeElement as HTMLButtonElement)
        const direction = event.shiftKey ? -1 : 1
        controls[(current + direction + controls.length) % controls.length]?.focus()
      }}
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
      onClose={() => {
        const target = returnFocusRef.current
        returnFocusRef.current = null
        restoreFocus(target)
      }}
    >
      <section className="confirmation-dialog-panel">
        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-description">{description}</p>
        <div className="confirmation-dialog-actions">
          <button type="button" data-confirm-cancel ref={cancelRef} onClick={onCancel}>Cancel</button>
          <button type="button" data-confirm-submit ref={confirmRef} className="confirmation-dialog-destructive" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </dialog>
  )
}
