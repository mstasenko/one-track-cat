import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioOverlay } from '@shared/types'
import type { NarrationReview } from '@shared/narration-api'
import { NarrationPanel } from './NarrationPanel'
import { useEditorStore } from '../model/store'
import { createSession } from '../model/timeline'

vi.mock('../model/export-request', () => ({ prepareExportRequest: (session: unknown) => Promise.resolve(session) }))
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const draft: NarrationReview = { id, stage: 'cleaned', approved: false, contentKey: 'audio', range: [0, 10], language: 'en', strength: 'balanced',
  recognition: { speechDetection: 'balanced' }, originalPath: '/original.wav', speechPath: '/speech.wav', backgroundPath: '/bed.wav',
  phrases: [{ id: 'phrase-0', start: 1, end: 5, text: 'Um, wait here.', revisedText: 'Wait here.', needsTimingReview: false }] }
const generated: AudioOverlay = { id: 'generated', name: 'AI Narration', type: 'audio', path: '/AI.wav', sourceIn: 0,
  start: 0, duration: 10, volume: 1, zIndex: 0, narration: { draftId: id, enabled: true } }
const api = { status: vi.fn(), analyze: vi.fn(), load: vi.fn(), generate: vi.fn(), cancel: vi.fn(), progress: vi.fn() }
let root: Root
let container: HTMLDivElement

function Wrapper() {
  const session = useEditorStore((state) => state.session)
  if (!session) return null
  const overlay = session.overlays.find((item) => item.id === session.selectedOverlayId)
  return <NarrationPanel session={session} overlay={overlay?.type === 'audio' ? overlay : undefined} onBack={vi.fn()} />
}

async function mount(): Promise<void> { await act(async () => { root.render(<Wrapper />); await Promise.resolve() }) }
async function recognize(): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === 'Recognize')
  if (!button) throw new Error('Missing Recognize')
  await act(async () => { button.click(); await Promise.resolve() })
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  api.status.mockResolvedValue({ available: true, message: 'Ready' })
  api.analyze.mockResolvedValue(draft)
  api.load.mockResolvedValue(draft)
  api.generate.mockResolvedValue({ ...generated, narration: { ...generated.narration, draftId: id, enabled: true } })
  api.cancel.mockResolvedValue(undefined)
  api.progress.mockReturnValue(() => undefined)
  Object.defineProperty(window, 'otc', { configurable: true, value: { narration: api } })
  useEditorStore.setState({ session: createSession({ path: '/video.mp4', name: 'video', size: 1, modifiedAt: 1,
    duration: 10, width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true }), history: [], future: [], gesture: null, error: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => { act(() => { root.unmount() }); container.remove() })

describe('Re-voice recognition settings', () => {
  it('passes the selected speech detection mode to recognize', async () => {
    await mount()
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Recognition audio"]')?.value).toBe('original')
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('[aria-label="Speech detection"]')
      if (select) { select.value = 'sensitive'; select.dispatchEvent(new Event('change', { bubbles: true })) }
      await Promise.resolve()
    })
    await recognize()
    expect(api.analyze).toHaveBeenCalledWith(expect.anything(), [0, 10], 'auto', false,
      { speechDetection: 'sensitive', audio: 'original' })
  })

  it('passes cleaned speech when selected', async () => {
    await mount()
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('[aria-label="Recognition audio"]')
      if (select) { select.value = 'speech'; select.dispatchEvent(new Event('change', { bubbles: true })) }
      await Promise.resolve()
    })
    await recognize()
    expect(api.analyze).toHaveBeenCalledWith(expect.anything(), [0, 10], 'auto', false,
      { speechDetection: 'balanced', audio: 'speech' })
  })

  it('restores saved speech detection and recognition audio before recognizing again', async () => {
    api.load.mockResolvedValue({ ...draft, recognition: { speechDetection: 'strict' as const, audio: 'speech' as const } })
    useEditorStore.setState((state) => ({ session: state.session && { ...state.session, selectedOverlayId: generated.id, overlays: [generated] } }))
    await mount()
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Speech detection"]')?.value).toBe('strict')
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Recognition audio"]')?.value).toBe('speech')
    await recognize()
    expect(api.analyze).toHaveBeenCalledWith(expect.anything(), [0, 10], 'auto', false,
      { speechDetection: 'strict', audio: 'speech' })
  })
})
