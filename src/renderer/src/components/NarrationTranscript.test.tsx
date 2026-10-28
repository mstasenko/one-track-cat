import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NarrationReview } from '@shared/narration-api'
import { NarrationTranscript } from './NarrationTranscript'

it('shows measured generation speed beside each transcript window', async () => {
  const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
  const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn() })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const draft: NarrationReview = { id: 'draft', range: [0, 20], stage: 'cleaned', approved: true,
    contentKey: 'audio', language: 'en', strength: 'balanced', originalPath: '/o.wav', speechPath: '/s.wav', backgroundPath: '/b.wav',
    phrases: [1, 1.085, 0.85, undefined, NaN, 0].map((generatedTempo, index) => ({ id: `p${index}`,
      start: index * 2, end: index * 2 + 1, text: 'Words.', revisedText: 'Words.', needsTimingReview: false, generatedTempo })) }
  try {
    await act(async () => { root.render(<NarrationTranscript open draft={draft} onEdit={vi.fn()} onClose={vi.fn()} />); await Promise.resolve() })
    expect([...container.querySelectorAll('small')].map((item) => item.textContent.trim())).toEqual([
      '· 0% faster', '· 8.5% faster', '· 15% slower'
    ])
    expect(container.querySelector('label span')?.textContent).toContain('00:00.00 – 00:01.00')
    expect(container.querySelectorAll('textarea')).toHaveLength(6)
  } finally {
    act(() => root.unmount())
    container.remove()
    if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow)
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal
    if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close
  }
})

describe('Transcript opening', () => {
  const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
  const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
  const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  const scroll = vi.fn()
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const draft: NarrationReview = { id: 'selected', range: [100, 112], stage: 'cleaned', approved: true,
    contentKey: 'audio', language: 'en', strength: 'balanced', originalPath: '/o.wav', speechPath: '/s.wav', backgroundPath: '/b.wav',
    phrases: [0, 4, 8].map((start, index) => ({ id: `p${index}`, start, end: start + 2,
      text: `Original ${index}.`, revisedText: `Revised ${index}.`, needsTimingReview: false })) }
  async function render(playhead: number, review = draft, retry = false): Promise<void> {
    await act(async () => {
      root.render(<NarrationTranscript open draft={review} playhead={playhead} onEdit={vi.fn()} onClose={vi.fn()}
        onRetry={retry ? vi.fn() : undefined} retryFrom={retry ? 2 : 0} />)
      await Promise.resolve()
    })
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn() })
    scroll.mockClear()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    for (const [prototype, key, descriptor] of [
      [HTMLDialogElement.prototype, 'showModal', originalShow], [HTMLDialogElement.prototype, 'close', originalClose],
      [Element.prototype, 'scrollIntoView', originalScroll]
    ] as const) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor)
      else Reflect.deleteProperty(prototype, key)
    }
  })

  it.each([[99, 0], [100, 0], [104.5, 1], [106, 2], [107, 2], [112, 2], [120, 2]])('opens at timeline %s near phrase %s', async (playhead, index) => {
      const focus = vi.spyOn(HTMLElement.prototype, 'focus')
      try {
        await render(playhead)
        const field = container.querySelectorAll('textarea')[index]
        expect(document.activeElement).toBe(field)
        expect(focus).toHaveBeenCalledWith({ preventScroll: true })
        expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center' })
        expect(scroll.mock.instances[0]).toBe(field?.closest('.transcript-phrase'))
      } finally { focus.mockRestore() }
    })

  it('keeps the overrun visible even when the playhead is in an earlier read-only phrase', async () => {
    await render(100, { ...draft, overruns: [{ id: 'p2', text: 'Revised 2.', extraSeconds: 0.5 }] }, true)
    expect(document.activeElement).toBe(container.querySelectorAll('textarea')[2])
    expect(scroll.mock.instances[0]).toBe(container.querySelector('.transcript-overrun'))
  })

  it('does not move focus or scroll again while editing', async () => {
    await render(104.5)
    const field = document.activeElement
    const scroller = container.querySelector('.transcript-scroll')
    if (!scroller) throw new Error('Missing transcript scroller')
    scroller.scrollTop = 250
    await render(109, { ...draft, phrases: draft.phrases.map((phrase) => ({ ...phrase, revisedText: 'Edited text.' })) })
    expect(document.activeElement).toBe(field)
    expect(scroller.scrollTop).toBe(250)
    expect(scroll).toHaveBeenCalledTimes(1)
  })
})
