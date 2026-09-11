import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageOverlay, Overlay, TextAnimationPreset, TextOverlay } from '@shared/types'
import { Inspector } from './Inspector'

type VideoOverlay = Extract<Overlay, { type: 'video' }>

function imageOverlay(duration = 0.2): ImageOverlay {
  return {
    id: 'image', type: 'image', name: 'Badge', path: '/badge.png', start: 0, duration,
    zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1
  }
}

function videoOverlay(duration = 2): VideoOverlay {
  return {
    id: 'video', type: 'video', name: 'Clip', path: '/clip.mp4', start: 0, duration,
    zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1, loop: false,
    audioEnabled: false, hasAudio: false, volume: 1, sourceIn: 0, sourceDuration: 2
  }
}

function textOverlay(duration = 2): TextOverlay {
  return {
    id: 'text', type: 'text', name: 'Title', start: 0, duration,
    zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1, text: 'Title',
    fontFamily: 'Roboto', fontSize: 8, color: '#fff', outlineColor: '#000',
    outlineWidth: 0, shadow: false, align: 'center'
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function renderInspector(overlay: Overlay, onChange: (patch: Partial<Overlay>) => void, onPreviewAnimation: () => void, onAnimation: (preset: TextAnimationPreset) => void = vi.fn<(preset: TextAnimationPreset) => void>()): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<Inspector
      overlay={overlay}
      maxDuration={2}
      framesPerSecond={30}
      onBack={vi.fn()}
      onChange={onChange}
      onRemove={vi.fn()}
      onAnimation={onAnimation}
      onPreviewAnimation={onPreviewAnimation}
    />)
  })
  return container
}

function updateInspector(overlay: Overlay, onChange: (patch: Partial<Overlay>) => void, onPreviewAnimation: () => void, onAnimation: (preset: TextAnimationPreset) => void = vi.fn<(preset: TextAnimationPreset) => void>()): void {
  act(() => {
    root?.render(<Inspector
      overlay={overlay}
      maxDuration={2}
      framesPerSecond={30}
      onBack={vi.fn()}
      onChange={onChange}
      onRemove={vi.fn()}
      onAnimation={onAnimation}
      onPreviewAnimation={onPreviewAnimation}
    />)
  })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

describe('media animation inspector controls', () => {
  it('centers text horizontally and accepts typed number replacements', () => {
    const onChange = vi.fn<(patch: Partial<Overlay>) => void>()
    const app = renderInspector({ ...textOverlay(), width: 0.6, align: 'left' }, onChange, vi.fn())
    const center = [...app.querySelectorAll('input[type="checkbox"]')].find((input) => input.closest('label.control-row')?.textContent.includes('Center text'))
    if (!(center instanceof HTMLInputElement)) throw new Error('text centering control missing')
    act(() => { center.click() })
    expect(onChange).toHaveBeenLastCalledWith({ align: 'center' })

    const row = [...app.querySelectorAll('label.control-row')].find((candidate) => candidate.textContent.includes('Visible for'))
    const input = row?.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error('Visible for control missing')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(input)
    act(() => { setter?.(''); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(input.value).toBe('')
    act(() => { setter?.('1.25'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(onChange).toHaveBeenLastCalledWith({ duration: 1.25 })
  })

  it('offers all text animation presets and configurable visual fade timing without a media preview button', () => {
    for (const initialOverlay of [imageOverlay(), videoOverlay()]) {
      const onChange = vi.fn<(patch: Partial<Overlay>) => void>()
      const onPreviewAnimation = vi.fn<() => void>()
      const app = renderInspector(initialOverlay, onChange, onPreviewAnimation)
      const select = app.querySelector('select')
      if (!(select instanceof HTMLSelectElement)) throw new Error('media animation select missing')
      const fadeControl = (label: string): HTMLInputElement => {
        const row = [...app.querySelectorAll('label.control-row')].find((candidate) => candidate.textContent.includes(label))
        const input = row?.querySelector('input[type="number"]')
        if (!(input instanceof HTMLInputElement)) throw new Error(`${label} control missing`)
        return input
      }
      const setNumber = (input: HTMLInputElement, value: string): void => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(input)
        setter?.(value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      expect(select.value).toBe('none')
      expect([...select.options].map((option) => option.value)).toEqual(['none', 'pop', 'fade', 'bounce', 'shake'])
      expect(app.querySelector('button[aria-label^="Preview"]')).toBeNull()

      select.value = 'fade'
      act(() => { select.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(onChange).toHaveBeenCalledWith({ animation: 'fade' })

      const fadedOverlay = { ...initialOverlay, animation: 'fade' as const }
      updateInspector(fadedOverlay, onChange, onPreviewAnimation)
      const expectedDefault = Math.min(0.22, initialOverlay.duration / 2)
      expect(Number(fadeControl('Visual fade in').value)).toBeCloseTo(expectedDefault)
      expect(Number(fadeControl('Visual fade out').value)).toBeCloseTo(expectedDefault)

      updateInspector({ ...fadedOverlay, animationFadeIn: 5, animationFadeOut: 5 }, onChange, onPreviewAnimation)
      expect(Number(fadeControl('Visual fade in').value)).toBeCloseTo(Math.min(5, initialOverlay.duration))
      expect(Number(fadeControl('Visual fade out').value)).toBeCloseTo(Math.min(5, initialOverlay.duration))

      const fadeIn = fadeControl('Visual fade in')
      act(() => { setNumber(fadeIn, '0') })
      expect(onChange).toHaveBeenLastCalledWith({ animationFadeIn: 0 })

      const fadeOut = fadeControl('Visual fade out')
      act(() => { setNumber(fadeOut, '0.05') })
      expect(onChange).toHaveBeenLastCalledWith({ animationFadeOut: 0.05 })

      act(() => { root?.unmount() })
      root = undefined
      container?.remove()
      container = undefined
    }
  })

  it('shows text fade timing and preserves the text preview button', () => {
    const onChange = vi.fn<(patch: Partial<Overlay>) => void>()
    const onAnimation = vi.fn<(preset: TextAnimationPreset) => void>()
    const onPreviewAnimation = vi.fn<() => void>()
    const overlay = textOverlay()
    const app = renderInspector(overlay, onChange, onPreviewAnimation, onAnimation)
    const animationRow = [...app.querySelectorAll('label.control-row')].find((row) => row.textContent.includes('Animation'))
    const select = animationRow?.querySelector('select')
    if (!(select instanceof HTMLSelectElement)) throw new Error('text animation select missing')
    expect(app.querySelector('button[aria-label="Preview text animation"]')).not.toBeNull()

    select.value = 'fade'
    act(() => { select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(onAnimation).toHaveBeenCalledWith('fade')
    updateInspector({ ...overlay, animation: 'fade' }, onChange, onPreviewAnimation, onAnimation)
    const fadeIn = [...app.querySelectorAll('label.control-row')].find((row) => row.textContent.includes('Visual fade in'))?.querySelector('input')
    if (!(fadeIn instanceof HTMLInputElement)) throw new Error('text fade timing missing')
    expect(Number(fadeIn.value)).toBeCloseTo(0.22)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(fadeIn)
    setter?.('0.1')
    act(() => { fadeIn.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(onChange).toHaveBeenLastCalledWith({ animationFadeIn: 0.1 })
  })

  it.each([
    ['pop', 0.28],
    ['bounce', 0.38],
    ['shake', 0.55]
  ] as const)('uses the %s animation duration default and accepts edits', (animation, expected) => {
    const onChange = vi.fn<(patch: Partial<Overlay>) => void>()
    const app = renderInspector({ ...textOverlay(), animation }, onChange, vi.fn())
    const row = [...app.querySelectorAll('label.control-row')].find((candidate) => candidate.textContent.includes('Animation duration'))
    const input = row?.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error('animation duration missing')
    expect(Number(input.value)).toBeCloseTo(expected)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(input)
    setter?.('0.45')
    act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(onChange).toHaveBeenLastCalledWith({ animationDuration: 0.45 })
  })

  it.each([
    ['pop', 0.1],
    ['bounce', 0.1],
    ['shake', 0.2]
  ] as const)('clamps the %s animation duration default for short overlays', (animation, expected) => {
    const app = renderInspector({ ...textOverlay(0.2), animation }, vi.fn(), vi.fn())
    const row = [...app.querySelectorAll('label.control-row')].find((candidate) => candidate.textContent.includes('Animation duration'))
    const input = row?.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error('short animation duration missing')
    expect(Number(input.value)).toBeCloseTo(expected)
    expect(input.max).toBe('0.2')
  })
})
