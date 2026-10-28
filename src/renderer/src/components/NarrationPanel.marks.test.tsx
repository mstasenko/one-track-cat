import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioOverlay, EditSession, MediaMetadata } from '@shared/types'
import type { NarrationReview } from '@shared/narration-api'
import { NarrationPanel } from './NarrationPanel'
import { useEditorStore } from '../model/store'
import { createSession } from '../model/timeline'

vi.mock('../model/export-request', () => ({ prepareExportRequest: (session: unknown) => Promise.resolve(session) }))

const draftId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const metadata: MediaMetadata = {
  path: '/video.mp4', name: 'video', size: 1, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}
const draft: NarrationReview = {
  id: draftId, stage: 'cleaned', approved: true, contentKey: 'audio', range: [0, 10], language: 'en', strength: 'balanced',
  voiceStyle: 'conversational', levelVoice: false, backgroundVolume: 0.25, slowdown: 0.15, subtitles: false,
  originalPath: '/original.wav', speechPath: '/speech.wav', backgroundPath: '/background.wav',
  phrases: [
    { id: 'p0', start: 0, end: 3, text: 'Original zero.', revisedText: 'Revised zero.', needsTimingReview: false },
    { id: 'p1', start: 4, end: 6, text: 'Original crossing.', revisedText: 'Revised crossing.', needsTimingReview: false },
    { id: 'p2', start: 7, end: 9, text: 'Original two.', revisedText: 'Revised two.', needsTimingReview: false }
  ]
}
const voice: AudioOverlay = {
  id: 'voice', type: 'audio', path: '/cached.wav', name: 'Re-voice', start: 0, duration: 10, sourceIn: 0,
  zIndex: 0, volume: 1, narration: {
    draftId, enabled: true, voiceStyle: 'conversational', levelVoice: false,
    backgroundVolume: 0.25, slowdown: 0.15, subtitles: false
  }
}

const api = {
  status: vi.fn(), analyze: vi.fn(), load: vi.fn(), generate: vi.fn(), cancel: vi.fn(), progress: vi.fn()
}
let root: Root
let container: HTMLDivElement
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')

function Wrapper(): React.JSX.Element | null {
  const session = useEditorStore((state) => state.session)
  if (!session) return null
  const selected = session.overlays.find((overlay) => overlay.id === session.selectedOverlayId)
  return <NarrationPanel session={session} overlay={selected?.type === 'audio' ? selected : undefined} onBack={vi.fn()} />
}

function session(marks: number[] = [], playhead = 2): EditSession {
  const current = createSession(metadata)
  return { ...current, overlays: [structuredClone(voice)], marks, playhead, selectedOverlayId: null }
}

function installSession(marks: number[] = [], playhead = 2): void {
  useEditorStore.setState({ session: session(marks, playhead), history: [], future: [], gesture: null, error: null })
}

function audioGeometry(value = useEditorStore.getState().session): unknown[] {
  return (value?.overlays ?? []).filter((overlay): overlay is AudioOverlay => overlay.type === 'audio')
    .map(({ id, path, start, duration, sourceIn }) => ({ id, path, start, duration, sourceIn }))
}

function fields(): HTMLTextAreaElement[] {
  return [...container.querySelectorAll<HTMLTextAreaElement>('textarea')]
}

function phraseTimes(): string[] {
  return [...container.querySelectorAll<HTMLLabelElement>('.transcript-phrase')]
    .map((label) => label.querySelector('span')?.textContent ?? '')
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(): Promise<void> {
  await act(async () => { root.render(<Wrapper />); await Promise.resolve() })
  await settle()
}

async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text)
  if (!button) throw new Error(`Missing ${text}`)
  expect(button.disabled).toBe(false)
  await act(async () => {
    button.click()
    await Promise.resolve()
    await Promise.resolve()
  })
  await settle()
}

async function editField(index: number, value: string): Promise<void> {
  await click('Edit transcript')
  const field = fields()[index]
  if (!field) throw new Error(`Missing transcript field ${index}`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
  await click('Apply')
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, value(this: HTMLDialogElement) { this.open = true }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true, value(this: HTMLDialogElement) { this.open = false }
  })
  api.status.mockResolvedValue({ available: true, message: 'Ready' })
  api.load.mockImplementation(() => Promise.resolve(structuredClone(draft)))
  api.generate.mockResolvedValue(structuredClone(voice))
  api.cancel.mockResolvedValue(undefined)
  api.progress.mockReturnValue(() => undefined)
  Object.defineProperty(window, 'otc', { configurable: true, value: { narration: api, waveform: vi.fn().mockResolvedValue([]) } })
  installSession()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close
})

describe('marked Re-voice transcript views', () => {
  it('shows whole phrases by start time, including a phrase crossing the mark', async () => {
    installSession([5], 2)
    await mount()

    await click('Edit transcript')
    expect(fields().map((field) => field.value)).toEqual(['Revised zero.', 'Revised crossing.'])
    expect(phraseTimes()).toEqual(['00:00.00 – 00:03.00', '00:04.00 – 00:06.00'])
    await click('Apply')

    await act(async () => { useEditorStore.getState().setPlayhead(7); await Promise.resolve() })
    await click('Edit transcript')
    expect(fields().map((field) => field.value)).toEqual(['Revised two.'])
    expect(phraseTimes()).toEqual(['00:07.00 – 00:09.00'])
    expect(container.textContent).not.toContain('Revised crossing.')
    expect(api.analyze).not.toHaveBeenCalled()
  })

  it('merges left and right edits into one full-owner Generate payload without changing cached audio', async () => {
    installSession([5], 2)
    await mount()
    const initialAudio = audioGeometry()

    await editField(1, 'Edited crossing.')
    let owner = useEditorStore.getState().session?.overlays[0]
    if (owner?.type !== 'audio') throw new Error('Missing narration owner')
    expect(owner.narration?.revisions).toEqual(['Revised zero.', 'Edited crossing.', 'Revised two.'])
    expect(audioGeometry()).toEqual(initialAudio)

    await act(async () => { useEditorStore.getState().setPlayhead(7); await Promise.resolve() })
    await editField(0, 'Edited right.')
    owner = useEditorStore.getState().session?.overlays[0]
    if (owner?.type !== 'audio') throw new Error('Missing narration owner')
    expect(owner.narration?.revisions).toEqual(['Revised zero.', 'Edited crossing.', 'Edited right.'])
    expect(audioGeometry()).toEqual(initialAudio)

    await click('Generate')
    const call = api.generate.mock.calls.at(-1)
    expect(call?.[1]).toBe(draftId)
    expect(JSON.parse(call?.[2] as string)).toEqual({ segments: [
      { id: 'p0', text: 'Revised zero.', originalText: 'Original zero.' },
      { id: 'p1', text: 'Edited crossing.', originalText: 'Original crossing.' },
      { id: 'p2', text: 'Edited right.', originalText: 'Original two.' }
    ] })
    expect(call?.[3]).toBe('conversational')
    expect(call?.[4]).toEqual({ levelVoice: false, backgroundVolume: 0.25, slowdown: 0.15, subtitles: false })
    expect(api.analyze).not.toHaveBeenCalled()
    expect(audioGeometry()).toEqual(initialAudio)
  })

  it('keeps repeated marks and Undo/Redo view-only while preserving the cached owner', async () => {
    await mount()
    const initialAudio = audioGeometry()
    const loads = api.load.mock.calls.length

    await act(async () => {
      useEditorStore.getState().setPlayhead(5)
      useEditorStore.getState().addMark()
      useEditorStore.getState().addMark()
      await Promise.resolve()
    })
    expect(useEditorStore.getState().session?.marks).toEqual([5])
    expect(useEditorStore.getState().history).toHaveLength(1)
    expect(api.load).toHaveBeenCalledTimes(loads)
    expect(api.analyze).not.toHaveBeenCalled()
    expect(audioGeometry()).toEqual(initialAudio)

    await act(async () => { useEditorStore.getState().setPlayhead(2); await Promise.resolve() })
    await click('Edit transcript')
    expect(fields()).toHaveLength(2)
    await click('Apply')

    await act(async () => { useEditorStore.getState().undo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.marks).toEqual([])
    expect(audioGeometry()).toEqual(initialAudio)
    await click('Edit transcript')
    expect(fields()).toHaveLength(3)
    await click('Apply')

    await act(async () => { useEditorStore.getState().redo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.marks).toEqual([5])
    await act(async () => { useEditorStore.getState().setPlayhead(7); await Promise.resolve() })
    await click('Edit transcript')
    expect(fields().map((field) => field.value)).toEqual(['Revised two.'])
    expect(audioGeometry()).toEqual(initialAudio)
    expect(api.analyze).not.toHaveBeenCalled()
  })

  it('shows an empty marked right view when only a crossing phrase starts on the left', async () => {
    const phrase = draft.phrases[1] ?? draft.phrases[0]
    if (!phrase) throw new Error('Missing crossing phrase')
    const crossingOnly: NarrationReview = { ...draft, phrases: [{ ...phrase, id: 'p0', start: 0, end: 6 }] }
    api.load.mockResolvedValueOnce(crossingOnly)
    installSession([5], 7)
    const initialAudio = audioGeometry()
    await mount()

    await click('Edit transcript')
    expect(fields()).toHaveLength(0)
    expect(container.textContent).toContain('No speech starts in this section.')
    const generate = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Generate')
    expect(generate?.disabled).toBe(true)
    expect(audioGeometry()).toEqual(initialAudio)
    expect(api.analyze).not.toHaveBeenCalled()
  })

  it('opens the full review for an out-of-view overrun and retries with unchanged phrase IDs', async () => {
    const overrun: NarrationReview = { ...draft, overruns: [{ id: 'p2', text: 'Revised two.', extraSeconds: 0.4 }] }
    api.load.mockResolvedValueOnce(overrun)
    installSession([5], 2)
    await mount()

    expect(container.querySelector('dialog')?.open).toBe(true)
    expect(fields().map((field) => field.value)).toEqual(['Revised zero.', 'Revised crossing.', 'Revised two.'])
    expect(phraseTimes()).toEqual(['00:00.00 – 00:03.00', '00:04.00 – 00:06.00', '00:07.00 – 00:09.00'])
    expect(container.textContent).toContain('Phrase 3: 0.4 s too long')
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry generation')
    expect(retry?.disabled).toBe(true)

    const third = container.querySelector<HTMLTextAreaElement>('[aria-label="Revised phrase 3"]')
    if (!third) throw new Error('Missing out-of-view overrun phrase')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(third, 'Fixed right.')
      third.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(retry?.disabled).toBe(false)
    await click('Retry generation')

    const call = api.generate.mock.calls.at(-1)
    expect(call?.[1]).toBe(draftId)
    const reviewed = JSON.parse(call?.[2] as string) as { segments: { id: string; text: string }[] }
    expect(reviewed.segments.map((segment) => segment.id)).toEqual(['p0', 'p1', 'p2'])
    expect(reviewed.segments[2]).toMatchObject({ id: 'p2', text: 'Fixed right.' })
    expect(api.analyze).not.toHaveBeenCalled()
  })
})
