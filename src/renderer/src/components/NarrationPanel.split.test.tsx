import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioOverlay } from '@shared/types'
import type { NarrationReview } from '@shared/narration-api'
import { NarrationPanel } from './NarrationPanel'
import { useEditorStore } from '../model/store'
import { createSession, removeOutputRange } from '../model/timeline'

vi.mock('../model/export-request', () => ({ prepareExportRequest: (session: unknown) => Promise.resolve(session) }))
const draft: NarrationReview = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', stage: 'cleaned', approved: true,
  contentKey: 'audio', range: [0, 10], language: 'en', strength: 'balanced',
  originalPath: '/original.wav', speechPath: '/speech.wav', backgroundPath: '/background.wav',
  phrases: [0, 4, 7].map((start, index) => ({ id: `p${index}`, start, end: start + 2,
    text: `Original ${index}.`, revisedText: `Revised ${index}.`, needsTimingReview: false })) }
const voice: AudioOverlay = { id: 'voice', type: 'audio', path: '/voice.wav', name: 'Re-voice', start: 0,
  duration: 10, sourceIn: 0, zIndex: 0, volume: 1, narration: { draftId: draft.id, enabled: true } }
const api = { status: vi.fn(), load: vi.fn(), analyze: vi.fn(), generate: vi.fn(), cancel: vi.fn(), progress: vi.fn() }
let root: Root
let container: HTMLDivElement
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
function Wrapper() {
  const session = useEditorStore((state) => state.session)
  if (!session) return null
  const overlay = session.overlays.find((item) => item.id === session.selectedOverlayId)
  return <NarrationPanel session={session} overlay={overlay?.type === 'audio' ? overlay : undefined} onBack={vi.fn()} />
}
async function click(name: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === name)
  if (!button) throw new Error(`Missing ${name}`)
  expect(button.disabled).toBe(false)
  await act(async () => { button.click(); await Promise.resolve() })
}
async function edit(text: string): Promise<void> {
  await click('Edit transcript')
  const field = container.querySelector('textarea')
  if (!field) throw new Error('Missing transcript')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
  await click('Apply')
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false } })
  api.status.mockResolvedValue({ available: true, message: 'Ready' })
  api.load.mockResolvedValue(draft)
  api.progress.mockReturnValue(() => undefined)
  Object.defineProperty(window, 'otc', { configurable: true, value: { narration: api, waveform: vi.fn().mockResolvedValue([]) } })
  const session = createSession({ path: '/video.mp4', name: 'video', size: 1, modifiedAt: 1,
    duration: 10, width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true })
  const cut = removeOutputRange(session.segments, [voice], 3.5, 6.5)
  useEditorStore.setState({ session: { ...session, ...cut, selectedOverlayId: cut.overlays[0]?.id ?? null },
    history: [], future: [], gesture: null, error: null })
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

describe('Re-voice pieces', () => {
  it('recognizes a marked subrange inside existing narration and generates only that piece', async () => {
    const sourceId = useEditorStore.getState().session?.sources[0]?.id
    if (!sourceId) throw new Error('Missing source')
    useEditorStore.setState((state) => ({ session: state.session && { ...state.session,
      segments: [{ id: 'whole', sourceId, sourceStart: 0, sourceEnd: 10 }], overlays: [voice],
      marks: [3, 5], playhead: 4, selectedOverlayId: null } }))
    const phrase = draft.phrases[0]
    if (!phrase) throw new Error('Missing phrase')
    const recognized: NarrationReview = { ...draft, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      range: [3, 5], approved: false, phrases: [{ ...phrase, start: 0.2, end: 1.8 }] }
    api.analyze.mockResolvedValueOnce(recognized)
    api.load.mockResolvedValue(recognized)
    await act(async () => { root.render(<Wrapper />); await Promise.resolve() })
    await click('Recognize')
    expect(api.analyze).toHaveBeenCalledWith(expect.anything(), [3, 5], 'auto', false,
      { speechDetection: 'balanced', audio: 'original' })
    expect(useEditorStore.getState().error).toBeNull()
    const overlays = useEditorStore.getState().session?.overlays ?? []
    const selected = overlays.find((o) => o.type === 'audio' && o.narration?.draftId === recognized.id)
    if (selected?.type !== 'audio') throw new Error('Missing recognized section')
    const siblings = overlays.filter((o) => o.id !== selected.id)
    expect(siblings.map((o) => ({ start: o.start, duration: o.duration, sourceIn: o.type === 'audio' && o.sourceIn })))
      .toEqual([{ start: 0, duration: 3, sourceIn: 0 }, { start: 5, duration: 5, sourceIn: 5 }])
    await edit('New wording for this selection.')
    api.generate.mockResolvedValueOnce({ ...selected, path: '/new-selection.wav',
      narration: { draftId: recognized.id, enabled: true } })
    await click('Generate')
    expect(api.generate.mock.calls[0]?.[5]).toBe(selected.id)
    expect(JSON.parse(api.generate.mock.calls[0]?.[2] as string)).toMatchObject({
      segments: [{ id: 'p0', text: 'New wording for this selection.' }] })
    expect(useEditorStore.getState().session?.overlays.filter((o) => o.id !== selected.id)).toEqual(siblings)
    expect(useEditorStore.getState().error).toBeNull()
  })

  it.each([false, true])('preserves the whole recognized transcript after adding zoom marks (edited: %s)', async (edited) => {
    const sourceId = useEditorStore.getState().session?.sources[0]?.id
    if (!sourceId) throw new Error('Missing source')
    useEditorStore.setState((state) => ({ session: state.session && { ...state.session,
      segments: [{ id: 'whole', sourceId, sourceStart: 0, sourceEnd: 10 }],
      overlays: [voice], marks: [], playhead: 1, selectedOverlayId: null } }))
    await act(async () => { root.render(<Wrapper />); await Promise.resolve() })
    if (edited) await edit('Keep my revised wording.')
    const before = useEditorStore.getState().session?.overlays
    await act(async () => {
      useEditorStore.setState((state) => ({ session: state.session && { ...state.session, marks: [5],
        focusZooms: [{ id: 'zoom', start: 0, duration: 5, zoom: 3, focusX: 0.5, focusY: 0.5 }] } }))
      await Promise.resolve()
    })
    for (const name of ['Edit transcript', 'Generate']) {
      expect([...container.querySelectorAll('button')].find((button) => button.textContent === name)?.disabled).toBe(false)
    }
    expect(api.generate).not.toHaveBeenCalled()
    expect(useEditorStore.getState().session?.overlays).toEqual(before)
    await click('Edit transcript')
    expect([...container.querySelectorAll('textarea')].map((field) => field.value))
      .toEqual([edited ? 'Keep my revised wording.' : 'Revised 0.', 'Revised 1.'])
    await click('Apply')
    api.generate.mockResolvedValueOnce(voice)
    await click('Generate')
    const submitted = JSON.parse(api.generate.mock.calls[0]?.[2] as string) as { segments: { id: string }[] }
    expect(submitted.segments.map((phrase) => phrase.id)).toEqual(['p0', 'p1', 'p2'])
    expect(api.generate.mock.calls[0]?.[5]).toBe(voice.id)
  })

  it('edits and regenerates either cut piece without replacing its sibling', async () => {
    await act(async () => { root.render(<Wrapper />); await Promise.resolve() })
    const right = useEditorStore.getState().session?.overlays[1]
    if (!right) throw new Error('Missing right piece')
    await edit('Edited left.')
    expect(useEditorStore.getState().session?.overlays[1]).toEqual(right)
    api.generate.mockResolvedValueOnce({ ...voice, path: '/new-left.wav', duration: 3.5,
      narration: { draftId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', enabled: true } })
    api.load.mockResolvedValueOnce({ ...draft, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', range: [0, 3.5], phrases: [draft.phrases[0]] })
    await click('Generate')
    expect(api.generate.mock.calls[0]?.[2]).toContain('Edited left.')
    expect(api.generate.mock.calls[0]?.[5]).toBe(voice.id)
    const left = useEditorStore.getState().session?.overlays.find((item) => item.id === voice.id)
    await act(async () => { useEditorStore.getState().selectOverlay(right.id); await Promise.resolve() })
    await click('Edit transcript')
    expect([...container.querySelectorAll('textarea')].map((field) => field.value)).toEqual(['Revised 2.'])
    expect(container.querySelector('.transcript-phrase span')?.textContent).toBe('00:04.00 – 00:06.00')
    await click('Apply')
    await edit('Edited right.')
    api.generate.mockResolvedValueOnce({ ...right, path: '/new-right.wav', sourceIn: 0,
      narration: { draftId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', enabled: true } })
    api.load.mockResolvedValueOnce({ ...draft, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', range: [3.5, 7],
      phrases: [{ ...draft.phrases[2], start: 0.5, end: 2.5 }] })
    await click('Generate')
    expect(api.generate.mock.calls[1]?.[2]).toContain('Edited right.')
    expect(api.generate.mock.calls[1]?.[2]).not.toContain('Edited left.')
    expect(api.generate.mock.calls[1]?.[5]).toBe(right.id)
    expect(useEditorStore.getState().session?.overlays.find((item) => item.id === voice.id)).toEqual(left)
    expect(api.analyze).not.toHaveBeenCalled()
  })
  it('preserves a partial sentence edit on reopen and through another cut', async () => {
    useEditorStore.setState((state) => ({ session: state.session && { ...state.session,
      overlays: [{ ...voice, duration: 1 }], selectedOverlayId: voice.id } }))
    await act(async () => { root.render(<Wrapper />); await Promise.resolve() })
    const edited = 'This longer replacement must remain complete.'
    await edit(edited)
    await click('Edit transcript')
    expect(container.querySelector('textarea')?.value).toBe(edited)
    await click('Apply')
    const state = useEditorStore.getState()
    const session = state.session
    if (!session) throw new Error('Missing session')
    const trimmed = removeOutputRange(session.segments, session.overlays, 0, 0.25)
    await act(async () => { useEditorStore.setState({ session: { ...session, ...trimmed } }); await Promise.resolve() })
    await click('Edit transcript')
    expect(container.querySelector('textarea')?.value).toBe(edited)
    await click('Apply')
    await edit('The remaining piece can still be edited.')
    await click('Edit transcript')
    expect(container.querySelector('textarea')?.value).toBe('The remaining piece can still be edited.')
  })

})
