import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flashSpatialSupportMessage } from '@shared/ai-enhancement'
import type { AiEnhancementMode, AiModelDownloadProgress, AiPackStatus, ExportRequest, FocusZoomEffect, ProjectCanvas } from '@shared/types'
import { AiExportDialog } from './AiExportDialog'

let root: Root | undefined
let container: HTMLDivElement | undefined
let originalShowModal: PropertyDescriptor | undefined
let originalClose: PropertyDescriptor | undefined

interface DownloadOptions {
  canvas?: ProjectCanvas
  focusZooms?: FocusZoomEffect[]
  timeline?: Pick<ExportRequest, 'sources' | 'segments'>
  defaultOutputName?: string
  onBrowse?: () => Promise<string | null>
  startModelDownload?: (mode?: AiEnhancementMode) => Promise<void>
  cancelModelDownload?: () => void
  subscribeModelDownload?: (callback: (progress: AiModelDownloadProgress) => void) => () => void
}

function renderDialog(
  getAiPackStatus: (spatial?: boolean, mode?: AiEnhancementMode) => Promise<AiPackStatus>,
  onStart = vi.fn(),
  onCancel = vi.fn(),
  downloadOptions: DownloadOptions = {}
): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <AiExportDialog
        open
        canvas={downloadOptions.canvas ?? { width: 1920, height: 1080, fps: 30, fit: 'contain' }}
        getAiPackStatus={getAiPackStatus}
        onCancel={onCancel}
        onStart={onStart}
        {...downloadOptions}
      />
    )
  })
  return container
}

function selectMode(app: HTMLDivElement, mode: string): void {
  const selector = app.querySelector('[data-ai-enhance-select]')
  if (!(selector instanceof HTMLSelectElement)) throw new Error('AI enhancement selector missing')
  act(() => {
    selector.value = mode
    selector.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function setInputValue(input: HTMLInputElement, value: string): void {
  // React tracks the instance setter, so tests must call the native setter.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('Input value setter missing')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

describe('AiExportDialog', () => {
  it('checks and downloads Base without resetting the chosen mode', async () => {
    let installed = false
    const status = vi.fn<(spatial?: boolean, mode?: AiEnhancementMode) => Promise<AiPackStatus>>(
      () => Promise.resolve({ available: installed, downloadable: !installed, message: '', downloadBytes: 100 }))
    const download = vi.fn(() => { installed = true; return Promise.resolve() })
    const onStart = vi.fn()
    const app = renderDialog(status, onStart, vi.fn(), {
      startModelDownload: download,
      canvas: { width: 1080, height: 1920, fps: 30.000845, fit: 'contain' }
    })
    await settle()
    selectMode(app, 'base')
    await settle()
    expect(app.querySelector<HTMLSelectElement>('[data-ai-enhance-select]')?.value).toBe('base')
    expect(status).toHaveBeenLastCalledWith(true, 'base')
    act(() => { app.querySelector<HTMLButtonElement>('[data-ai-export-start]')?.click() })
    await settle()
    expect(download).toHaveBeenCalledWith('base')
    expect(status).toHaveBeenLastCalledWith(true, 'base')
    expect(onStart).toHaveBeenCalledWith({ mode: 'base' })
  })

  it('explains the Turbo and Base modes without promising an unqualified quality claim', async () => {
    const app = renderDialog(() => Promise.resolve({ available: true, message: 'ready' }))
    await settle()
    selectMode(app, 'turbo')
    expect(app.textContent).toContain('FlashVSR+ Turbo mode.')
    selectMode(app, 'base')
    await settle()
    expect(app.textContent).toContain('FlashVSR+ Base mode.')
  })

  it.each([
    ['AI first', 'typed'], ['filename first', 'typed'],
    ['AI first', 'Browse'], ['filename first', 'Browse']
  ])('allows %s with a %s filename while checking the model', async (order, method) => {
    const ready = deferred<AiPackStatus>()
    const onStart = vi.fn()
    const app = renderDialog(() => ready.promise, onStart, vi.fn(), {
      onBrowse: () => Promise.resolve('/exports/chosen.mp4')
    })
    const input = app.querySelector('[data-ai-export-path]')
    const start = app.querySelector('[data-ai-export-start]')
    const selector = app.querySelector<HTMLSelectElement>('[data-ai-enhance-select]')
    if (!(input instanceof HTMLInputElement) || !(start instanceof HTMLButtonElement)) throw new Error('Export path controls missing')
    expect(selector?.disabled).toBe(false)
    if (order === 'AI first') selectMode(app, 'base')
    if (method === 'typed') act(() => { setInputValue(input, '/exports/chosen.mp4') })
    else act(() => { [...app.querySelectorAll('button')].find((button) => button.textContent === 'Browse…')?.click() })
    await settle()
    if (order === 'filename first') selectMode(app, 'base')
    expect(input.value).toBe('/exports/chosen.mp4')
    expect(selector?.value).toBe('base')
    expect(start.disabled).toBe(true)
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onStart).not.toHaveBeenCalled()
    ready.resolve({ available: true, message: 'ready' })
    await settle()
    expect(start.disabled).toBe(false)
    act(() => { start.click() })
    expect(onStart).toHaveBeenCalledWith({ mode: 'base' }, '/exports/chosen.mp4')
  })

  it('starts ordinary export by default and disables enhancement when its pack is missing', async () => {
    const onStart = vi.fn()
    const app = renderDialog(() => Promise.resolve({ available: false, message: 'Install the optional AI pack.' }), onStart)
    await act(async () => { await Promise.resolve() })

    const selector = app.querySelector('[data-ai-enhance-select]')
    const start = app.querySelector('[data-ai-export-start]')
    if (!(selector instanceof HTMLSelectElement) || !(start instanceof HTMLButtonElement)) throw new Error('AI export controls missing')
    expect(selector.value).toBe('off')
    expect(selector.disabled).toBe(true)
    expect(app.textContent).toContain('Install the optional AI pack.')

    act(() => { start.click() })
    expect(onStart).toHaveBeenCalledWith(undefined)
  })

  it('derives the checking state from a pending pack-status request', async () => {
    const status = deferred<AiPackStatus>()
    const app = renderDialog(() => status.promise)
    const selector = app.querySelector('[data-ai-enhance-select]')
    if (!(selector instanceof HTMLSelectElement)) throw new Error('AI enhancement selector missing')

    expect(selector.disabled).toBe(false)
    expect(app.textContent).toContain('Checking AI enhancement availability…')

    await act(async () => {
      status.resolve({ available: true, message: 'ready' })
      await status.promise
    })

    expect(selector.disabled).toBe(false)
    expect(app.textContent).not.toContain('Checking AI enhancement availability…')
  })

  it('passes the selected Turbo mode and independent operations', async () => {
    const onStart = vi.fn()
    const app = renderDialog(() => Promise.resolve({ available: true, message: 'ready' }), onStart)
    await act(async () => { await Promise.resolve() })

    const selector = app.querySelector('[data-ai-enhance-select]')
    const start = app.querySelector('[data-ai-export-start]')
    if (!(selector instanceof HTMLSelectElement) || !(start instanceof HTMLButtonElement)) throw new Error('AI export controls missing')
    expect(selector.disabled).toBe(false)
    expect(Array.from(selector.options).map((option) => option.textContent)).toEqual(['Off', '4K60 · Turbo', '4K60 · Base'])
    selectMode(app, 'turbo')
    act(() => { start.click() })
    expect(onStart).toHaveBeenCalledWith({ mode: 'turbo' })
  })

  it.each([
    ['landscape below 4K', { width: 1920, height: 1080, fps: 60, fit: 'contain' }, ['Off', '4K · Turbo', '4K · Base'], false],
    ['portrait below 4K', { width: 1080, height: 1920, fps: 60, fit: 'contain' }, ['Off', '4K · Turbo', '4K · Base'], false],
    ['4K-source Short with close-ups', { width: 1080, height: 1920, fps: 60, fit: 'cover' }, ['Off', '4K · Turbo', '4K · Base'], false],
    ['portrait 4K target at source rate', { width: 1080, height: 1920, fps: 30.000845, fit: 'contain' }, ['Off', '4K60 · Turbo', '4K60 · Base'], false],
    ['landscape at 4K', { width: 3840, height: 2160, fps: 60, fit: 'contain' }, ['Already 4K60 or better'], true],
    ['4K with close-ups', { width: 3840, height: 2160, fps: 60, fit: 'contain' }, ['Off', '4K · Turbo', '4K · Base'], false],
    ['4K near 60 fps with close-ups', { width: 3840, height: 2160, fps: 58.4367, fit: 'contain' }, ['Off', '4K60 · Turbo', '4K60 · Base'], false],
    ['portrait at 4K', { width: 2160, height: 3840, fps: 60, fit: 'contain' }, ['Already 4K60 or better'], true],
    ['landscape above 4K', { width: 4096, height: 2160, fps: 60, fit: 'contain' }, ['Already 4K60 or better'], true],
    ['portrait above 4K', { width: 2160, height: 4096, fps: 60, fit: 'contain' }, ['Already 4K60 or better'], true],
    ['unsupported 4:3', { width: 1440, height: 1080, fps: 30, fit: 'contain' }, ['Off'], true],
    ['unsupported ultrawide', { width: 2560, height: 1080, fps: 30, fit: 'contain' }, ['Off'], true]
  ] as const)('adapts the selector to the %s canvas', async (_name, canvas, labels, disabled) => {
    const focusZooms: FocusZoomEffect[] = _name.includes('close-ups')
      ? [{ id: 'zoom', start: 1, duration: 2, zoom: 2, focusX: 0.5, focusY: 0.5 }] : []
    const timeline = _name.startsWith('4K-source') ? {
      sources: [{ id: '4k', metadata: { path: '/4k.mp4', name: '4k', size: 1, modifiedAt: 1,
        duration: 10, width: 3840, height: 2160, fps: 60, videoCodec: 'hevc', hasAudio: true } }],
      segments: [{ id: 'clip', sourceId: '4k', sourceStart: 0, sourceEnd: 10 }]
    } : undefined
    const app = renderDialog(() => Promise.resolve({ available: true, message: 'ready' }), vi.fn(), vi.fn(), { canvas, focusZooms, timeline })
    await settle()
    const selector = app.querySelector('[data-ai-enhance-select]')
    if (!(selector instanceof HTMLSelectElement)) throw new Error('AI enhancement selector missing')
    expect(Array.from(selector.options).map((option) => option.textContent)).toEqual(labels)
    expect(selector.disabled).toBe(disabled)
    if (focusZooms.length) expect(app.textContent).toContain('Enhance only close-ups at 4K')
    if (selector.disabled) {
      expect(selector.value).toBe('off')
      if (canvas.width < 3840 && canvas.height < 3840) {
        expect(app.textContent).toContain(flashSpatialSupportMessage)
      } else {
        expect(app.textContent).toContain('Already 4K60 or better')
      }
    }
  })

  it('does not query or download a pack for unsupported spatial geometry', async () => {
    const getAiPackStatus = vi.fn(() => Promise.resolve({ available: true, message: 'ready' }))
    const onStart = vi.fn()
    const app = renderDialog(getAiPackStatus, onStart, vi.fn(), {
      canvas: { width: 1440, height: 1080, fps: 30, fit: 'contain' }
    })
    await settle()
    expect(getAiPackStatus).not.toHaveBeenCalled()
    expect(app.textContent).toContain(flashSpatialSupportMessage)
    act(() => { app.querySelector<HTMLButtonElement>('[data-ai-export-start]')?.click() })
    expect(onStart).toHaveBeenCalledWith(undefined)
  })

  it('uses the Turbo selection for interpolation only and starts without a spatial mode', async () => {
    const onStart = vi.fn()
    const getAiPackStatus = vi.fn(() => Promise.resolve({ available: true, message: 'ready' }))
    const app = renderDialog(getAiPackStatus, onStart, vi.fn(), {
      canvas: { width: 3840, height: 2160, fps: 30, fit: 'contain' }
    })
    await settle()
    expect(getAiPackStatus).toHaveBeenCalledWith(false)
    const selector = app.querySelector('[data-ai-enhance-select]')
    if (!(selector instanceof HTMLSelectElement)) throw new Error('AI enhancement selector missing')
    expect(Array.from(selector.options).map((option) => option.textContent)).toEqual(['Off', '60 fps'])
    selectMode(app, 'turbo')
    act(() => { app.querySelector<HTMLButtonElement>('[data-ai-export-start]')?.click() })
    expect(onStart).toHaveBeenCalledWith({})
  })

  it('requests spatial readiness for below4K input', async () => {
    const getAiPackStatus = vi.fn(() => Promise.resolve({ available: true, message: 'ready' }))
    renderDialog(getAiPackStatus)
    await settle()
    expect(getAiPackStatus).toHaveBeenCalledWith(true, 'turbo')
  })

  it('enables enhancement when a missing pack can be downloaded', async () => {
    const app = renderDialog(() => Promise.resolve({
      available: false,
      message: 'Download the optional AI pack.',
      downloadable: true,
      downloadBytes: 100
    }))
    await settle()

    const selector = app.querySelector('[data-ai-enhance-select]')
    if (!(selector instanceof HTMLSelectElement)) throw new Error('AI enhancement selector missing')
    expect(selector.disabled).toBe(false)
  })

  it('renders download and verification progress, then starts enhancement after rechecking the pack', async () => {
    const download = deferred<undefined>()
    const reportProgress = vi.fn<(progress: AiModelDownloadProgress) => void>()
    const getAiPackStatus = vi.fn()
      .mockResolvedValueOnce({
        available: false,
        message: 'Download the optional AI pack.',
        downloadable: true,
        downloadBytes: 100
      })
      .mockResolvedValueOnce({ available: true, message: 'ready' })
    const onStart = vi.fn()
    const app = renderDialog(getAiPackStatus, onStart, vi.fn(), {
      startModelDownload: vi.fn(() => download.promise),
      subscribeModelDownload: (callback) => {
        reportProgress.mockImplementation(callback)
        return vi.fn()
      }
    })
    await settle()

    const selector = app.querySelector('[data-ai-enhance-select]')
    const start = app.querySelector('[data-ai-export-start]')
    if (!(selector instanceof HTMLSelectElement) || !(start instanceof HTMLButtonElement)) throw new Error('AI export controls missing')
    selectMode(app, 'turbo')
    act(() => { start.click() })

    expect(start.disabled).toBe(true)
    expect(app.querySelectorAll('[data-ai-download-progress]')).toHaveLength(1)
    act(() => {
      reportProgress({
        phase: 'downloading', name: 'sr.bin', downloadedBytes: 25, totalBytes: 100,
        percent: 25, bytesPerSecond: 10, etaSeconds: 8
      })
    })
    expect(app.querySelector('[data-ai-download-progress]')?.getAttribute('value')).toBe('25')
    expect(app.textContent).toContain('Downloading sr.bin')
    expect(app.textContent).toContain('25 B / 100 B')
    expect(app.textContent).toContain('10 B/s')
    expect(app.textContent).toContain('8s remaining')

    act(() => {
      reportProgress({ phase: 'preparing', name: 'block0.bin', downloadedBytes: 50, totalBytes: 100,
        percent: 50, bytesPerSecond: null, etaSeconds: null })
    })
    expect(app.textContent).toContain('Preparing AI enhancement model')
    expect(app.querySelector('[data-ai-download-progress]')?.getAttribute('value')).toBe('50')
    expect(start.disabled).toBe(true)

    act(() => {
      reportProgress({
        phase: 'verifying', name: 'sr.bin', downloadedBytes: 100, totalBytes: 100,
        percent: 100, bytesPerSecond: null, etaSeconds: 0
      })
    })
    expect(app.textContent).toContain('Verifying AI enhancement model')
    expect(app.textContent).toContain('Less than a second remaining')

    await act(async () => { download.resolve(undefined); await download.promise; await Promise.resolve() })
    expect(getAiPackStatus).toHaveBeenCalledTimes(2)
    expect(getAiPackStatus).toHaveBeenNthCalledWith(1, true, 'turbo')
    expect(getAiPackStatus).toHaveBeenNthCalledWith(2, true, 'turbo')
    expect(onStart).toHaveBeenCalledWith({ mode: 'turbo' })
  })

  it('waits for a download promise to settle before completing cancellation', async () => {
    const download = deferred<undefined>()
    const cancelModelDownload = vi.fn()
    const onCancel = vi.fn()
    const app = renderDialog(() => Promise.resolve({
      available: false, message: 'Download the optional AI pack.', downloadable: true, downloadBytes: 100
    }), vi.fn(), onCancel, {
      startModelDownload: () => download.promise,
      cancelModelDownload
    })
    await settle()
    const selector = app.querySelector('[data-ai-enhance-select]')
    const cancel = app.querySelector('[data-ai-export-cancel]')
    if (!(selector instanceof HTMLSelectElement) || !(cancel instanceof HTMLButtonElement)) throw new Error('AI export controls missing')
    selectMode(app, 'turbo')
    act(() => { app.querySelector<HTMLButtonElement>('[data-ai-export-start]')?.click() })
    act(() => { cancel.click() })

    expect(cancelModelDownload).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
    expect(app.querySelector('[data-ai-export-dialog]')).toBeTruthy()

    await act(async () => { download.resolve(undefined); await download.promise; await Promise.resolve() })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('keeps a download error in the dialog and allows retry', async () => {
    const startModelDownload = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(undefined)
    const getAiPackStatus = vi.fn()
      .mockResolvedValueOnce({ available: false, message: 'Download the optional AI pack.', downloadable: true, downloadBytes: 100 })
      .mockResolvedValueOnce({ available: true, message: 'ready' })
    const onStart = vi.fn()
    const app = renderDialog(getAiPackStatus, onStart, vi.fn(), { startModelDownload })
    await settle()
    const selector = app.querySelector('[data-ai-enhance-select]')
    const start = app.querySelector('[data-ai-export-start]')
    if (!(selector instanceof HTMLSelectElement) || !(start instanceof HTMLButtonElement)) throw new Error('AI export controls missing')
    selectMode(app, 'turbo')
    act(() => { start.click() })
    await settle()
    expect(app.textContent).toContain('network unavailable')
    expect(start.disabled).toBe(false)
    expect(selector.disabled).toBe(false)

    act(() => { start.click() })
    await settle()
    expect(startModelDownload).toHaveBeenCalledTimes(2)
    expect(onStart).toHaveBeenCalledWith({ mode: 'turbo' })
  })

  it('retires an old download when the dialog closes, even if it finishes after reopening', async () => {
    const download = deferred<undefined>()
    const unsubscribe = vi.fn()
    const cancelDownload = vi.fn()
    const onStart = vi.fn()
    const onCancel = vi.fn()
    const getAiPackStatus = vi.fn(() => Promise.resolve({
      available: false, message: 'Download the optional AI pack.', downloadable: true, downloadBytes: 100
    }))
    let reportProgress: ((progress: AiModelDownloadProgress) => void) | undefined
    const downloadOptions = {
      startModelDownload: () => download.promise,
      cancelModelDownload: cancelDownload,
      subscribeModelDownload: (callback: (progress: AiModelDownloadProgress) => void) => {
        reportProgress = callback
        return unsubscribe
      }
    }
    const app = renderDialog(getAiPackStatus, onStart, onCancel, downloadOptions)
    await settle()
    selectMode(app, 'turbo')
    act(() => { app.querySelector<HTMLButtonElement>('[data-ai-export-start]')?.click() })
    const render = (open: boolean): void => {
      root?.render(<AiExportDialog open={open}
        canvas={{ width: 3840, height: 2160, fps: 60, fit: 'contain' }}
        getAiPackStatus={getAiPackStatus} onStart={onStart} onCancel={onCancel} {...downloadOptions} />)
    }
    act(() => { render(false) })
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(cancelDownload).toHaveBeenCalledOnce()
    act(() => { render(true) })
    await act(async () => {
      reportProgress?.({ phase: 'downloading', name: 'stale model', downloadedBytes: 99,
        totalBytes: 100, percent: 99, bytesPerSecond: 1, etaSeconds: 1 })
      download.resolve(undefined)
      await download.promise
    })
    expect(onStart).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(getAiPackStatus).toHaveBeenCalledOnce()
    expect(app.querySelector('[data-ai-download-progress]')).toBeNull()
    expect(app.textContent).toContain('Already 4K60 or better.')
  })

  it('resets the enhancement selector for each dialog opening', async () => {
    const getAiPackStatus = vi.fn(() => Promise.resolve({ available: true, message: 'ready' }))
    const onStart = vi.fn()
    const app = renderDialog(getAiPackStatus, onStart)
    await act(async () => { await Promise.resolve() })
    const selector = app.querySelector('[data-ai-enhance-select]')
    if (!(selector instanceof HTMLSelectElement)) throw new Error('AI enhancement selector missing')
    selectMode(app, 'turbo')
    expect(selector.value).toBe('turbo')

    const props = { canvas: { width: 1920, height: 1080, fps: 30, fit: 'contain' as const },
      getAiPackStatus, onCancel: vi.fn(), onStart }
    act(() => {
      root?.render(<AiExportDialog {...props} open={false} />)
    })
    act(() => {
      root?.render(<AiExportDialog {...props} open />)
    })
    await settle()
    const reopenedSelector = app.querySelector('[data-ai-enhance-select]')
    if (!(reopenedSelector instanceof HTMLSelectElement)) throw new Error('AI enhancement selector missing after reopen')
    expect(reopenedSelector.value).toBe('off')
  })
})
