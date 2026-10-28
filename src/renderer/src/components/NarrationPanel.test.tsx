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
  recognition: { speechDetection: 'balanced' },
  originalPath: '/original.wav', speechPath: '/speech.wav', backgroundPath: '/background.wav',
  phrases: [{ id: 'phrase-0', start: 1, end: 5, text: 'Um, wait here.', revisedText: 'Wait here.', needsTimingReview: false }] }
const generated: AudioOverlay = { id: 'generated', name: 'AI Narration', type: 'audio', path: '/AI.wav', sourceIn: 0,
  start: 0, duration: 10, volume: 1, zIndex: 0, narration: { draftId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', enabled: true } }
let root: Root
let container: HTMLDivElement
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
const api = {
  status: vi.fn(), analyze: vi.fn(), load: vi.fn(), generate: vi.fn(), cancel: vi.fn(), progress: vi.fn()
}
const pause = vi.fn()
function Wrapper() {
  const session = useEditorStore((state) => state.session)
  if (!session) return null
  const overlay = session.overlays.find((item) => item.id === session.selectedOverlayId)
  return <NarrationPanel key={overlay ? 'inspector' : 'add'} session={session} overlay={overlay?.type === 'audio' ? overlay : undefined} onBack={vi.fn()} onPause={pause} />
}
async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text)
  if (!button) throw new Error(`Missing ${text}`)
  await act(async () => { button.click(); await Promise.resolve() })
}
async function mount(): Promise<void> { await act(async () => { root.render(<Wrapper />); await Promise.resolve() }) }
function expectGenerationControls(enabled: boolean): void {
  const generate = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Generate')
  expect(generate?.disabled).toBe(!enabled)
  for (const label of ['Voice style', 'Background', 'Even voice volume', 'Slowdown (%)', 'Subtitles']) {
    expect(container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)?.disabled).toBe(!enabled)
  }
}
async function fill(label: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`Missing ${label}`)
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
  await act(async () => { input.blur(); await Promise.resolve() })
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false } })
  api.status.mockResolvedValue({ available: true, message: 'Ready' })
  api.analyze.mockResolvedValue(draft)
  api.load.mockResolvedValue(draft)
  api.generate.mockImplementation(() => { api.load.mockResolvedValue({ ...draft, id: generated.narration?.draftId, stage: 'cleaned', approved: true }); return Promise.resolve(generated) })
  api.cancel.mockResolvedValue(undefined)
  api.progress.mockReturnValue(() => undefined)
  Object.defineProperty(window, 'otc', { configurable: true, value: { narration: api, waveform: vi.fn().mockResolvedValue([]) } })
  useEditorStore.setState({ session: createSession({ path: '/video.mp4', name: 'video', size: 1, modifiedAt: 1,
    duration: 10, width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true }), history: [], future: [], gesture: null, error: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() }); container.remove()
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close
})
describe('Re-voice desktop', () => {
  it('defaults subtitles off and generates optional timed lines with the narration', async () => {
    await mount()
    expect(container.querySelector<HTMLInputElement>('[aria-label="Subtitles"]')?.checked).toBe(false)
    await click('Recognize')
    await act(async () => { container.querySelector<HTMLInputElement>('[aria-label="Subtitles"]')?.click(); await Promise.resolve() })
    api.generate.mockResolvedValue({ ...generated, subtitleLines: [{ start: 1.2, end: 2.4, text: 'Wait here.' }] })
    await click('Generate')
    expect(api.generate.mock.calls.at(-1)?.[4]).toMatchObject({ subtitles: true })
    const overlays = useEditorStore.getState().session?.overlays
    expect(overlays).toHaveLength(2)
    expect(overlays?.[1]).toMatchObject({ type: 'text', text: 'Wait here.', start: 1.2, duration: 1.2,
      narrationId: generated.narration?.draftId })
    expect(overlays?.[0]).not.toHaveProperty('subtitleLines')
    await act(async () => { useEditorStore.getState().undo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays).toEqual([])
    await act(async () => { useEditorStore.getState().redo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays).toEqual(overlays)
  })
  it('reopens an existing marked section from Add and keeps its timing review after the inspector mounts', async () => {
    const phrases = [0, 1, 2].map((index) => ({ ...draft.phrases[0], id: `phrase-${index}`,
      start: index, end: index + 1, text: 'Wait.', revisedText: 'Please wait.', needsTimingReview: false }))
    const loaded = { ...draft, range: [5, 10] as [number, number], phrases }
    const review = { ...loaded, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      overruns: [{ id: 'phrase-2', text: 'Please wait.', extraSeconds: 0.51 }] }
    const first: AudioOverlay = { ...generated, id: 'first', duration: 5 }
    const second: AudioOverlay = { ...generated, id: 'second', start: 5, duration: 5,
      narration: { draftId: loaded.id, enabled: true } }
    api.load.mockImplementation((id: string) => Promise.resolve(id === review.id ? review : loaded))
    api.generate.mockResolvedValue({ review })
    useEditorStore.setState((state) => ({ session: state.session && { ...state.session,
      overlays: [first, second], selectedOverlayId: null, marks: [5], playhead: 7 } }))
    await mount()
    expectGenerationControls(true)
    await click('Generate')
    expect(container.querySelector('dialog')?.open).toBe(true)
    expect(container.textContent).not.toContain('overlapping Re-voice')
    expect(container.textContent).toContain('Phrase 3: 0.6 s too long')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Revised phrase 3')
    expect(useEditorStore.getState().session?.overlays).toHaveLength(2)
    expect(useEditorStore.getState().session?.overlays[0]).toEqual(first)
    expect(useEditorStore.getState().session?.overlays[1]).toMatchObject({ id: second.id, narration: { draftId: review.id } })
  })
  it('edits and regenerates either existing section independently of the current marks', async () => {
    const first = { ...draft, range: [0, 5] as [number, number] }
    const second = { ...draft, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', range: [5, 10] as [number, number] }
    const firstAudio: AudioOverlay = { ...generated, id: 'first', duration: 5,
      narration: { draftId: first.id, enabled: true, slowdown: 0.2 } }
    const secondAudio: AudioOverlay = { ...generated, id: 'second', start: 5, duration: 5,
      narration: { draftId: second.id, enabled: true, slowdown: 0.35 } }
    api.load.mockImplementation((draftId: string) => Promise.resolve({
      ...(draftId === second.id ? second : first), id: draftId, approved: true
    }))
    api.generate.mockResolvedValue({ ...firstAudio, path: '/regenerated-first.wav',
      narration: { ...firstAudio.narration, draftId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', enabled: true } })
    useEditorStore.setState((state) => ({ session: state.session && { ...state.session,
      overlays: [firstAudio, secondAudio], selectedOverlayId: firstAudio.id, marks: [2, 5, 8], playhead: 7 } }))
    await mount()
    expectGenerationControls(true)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Slowdown (%)"]')?.value).toBe('20')
    await click('Edit transcript')
    const field = container.querySelector<HTMLTextAreaElement>('textarea')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, 'Please stop here.')
      field?.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    await click('Apply')
    await click('Generate')
    expect(api.generate).toHaveBeenCalledWith(expect.anything(), first.id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Please stop here.', originalText: 'Um, wait here.' }] }),
      'original', { levelVoice: false, backgroundVolume: 1, slowdown: 0.2, subtitles: false }, firstAudio.id)
    const overlays = useEditorStore.getState().session?.overlays
    expect(overlays).toHaveLength(2)
    expect(overlays?.find((overlay) => overlay.id === firstAudio.id)).toMatchObject({ path: '/regenerated-first.wav', start: 0, duration: 5 })
    expect(overlays?.find((overlay) => overlay.id === secondAudio.id)).toEqual(secondAudio)
    await act(async () => { useEditorStore.getState().selectOverlay(secondAudio.id); await Promise.resolve() })
    expectGenerationControls(true)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Slowdown (%)"]')?.value).toBe('35')
    expect(useEditorStore.getState().session).toMatchObject({ marks: [2, 5, 8], playhead: 7 })
  })
  it('waits for the selected draft instead of generating a stale review from the same range', async () => {
    await mount()
    await click('Recognize')
    expectGenerationControls(true)
    let complete: (review: NarrationReview) => void = () => undefined
    api.load.mockReturnValueOnce(new Promise<NarrationReview>((resolve) => { complete = resolve }))
    await act(async () => {
      const store = useEditorStore.getState()
      const overlay = store.session?.overlays[0]
      if (overlay?.type !== 'audio') throw new Error('Missing narration')
      store.updateOverlay(overlay.id, { narration: { ...overlay.narration, draftId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', enabled: false } }); await Promise.resolve()
    })
    expectGenerationControls(false)
    await act(async () => {
      complete({ ...draft, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
      await Promise.resolve()
    })
    expectGenerationControls(true)
  })
  it('keeps separate sections and enables generation after recognizing each one', async () => {
    const first = { ...draft, range: [0, 5] as [number, number] }
    const second = { ...draft, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', range: [5, 10] as [number, number] }
    const firstAudio = { ...generated, duration: 5 }
    const secondAudio = { ...generated, id: 'second-audio', start: 5, duration: 5,
      narration: { draftId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', enabled: true } }
    api.analyze.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    api.generate.mockResolvedValueOnce(firstAudio).mockResolvedValueOnce(secondAudio)
    api.load.mockImplementation((draftId: string) => Promise.resolve({
      ...(draftId === first.id || draftId === firstAudio.narration?.draftId ? first : second), id: draftId
    }))
    useEditorStore.setState((state) => ({ session: state.session && { ...state.session, marks: [5], playhead: 2 } }))
    await mount()
    await click('Recognize')
    expectGenerationControls(true)
    await fill('Slowdown (%)', '20')
    await click('Generate')
    const firstEffect = useEditorStore.getState().session?.overlays[0]
    await act(async () => {
      useEditorStore.getState().selectOverlay(null)
      useEditorStore.getState().setPlayhead(7)
      await Promise.resolve()
    })
    expectGenerationControls(false)
    await click('Recognize')
    expect(api.analyze).toHaveBeenLastCalledWith(expect.anything(), [5, 10], 'auto', false,
      { speechDetection: 'balanced', audio: 'original' })
    expectGenerationControls(true)
    expect(useEditorStore.getState().session?.overlays[0]).toEqual(firstEffect)
    await fill('Slowdown (%)', '35')
    await click('Generate')
    const applied = useEditorStore.getState().session?.overlays
    expect(applied).toHaveLength(2)
    expect(applied?.[0]).toEqual(firstEffect)
    expect(applied?.[1]).toMatchObject({ start: 5, duration: 5, path: secondAudio.path })
    expect(applied?.[0]).toMatchObject({ narration: { slowdown: 0.2 } })
    expect(applied?.[1]).toMatchObject({ narration: { slowdown: 0.35 } })
    expect(api.generate.mock.calls[1]?.[4]).toMatchObject({ slowdown: 0.35 })
    await act(async () => { useEditorStore.getState().undo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays).toEqual([firstEffect])
    await act(async () => { useEditorStore.getState().redo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays).toEqual(applied)
  })
  it('defaults voice leveling on below background, keeps recognition simple and restores mix settings with Undo/Redo', async () => {
    await mount()
    expect(container.querySelector('[aria-label="Terminology hints"]')).toBeNull()
    expectGenerationControls(false)
    expect(container.querySelector('select[aria-label="Voice style"] option[value="original"]')?.textContent).toBe('Original')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Even voice volume"]')?.checked).toBe(true)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Slowdown (%)"]')?.value).toBe('0')
    const translate = container.querySelector<HTMLInputElement>('[aria-label="Translate to English"]')
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Speech detection"]')?.value).toBe('balanced')
    expect(translate?.checked).toBe(false)
    const recognize = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Recognize')
    if (!translate || !recognize) throw new Error('Missing translation or recognition control')
    expect(translate.compareDocumentPosition(recognize) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const controls = [...container.querySelectorAll('input')].map((input) => input.getAttribute('aria-label'))
    expect(controls.indexOf('Even voice volume')).toBeGreaterThan(controls.indexOf('Background'))
    await click('Recognize')
    expect(api.analyze).toHaveBeenCalledWith(expect.anything(), [0, 10], 'auto', false,
      { speechDetection: 'balanced', audio: 'original' })
    expectGenerationControls(true)
    await fill('Background', '25')
    await click('Generate')
    expect(api.generate.mock.calls[0]?.[4]).toEqual({ levelVoice: true, backgroundVolume: 0.25, slowdown: 0, subtitles: false })
    const applied = useEditorStore.getState().session?.overlays
    expect(applied).toMatchObject([{ narration: { levelVoice: true, backgroundVolume: 0.25 } }])
    await act(async () => { useEditorStore.getState().undo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays).toEqual([])
    await act(async () => { useEditorStore.getState().redo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays).toEqual(applied)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Background"]')?.value).toBe('25')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Even voice volume"]')?.checked).toBe(true)
    expect(api.generate).toHaveBeenCalledTimes(1)
  })
  it('passes the optional translation choice only when enabled', async () => {
    await mount()
    const translate = container.querySelector<HTMLInputElement>('[aria-label="Translate to English"]')
    await act(async () => { translate?.click(); await Promise.resolve() })
    expect(translate?.checked).toBe(true)
    await click('Recognize')
    expect(api.analyze).toHaveBeenCalledWith(expect.anything(), [0, 10], 'auto', true,
      { speechDetection: 'balanced', audio: 'original' })
  })
  it('restores a saved translation choice without changing the loaded draft when toggled', async () => {
    const loaded = { ...draft, translateToEnglish: true }
    api.load.mockResolvedValue(loaded)
    useEditorStore.setState((state) => ({ session: state.session && { ...state.session, selectedOverlayId: generated.id,
      overlays: [{ ...generated, narration: { draftId: id, enabled: true } }] } }))
    await mount()
    const translate = container.querySelector<HTMLInputElement>('[aria-label="Translate to English"]')
    expect(translate?.checked).toBe(true)
    await act(async () => { translate?.click(); await Promise.resolve() })
    expect(translate?.checked).toBe(false)
    expect(loaded.translateToEnglish).toBe(true)
    await click('Recognize')
    expect(api.analyze).toHaveBeenCalledWith(expect.anything(), [0, 10], 'auto', false,
      { speechDetection: 'balanced', audio: 'original' })
  })
  it('preserves a saved disabled leveling choice instead of replacing it with the new default', async () => {
    useEditorStore.setState((state) => ({ session: state.session && { ...state.session, selectedOverlayId: generated.id,
      overlays: [{ ...generated, narration: { draftId: id, enabled: true, levelVoice: false } }] } }))
    await mount()
    expect(container.querySelector<HTMLInputElement>('[aria-label="Even voice volume"]')?.checked).toBe(false)
  })
  it('groups transcript typing and initial generation into one shared Undo/Redo step', async () => {
    await mount()
    await click('Recognize')
    await click('Edit transcript')
    const field = container.querySelector<HTMLTextAreaElement>('textarea')
    for (let index = 0; index < 60; index++) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, `Edited ${index}.`)
        field?.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    expect(useEditorStore.getState().history).toHaveLength(1)
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ narration: { revisions: ['Edited 59.'] } })
    await click('Apply')
    expect(useEditorStore.getState().history).toHaveLength(2)
    await click('Generate')
    expect(useEditorStore.getState().history).toHaveLength(1)
    const applied = useEditorStore.getState().session?.overlays
    await act(async () => { useEditorStore.getState().undo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays).toEqual([])
    await act(async () => { useEditorStore.getState().redo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays).toEqual(applied)
    expect(api.generate).toHaveBeenCalledTimes(1)
  })
  it('locks earlier generated lines while retrying a later phrase', async () => {
    const phraseTemplate = draft.phrases[0]
    if (!phraseTemplate) throw new Error('Missing fixture phrase')
    const recognized: NarrationReview = { ...draft, phrases: [
      { ...phraseTemplate, id: 'first', start: 0, end: 2 },
      { ...phraseTemplate, id: 'second', start: 3, end: 5 },
      { ...phraseTemplate, id: 'third', start: 6, end: 8 }
    ] }
    const review: NarrationReview = { ...recognized, stage: 'cleaned', id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      overruns: [{ id: 'second', text: 'Wait here.', extraSeconds: 0.4 }] }
    api.analyze.mockResolvedValue(recognized)
    api.load.mockResolvedValue(recognized)
    api.generate.mockImplementation(() => { api.load.mockResolvedValue(review); return Promise.resolve({ review }) })
    await mount()
    await click('Recognize')
    await click('Edit transcript')
    expect([...container.querySelectorAll('textarea')].every((field) => !field.readOnly)).toBe(true)
    await click('Apply')
    await click('Generate')
    expect([...container.querySelectorAll('textarea')].map((field) => field.readOnly)).toEqual([true, false, false])
    expect(container.querySelector('dialog select')).toBeNull()
    expect(container.querySelector('[role=tab]')).toBeNull()
    const phrase = container.querySelector<HTMLTextAreaElement>('[aria-label="Revised phrase 2"]')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(phrase, 'Wait.')
      phrase?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect([...container.querySelectorAll('textarea')].map((field) => field.readOnly)).toEqual([true, false, false])
  })
  it('opens the improved transcript for overruns and blocks retry until the line is edited', async () => {
    const review: NarrationReview = { ...draft, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', stage: 'cleaned',
      overruns: [{ id: 'phrase-0', text: 'Wait here.', extraSeconds: 0.24 }] }
    api.generate.mockImplementation(() => { api.load.mockResolvedValue(review); return Promise.resolve({ review }) })
    await mount()
    await click('Recognize')
    await click('Generate')
    expect(container.querySelector('dialog')?.open).toBe(true)
    expect(container.querySelector('[role=tab]')).toBeNull()
    const phrase = container.querySelector<HTMLTextAreaElement>('[aria-label="Revised phrase 1"]')
    expect(phrase?.getAttribute('aria-invalid')).toBe('true')
    expect(phrase?.closest('label')?.classList.contains('transcript-overrun')).toBe(true)
    expect(container.textContent).toContain('0.3 s too long after maximum speed adjustment')
    const generate = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Generate')
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry generation')
    expect(retry?.disabled).toBe(true)
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Apply')).toBe(false)
    expect(generate?.disabled).toBe(true)
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ narration: { enabled: false } })
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(phrase, '')
      phrase?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(phrase?.hasAttribute('aria-invalid')).toBe(false)
    expect(retry?.disabled).toBe(false)
    expect(container.querySelector('[aria-label="Close transcript"]')).toBeNull()
    await act(async () => { container.querySelector('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true })); await Promise.resolve() })
    await act(async () => { useEditorStore.getState().undo(); await Promise.resolve() })
    expect(generate?.disabled).toBe(true)
    await act(async () => { useEditorStore.getState().redo(); await Promise.resolve() })
    expect(generate?.disabled).toBe(false)
    act(() => { root.unmount() })
    root = createRoot(container)
    await mount()
    await click('Edit transcript')
    expect(container.querySelector('[aria-invalid=true]')).toBeNull()
    api.generate.mockImplementationOnce(() => { api.load.mockResolvedValue({ ...draft, stage: 'cleaned', approved: true }); return Promise.resolve(generated) })
    await click('Retry generation')
    expect(api.generate).toHaveBeenLastCalledWith(expect.anything(), review.id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: '', originalText: 'Um, wait here.' }] }), 'original', { levelVoice: true, backgroundVolume: 1, slowdown: 0, subtitles: false }, expect.any(String))
    expect(useEditorStore.getState().session?.overlays).toMatchObject([{ path: generated.path, narration: { enabled: true } }])
    expect(container.querySelector('dialog')).toBeNull()
  })
  it('analyzes, saves an unapproved effect, skips an empty phrase, generates, and supports Undo', async () => {
    await mount()
    await click('Recognize')
    expect(pause).toHaveBeenCalled()
    expect(api.analyze).toHaveBeenCalledWith(expect.anything(), [0, 10], 'auto', false,
      { speechDetection: 'balanced', audio: 'original' })
    expect(container.textContent).not.toContain('Whisper language')
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ narration: { enabled: false, draftId: id } })
    await click('Edit transcript')
    expect(container.querySelector('dialog')?.open).toBe(true)
    const textarea = container.querySelector('[aria-label="Revised phrase 1"]')
    if (!textarea) throw new Error('Missing review')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ narration: { revisions: [''] } })
    await click('Apply')
    expect(api.generate).not.toHaveBeenCalled()
    await click('Generate')
    expect(api.generate).toHaveBeenCalledWith(expect.anything(), id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: '', originalText: 'Um, wait here.' }] }), 'original', { levelVoice: true, backgroundVolume: 1, slowdown: 0, subtitles: false }, expect.any(String))
    expect(useEditorStore.getState().session?.overlays).toMatchObject([{ path: generated.path, narration: { enabled: true } }])
    const select = [...container.querySelectorAll('select')].find((item) => item.value === 'ai')
    await act(async () => { if (select) { select.value = 'original'; select.dispatchEvent(new Event('change', { bubbles: true })) }; await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ narration: { enabled: false } })
    await act(async () => { useEditorStore.getState().undo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ narration: { enabled: true } })
    expect(container.textContent).not.toContain('Remove Re-voice')
    await act(async () => { useEditorStore.getState().undo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays).toEqual([])
    await act(async () => { useEditorStore.getState().redo(); await Promise.resolve() })
    expect(useEditorStore.getState().session?.overlays).toMatchObject([{ path: generated.path, narration: { enabled: true } }])
  })
  it('generates the already cleaned text without opening the transcript', async () => {
    await mount()
    expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(3)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Even voice volume"]')?.checked).toBe(true)
    expect(container.textContent).not.toContain('Recognition always')
    expect(container.textContent).not.toContain('Cleanup strength')
    expect([...container.querySelectorAll('button')].find((item) => item.textContent === 'Edit transcript')?.disabled).toBe(true)
    await click('Recognize')
    const style = [...container.querySelectorAll('select')].find((item) => item.value === 'original' && item.closest('label')?.textContent.includes('Voice style'))
    act(() => { if (style) { style.value = 'cosy'; style.dispatchEvent(new Event('change', { bubbles: true })) } })
    await click('Generate')
    expect(api.generate).toHaveBeenCalledWith(expect.anything(), id,
      JSON.stringify({ segments: [{ id: 'phrase-0', text: 'Wait here.', originalText: 'Um, wait here.' }] }), 'cosy', { levelVoice: true, backgroundVolume: 1, slowdown: 0, subtitles: false }, expect.any(String))
    expect(useEditorStore.getState().session?.overlays).toMatchObject([{ path: generated.path, narration: { enabled: true } }])
  })
  it('requires recognition again for an older uncleaned draft', async () => {
    const uncleaned = { ...draft, stage: 'recognized' }
    api.analyze.mockResolvedValue(uncleaned)
    api.load.mockResolvedValue(uncleaned)
    await mount()
    await click('Recognize')
    expect(container.textContent).toContain('Recognize again before generating.')
    expectGenerationControls(false)
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Generate')?.disabled).toBe(true)
  })
  it('keeps missing packs and failures visible without installing a broken effect', async () => {
    api.status.mockResolvedValue({ available: false, message: 'Install voice-pack.' })
    await mount()
    expect(container.textContent).toContain('Install voice-pack.')
    expect([...container.querySelectorAll('button')].find((item) => item.textContent === 'Recognize')?.disabled).toBe(true)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Translate to English"]')?.disabled).toBe(true)
  })
  it.each([
    ['status', 'check narration availability'], ['load', 'load this narration review'], ['analyze', 'analyze narration'], ['generate', 'generate narration']
  ])('routes %s failures to the shared error toast without changing the project', async (kind, operation) => {
    if (kind === 'status') api.status.mockRejectedValueOnce(new Error('operation failed'))
    if (kind === 'load') {
      useEditorStore.setState((state) => ({ session: state.session && { ...state.session, overlays: [generated], selectedOverlayId: generated.id } }))
      api.load.mockRejectedValueOnce(new Error('operation failed'))
    }
    if (kind === 'analyze') api.analyze.mockRejectedValueOnce(new Error('operation failed'))
    await mount()
    let before = structuredClone(useEditorStore.getState().session)
    if (kind === 'analyze') await click('Recognize')
    if (kind === 'generate') {
      await click('Recognize')
      before = structuredClone(useEditorStore.getState().session)
      api.generate.mockRejectedValueOnce(new Error('operation failed'))
      await click('Generate')
    }
    await act(async () => { await Promise.resolve() })
    expect(useEditorStore.getState().error).toContain(`could not ${operation}`)
    expect(useEditorStore.getState().session).toEqual(before)
    expect(container.textContent).not.toContain('operation failed')
  })
  it('restores the saved delivery choice through Undo without generating speech', async () => {
    await mount()
    await click('Recognize')
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Voice style"]')
    await act(async () => { if (select) { select.value = 'cosy'; select.dispatchEvent(new Event('change', { bubbles: true })) }; await Promise.resolve() })
    expect(select?.value).toBe('cosy')
    expect(useEditorStore.getState().session?.overlays[0]).toMatchObject({ narration: { voiceStyle: 'cosy' } })
    await act(async () => { useEditorStore.getState().undo(); await Promise.resolve() })
    expect(select?.value).toBe('original')
    expect(api.generate).not.toHaveBeenCalled()
  })
  it('shows progress/ETA and cancellation while preserving the previous project', async () => {
    let reject: ((reason: Error) => void) | undefined
    api.analyze.mockImplementation(() => new Promise((_resolve, onReject) => { reject = onReject }))
    const before = structuredClone(useEditorStore.getState().session)
    await mount()
    await click('Recognize')
    const update = api.progress.mock.calls[0]?.[0] as ((value: unknown) => void)
    expectGenerationControls(false)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Translate to English"]')?.disabled).toBe(true)
    act(() => { update({ stage: 'Transcribing using dGPU', fraction: 0.5, etaSeconds: 8 }) })
    expect(container.textContent).toContain('8s remaining')
    await click('Cancel')
    expect(api.cancel).toHaveBeenCalled()
    await act(async () => { reject?.(new Error('Narration cancelled')); await Promise.resolve() })
    expect(useEditorStore.getState().error).toBeNull()
    expect(useEditorStore.getState().session).toEqual(before)
  })
})
