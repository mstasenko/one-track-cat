import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

let root: Root | undefined
let container: HTMLDivElement | undefined
let originalShowModal: PropertyDescriptor | undefined
let originalClose: PropertyDescriptor | undefined

function renderDialog(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <ConfirmDialog
        open
        title="Reset project?"
        description="Your current edits will be forgotten."
        confirmLabel="Reset"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        {...props}
      />
    )
  })
  return container
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
  originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function close(this: HTMLDialogElement) {
      this.open = false
      this.dispatchEvent(new Event('close'))
    })
  })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close
  vi.restoreAllMocks()
})

describe('ConfirmDialog', () => {
  it('focuses Cancel by default, cancels, and restores focus after closing', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const onCancel = vi.fn()
    const app = renderDialog({ onCancel })
    const cancel = app.querySelector('[data-confirm-cancel]')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('cancel button missing')

    expect(document.activeElement).toBe(cancel)
    act(() => { cancel.click() })
    expect(onCancel).toHaveBeenCalledOnce()

    act(() => {
      root?.render(
        <ConfirmDialog
          open={false}
          title="Reset project?"
          description="Your current edits will be forgotten."
          confirmLabel="Reset"
          onCancel={onCancel}
          onConfirm={vi.fn()}
        />
      )
    })
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('cancels on Escape without confirming', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const app = renderDialog({ onCancel, onConfirm })
    const dialog = app.querySelector('dialog')
    if (!(dialog instanceof HTMLDialogElement)) throw new Error('dialog missing')

    const event = new Event('cancel', { bubbles: true, cancelable: true })
    act(() => { dialog.dispatchEvent(event) })

    expect(event.defaultPrevented).toBe(true)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('keeps Tab focus inside the dialog and cycles backward with Shift+Tab', () => {
    const app = renderDialog()
    const dialog = app.querySelector('dialog')
    const reset = app.querySelector('[data-confirm-submit]')
    const cancel = app.querySelector('[data-confirm-cancel]')
    if (!(dialog instanceof HTMLDialogElement) || !(reset instanceof HTMLButtonElement) || !(cancel instanceof HTMLButtonElement)) {
      throw new Error('dialog controls missing')
    }

    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => { dialog.dispatchEvent(forward) })
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(reset)

    const wrap = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => { dialog.dispatchEvent(wrap) })
    expect(document.activeElement).toBe(cancel)

    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    act(() => { dialog.dispatchEvent(backward) })
    expect(document.activeElement).toBe(reset)

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => { dialog.dispatchEvent(enter) })
    expect(enter.defaultPrevented).toBe(false)
  })

  it('calls the destructive action only from the explicit Reset button', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const app = renderDialog({ onCancel, onConfirm })
    const reset = app.querySelector('[data-confirm-submit]')
    if (!(reset instanceof HTMLButtonElement)) throw new Error('reset button missing')

    act(() => { reset.click() })

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
