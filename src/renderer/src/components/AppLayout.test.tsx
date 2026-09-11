import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FaceBlurEffect, JobProgress, MediaMetadata } from '@shared/types'
import type { EditorState } from '../model/editor-state'
import { createSession } from '../model/timeline'
import { EditorWorkspace, Welcome } from './AppLayout'
import { ExportProgress } from './ExportProgress'

vi.mock('./AssetPanel', () => ({ AssetPanel: () => <div data-testid="asset-panel" /> }))
vi.mock('./Preview', () => ({
  Preview: ({ onPlayhead }: { onPlayhead: (time: number) => void }) => (
    <button data-testid="preview-playhead" onClick={() => onPlayhead(3)}>Preview playhead</button>
  )
}))
vi.mock('./Timeline', () => ({
  Timeline: ({ onSeek }: { onSeek: (time: number) => void }) => (
    <button data-testid="timeline-seek" onClick={() => onSeek(4)}>Timeline seek</button>
  )
}))

type ExportProgressProps = Parameters<typeof ExportProgress>[0]

const runningJob: JobProgress = {
  id: 'export-1', kind: 'export', state: 'running', progress: 0.42, message: 'Encoding video…'
}

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

const selectedFaceBlur: FaceBlurEffect = {
  id: 'face-1', start: 1, duration: 3, sensitivity: 0.7, detail: 'standard',
  holdSeconds: 0.3, strength: 0.7, style: 'blur'
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function renderProgress(overrides: Partial<ExportProgressProps> = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<ExportProgress exporting job={null} {...overrides} />)
  })
  return container
}

type WorkspaceProps = Parameters<typeof EditorWorkspace>[0]

function workspaceProps(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  const session = createSession(metadata)
  const store = {
    session,
    assets: [],
    history: [],
    future: [],
    setPlayhead: vi.fn(),
    selectOverlay: vi.fn()
  } as unknown as EditorState
  return {
    store,
    session,
    selected: null,
    selectedFaceBlur,
    selectedFaceBlurId: selectedFaceBlur.id,
    duration: metadata.duration,
    playing: true,
    zoom: 1,
    exporting: false,
    resetting: false,
    renderedPreview: null,
    onPlayingChange: vi.fn(),
    onZoom: vi.fn(),
    onExport: vi.fn(),
    onStep: vi.fn(),
    onApplyFaceBlur: vi.fn(),
    onSelectFaceBlur: vi.fn(),
    facePreviewing: false,
    ...overrides
  }
}

function renderWorkspace(overrides: Partial<WorkspaceProps> = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<EditorWorkspace {...workspaceProps(overrides)} />) })
  return container
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'otc', {
    configurable: true,
    value: { cancelJob: vi.fn().mockResolvedValue(true) }
  })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('export progress scanner', () => {
  it.each([
    ['queued', 'Queued'], ['starting', 'Starting'], ['preparing', 'Preparing'],
    ['masking', 'Masking faces'], ['encoding', 'Encoding video'],
    ['finalizing', 'Finalizing export'], ['complete', 'Complete']
  ] as const)('describes the %s stage', (phase, expected) => {
    const app = renderProgress({ job: { ...runningJob, phase, message: '' } })
    expect(app.querySelector('[data-testid="export-phase"]')?.textContent).toBe(`Phase: ${expected}`)
  })

  it.each([
    [undefined, 'Estimating time remaining…'], [Number.NaN, 'Estimating time remaining…'],
    [-1, 'Estimating time remaining…'], [0.4, 'Less than a second remaining'],
    [60, '1m remaining'], [61, '1m 1s remaining']
  ])('formats an observed stage estimate of %s seconds', (etaSeconds, expected) => {
    const app = renderProgress({ job: { ...runningJob, etaSeconds } })
    expect(app.querySelector('[data-testid="export-eta"]')?.textContent).toBe(`Stage ETA: ${expected}`)
  })

  it('shows one encoder status and removes separate hardware badges', () => {
    const app = renderProgress({ job: {
      ...runningJob, phase: 'masking', message: 'Applying cached face analysis'
    } })
    expect(app.querySelector('[data-testid="export-phase"]')?.textContent).toBe('Phase: Applying cached face analysis')
    act(() => root?.render(<ExportProgress exporting job={{
      ...runningJob, phase: 'encoding', message: 'Encoding video using dGPU', hardwareLabel: 'CPU', encodingHardwareLabel: 'dGPU'
    }} />))
    expect(app.querySelector('p')?.textContent).toBe('Encoding video using dGPU')
    expect(app.querySelector('[data-testid="export-phase"]')?.textContent).toBe('Phase: Encoding video')
    expect(app.querySelector('[data-testid="export-hardware"]')).toBeNull()
    expect(app.querySelector('[data-testid="export-encoding-hardware"]')).toBeNull()
  })

  it('derives ordinary encoding hardware without borrowing face detection hardware', () => {
    const app = renderProgress({ job: {
      ...runningJob, phase: 'encoding', message: '50%', hardwareLabel: 'dGPU'
    } })
    expect(app.querySelector('p')?.textContent).toBe('Encoding video using dGPU: 50%')
    act(() => root?.render(<ExportProgress exporting job={{
      ...runningJob, phase: 'encoding', message: 'Detecting faces using CPU', hardwareLabel: 'CPU'
    }} />))
    expect(app.querySelector('p')?.textContent).toBe('Detecting faces using CPU')
    act(() => root?.render(<ExportProgress exporting job={{
      ...runningJob, phase: 'encoding', message: 'Encoding video: 50%', hardwareLabel: 'CPU'
    }} />))
    expect(app.querySelector('p')?.textContent).toBe('Encoding video: 50%')
    act(() => root?.render(<ExportProgress exporting job={{
      ...runningJob, phase: 'encoding', message: 'GPU authorization or encoding unavailable; using CPU', hardwareLabel: 'CPU'
    }} />))
    expect(app.querySelector('p')?.textContent).toBe('GPU authorization or encoding unavailable; using CPU')
  })

  it('keeps the native determinate progress and default title while showing the scanner', () => {
    const app = renderProgress({ job: runningJob })
    const progress = app.querySelector('progress')

    expect(app.querySelector('h2')?.textContent).toBe('Exporting video')
    expect(progress?.getAttribute('aria-label')).toBe('Export progress')
    expect(progress?.getAttribute('value')).toBe('0.42')
    expect(progress?.getAttribute('max')).toBe('1')
    expect(app.querySelector('.export-scanner')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('labels the ETA as the current stage and prioritizes cached analysis', () => {
    const app = renderProgress({ job: {
      ...runningJob,
      phase: 'masking',
      message: 'Applying cached face analysis',
      etaSeconds: 12
    } })

    expect(app.querySelector('[data-testid="export-phase"]')?.textContent).toBe('Phase: Applying cached face analysis')
    expect(app.querySelector('[data-testid="export-eta"]')?.textContent).toBe('Stage ETA: 12s remaining')
  })

  it('keeps preparing progress indeterminate for the face-preview title', () => {
    const app = renderProgress({ title: 'Applying face blur' })
    const progress = app.querySelector('progress')
    const cancel = app.querySelector('button')

    expect(app.querySelector('h2')?.textContent).toBe('Applying face blur')
    expect(progress?.getAttribute('aria-label')).toBe('Preparing export')
    expect(progress?.hasAttribute('value')).toBe(false)
    expect(cancel?.hasAttribute('disabled')).toBe(true)
    expect(app.querySelector('.export-scanner')).not.toBeNull()
  })

  it('preserves active-job cancellation and custom face-preview cancellation', () => {
    const defaultApp = renderProgress({ job: runningJob })
    const defaultCancel = defaultApp.querySelector('button')
    if (!(defaultCancel instanceof HTMLButtonElement)) throw new Error('default cancel button missing')
    act(() => { defaultCancel.click() })
    expect(window.otc.cancelJob).toHaveBeenCalledWith(runningJob.id)

    const onCancel = vi.fn()
    act(() => {
      root?.render(<ExportProgress exporting job={runningJob} title="Applying face blur" onCancel={onCancel} />)
    })
    const faceCancel = container?.querySelector('button')
    if (!(faceCancel instanceof HTMLButtonElement)) throw new Error('face-preview cancel button missing')
    act(() => { faceCancel.click() })
    expect(onCancel).toHaveBeenCalledOnce()
    expect(window.otc.cancelJob).toHaveBeenCalledOnce()
  })

  it('renders no modal or scanner when exporting is false', () => {
    const app = renderProgress({ exporting: false, job: runningJob })

    expect(app.querySelector('.export-dialog')).toBeNull()
    expect(app.querySelector('.export-scanner')).toBeNull()
  })
})

describe('editor workspace playback callbacks', () => {
  it('updates the playhead from preview playback without pausing or clearing face selection', () => {
    const onPlayingChange = vi.fn()
    const onSelectFaceBlur = vi.fn()
    const setPlayhead = vi.fn()
    const app = renderWorkspace({
      onPlayingChange,
      onSelectFaceBlur,
      store: { ...workspaceProps().store, setPlayhead } as EditorState
    })

    const preview = app.querySelector('[data-testid="preview-playhead"]')
    if (!(preview instanceof HTMLButtonElement)) throw new Error('preview callback missing')
    act(() => { preview.click() })

    expect(setPlayhead).toHaveBeenCalledWith(3)
    expect(onPlayingChange).not.toHaveBeenCalled()
    expect(onSelectFaceBlur).not.toHaveBeenCalled()
  })

  it('pauses and clears face selection for an intentional timeline seek', () => {
    const onPlayingChange = vi.fn()
    const onSelectFaceBlur = vi.fn()
    const setPlayhead = vi.fn()
    const app = renderWorkspace({
      onPlayingChange,
      onSelectFaceBlur,
      store: { ...workspaceProps().store, setPlayhead } as EditorState
    })

    const timeline = app.querySelector('[data-testid="timeline-seek"]')
    if (!(timeline instanceof HTMLButtonElement)) throw new Error('timeline callback missing')
    act(() => { timeline.click() })

    expect(setPlayhead).toHaveBeenCalledWith(4)
    expect(onPlayingChange).toHaveBeenCalledWith(false)
    expect(onSelectFaceBlur).toHaveBeenCalledWith(null)
  })
})

describe('welcome actions', () => {
  it('opens and drops videos into either regular or Short projects', () => {
    const onOpen = vi.fn()
    const onOpenShort = vi.fn()
    const onDrop = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => { root?.render(<Welcome onOpen={onOpen} onOpenShort={onOpenShort} onDrop={onDrop} />) })

    const openButton = container.querySelector('[aria-label="Open"]')
    const shortButton = container.querySelector('[aria-label="Open Short"]')
    if (!(openButton instanceof HTMLButtonElement) || !(shortButton instanceof HTMLButtonElement)) throw new Error('welcome actions missing')

    act(() => { shortButton.click() })
    expect(onOpenShort).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()

    act(() => { openButton.click() })
    expect(onOpen).toHaveBeenCalledOnce()

    const regularDrop = new Event('drop', { bubbles: true, cancelable: true })
    act(() => { openButton.dispatchEvent(regularDrop) })
    expect(regularDrop.defaultPrevented).toBe(true)
    expect(onDrop).toHaveBeenLastCalledWith(expect.anything(), false)

    const shortDrop = new Event('drop', { bubbles: true, cancelable: true })
    act(() => { shortButton.dispatchEvent(shortDrop) })
    expect(shortDrop.defaultPrevented).toBe(true)
    expect(onDrop).toHaveBeenLastCalledWith(expect.anything(), true)
  })
})
