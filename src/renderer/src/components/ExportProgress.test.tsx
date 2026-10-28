import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobProgress } from '@shared/types'
import { ExportProgress } from './ExportProgress'

let root: Root
let container: HTMLDivElement
const job: JobProgress = { id: 'export', kind: 'export', state: 'running', progress: 0.4,
  message: 'Upscaling video using dGPU: 40%', phase: 'upscaling', etaSeconds: 100 }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(current = job, onCancel?: () => void): HTMLButtonElement {
  act(() => root.render(<ExportProgress exporting job={current} onCancel={onCancel} />))
  const button = container.querySelector('button')
  if (!button) throw new Error('Cancel button missing')
  return button
}

describe('Export progress', () => {
  it('acknowledges cancellation immediately while the GPU drains', () => {
    const cancelJob = vi.fn(() => new Promise<void>(() => undefined))
    vi.stubGlobal('otc', { cancelJob })
    const button = render()
    act(() => button.click())
    expect(cancelJob).toHaveBeenCalledExactlyOnceWith('export')
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Cancelling…')
    expect(container.textContent).toContain('waiting for processing to stop safely')
    expect(container.textContent).not.toContain('100s remaining')
    render({ ...job, progress: 0.5, message: 'Upscaling video: 50%' })
    expect(button.disabled).toBe(true)
    act(() => button.click())
    expect(cancelJob).toHaveBeenCalledOnce()
    render({ ...job, id: 'next-export' })
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('Cancel')
  })

  it('also acknowledges cancellation through the face-preview callback', () => {
    const onCancel = vi.fn()
    const button = render(job, onCancel)
    act(() => button.click())
    expect(onCancel).toHaveBeenCalledOnce()
    expect(button.disabled).toBe(true)
  })

  it('allows retry when the cancellation request fails', async () => {
    const cancelJob = vi.fn().mockRejectedValue(new Error('IPC failed'))
    vi.stubGlobal('otc', { cancelJob })
    const button = render()
    await act(async () => { button.click(); await Promise.resolve() })
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('Cancel')
  })
})
