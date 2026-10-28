import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AudioOverlay } from '@shared/types'
import type { NarrationReview } from '@shared/narration-api'
import { NarrationPanel } from './NarrationPanel'
import { useEditorStore } from '../model/store'
import { createSession } from '../model/timeline'

vi.mock('../model/export-request', () => ({ prepareExportRequest: (session: unknown) => Promise.resolve(session) }))
const draft: NarrationReview = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', stage: 'cleaned', approved: false,
  contentKey: 'audio', range: [0, 10], language: 'en', strength: 'balanced', originalPath: '/original.wav',
  speechPath: '/speech.wav', backgroundPath: '/background.wav', phrases: [{ id: 'phrase-0', start: 1, end: 5,
    text: 'Wait here.', revisedText: 'Wait here.', needsTimingReview: true }] }
const generated: AudioOverlay = { id: 'generated', name: 'AI Narration', type: 'audio', path: '/AI.wav', sourceIn: 0,
  start: 0, duration: 10, volume: 1, zIndex: 0, narration: { draftId: draft.id, enabled: false } }
const warning = 'Speech timing could not be corrected. Select a shorter section, then click Recognize.'
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
async function settle(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text)
  if (!button) throw new Error(`Missing ${text}`)
  await act(async () => { button.click(); await Promise.resolve() })
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  api.status.mockResolvedValue({ available: true, message: 'Ready' })
  api.analyze.mockResolvedValue(draft)
  api.load.mockResolvedValue(draft)
  api.progress.mockReturnValue(() => undefined)
  Object.defineProperty(window, 'otc', { configurable: true, value: { narration: api, waveform: vi.fn().mockResolvedValue([]) } })
  useEditorStore.setState({ session: createSession({ path: '/video.mp4', name: 'video', size: 1, modifiedAt: 1,
    duration: 10, width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true }), history: [], future: [], gesture: null, error: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => { root.unmount() }); container.remove() })

describe('timing review notification', () => {
  it.each(['load', 'analyze'] as const)('uses the shared warning after a flagged %s', async (source) => {
    if (source === 'load') {
      api.load.mockResolvedValue(draft)
      useEditorStore.setState((state) => ({ session: state.session && { ...state.session, overlays: [generated], selectedOverlayId: generated.id } }))
    }
    await mount()
    if (source === 'analyze') await click('Recognize')
    await settle()
    expect(useEditorStore.getState().error).toBe(warning)
    expect(container.textContent).not.toContain('Speech timing needs review. Open Edit transcript.')
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Generate')?.disabled).toBe(true)
    useEditorStore.setState({ error: null })
    await act(async () => { root.render(<Wrapper />); await Promise.resolve() })
    expect(useEditorStore.getState().error).toBeNull()
  })
})
