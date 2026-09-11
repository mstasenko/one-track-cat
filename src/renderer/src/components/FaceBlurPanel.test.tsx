import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FaceBlurEffect, FaceBlurSettings, MediaMetadata } from '@shared/types'
import { createSession } from '../model/timeline'
import { FaceBlurPanel } from './FaceBlurPanel'

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function renderPanel(
  session = createSession(metadata),
  effects: FaceBlurEffect[] = [],
  onApply: (settings: FaceBlurSettings) => void = vi.fn(),
  onRemove: (id: string) => void = vi.fn(),
  selectedEffect: FaceBlurEffect | null = null
): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<FaceBlurPanel
      session={session}
      effects={effects}
      selectedEffect={selectedEffect}
      onBack={vi.fn()}
      onApply={onApply}
      onRemove={onRemove}
    />)
  })
  return container
}

function button(app: HTMLDivElement, name: string | RegExp): HTMLButtonElement {
  const result = [...app.querySelectorAll('button')].find((candidate) => {
    const text = candidate.textContent
    return typeof name === 'string' ? text === name : name.test(text)
  })
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Button ${String(name)} missing`)
  return result
}

function labeledInput(app: HTMLDivElement, label: string): HTMLInputElement | HTMLSelectElement {
  const result = app.querySelector(`[aria-label="${label}"]`)
  if (!(result instanceof HTMLInputElement) && !(result instanceof HTMLSelectElement)) throw new Error(`Control ${label} missing`)
  return result
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'otc', {
    configurable: true,
    value: { facePackStatus: vi.fn().mockResolvedValue({ available: true, message: 'ready' }) }
  })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('face blur panel', () => {
  it('blocks applying when the optional face pack is missing', async () => {
    vi.mocked(window.otc.facePackStatus).mockResolvedValue({
      available: false,
      message: 'Install the optional face pack.'
    })
    const app = renderPanel()
    await vi.waitFor(() => expect(app.textContent).toMatch(/Download and extract the face-pack/))
    expect(button(app, 'Apply face blur').disabled).toBe(true)
    expect(app.textContent).toMatch(/next to the OneTrackCat AppImage/)
  })

  it('uses the requested defaults and sends edited settings', async () => {
    const onApply = vi.fn<(settings: FaceBlurSettings) => void>()
    const app = renderPanel(undefined, [], onApply)
    await vi.waitFor(() => expect(button(app, 'Apply face blur').disabled).toBe(false))
    expect((labeledInput(app, 'Sensitivity') as HTMLInputElement).value).toBe('0.7')
    expect((labeledInput(app, 'Small faces (slower)') as HTMLInputElement).checked).toBe(true)
    expect((labeledInput(app, 'Hold missed faces seconds') as HTMLInputElement).value).toBe('0.3')
    expect((labeledInput(app, 'Strength') as HTMLInputElement).value).toBe('0.7')
    expect((labeledInput(app, 'Style') as HTMLSelectElement).value).toBe('pixelate')

    act(() => {
      const style = labeledInput(app, 'Style') as HTMLSelectElement
      style.value = 'mask'
      style.dispatchEvent(new Event('change', { bubbles: true }))
      const hold = labeledInput(app, 'Hold missed faces seconds') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(hold)
      setter?.('0.5')
      hold.dispatchEvent(new Event('input', { bubbles: true }))
      hold.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => { button(app, 'Apply face blur').click() })
    expect(onApply).toHaveBeenCalledWith({ sensitivity: 0.7, detail: 'small', holdSeconds: 0.5, strength: 0.7, style: 'mask' })
    expect(app.querySelector('button:not([aria-label^="Remove face blur"])')?.textContent).not.toMatch(/Preview/)
  })

  it('keeps the apply scope simple without duplicating timeline effects', async () => {
    const session = createSession(metadata)
    session.faceBlurs = [{
      id: 'saved-face-blur', start: 1, duration: 3, sensitivity: 0.42, detail: 'small',
      holdSeconds: 0.55, strength: 0.81, style: 'mask'
    }]
    session.marks = [2, 6]
    session.playhead = 3
    const onRemove = vi.fn<(id: string) => void>()
    const app = renderPanel(session, session.faceBlurs, vi.fn(), onRemove)
    await vi.waitFor(() => expect(button(app, 'Apply face blur').disabled).toBe(false))
    expect(app.textContent).toContain('Apply to selected range.')
    expect(app.textContent).not.toMatch(/00:02.00 – 00:06.00|00:01.00 – 00:04.00/)
    expect(app.textContent).not.toMatch(/Face blur at the playhead|Selected face blur|No face blur at the playhead/)
    expect(app.querySelector('.face-blur-active')).toBeNull()
    expect(app.querySelectorAll('.face-blur-effect')).toHaveLength(0)
    expect(app.querySelector('button[aria-label^="Remove face blur"]')).toBeNull()
    expect(app.textContent).not.toMatch(/Preview selected range|Preview entire video/)
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('labels an unselected preview as the entire video without the privacy warning', async () => {
    const app = renderPanel()
    await vi.waitFor(() => expect(button(app, 'Apply face blur').disabled).toBe(false))
    expect(app.textContent).toContain('Apply to entire video.')
    expect(app.textContent).not.toMatch(/00:00.00 – 00:10.00/)
    expect(app.textContent).not.toMatch(/Preview selected range|Preview entire video/)
    expect(app.querySelector('.face-blur-warning')).toBeNull()
    expect(app.textContent).not.toMatch(/cannot guarantee 100% privacy|processes the entire video and may take time/)
  })

  it('does not render a playhead effect summary or remove action', async () => {
    const session = createSession(metadata)
    session.faceBlurs = [{
      id: 'saved-face-blur', start: 1, duration: 2, sensitivity: 0.7, detail: 'standard',
      holdSeconds: 0.3, strength: 0.7, style: 'pixelate'
    }]
    session.playhead = 5
    const app = renderPanel(session, session.faceBlurs)
    await vi.waitFor(() => expect(button(app, 'Apply face blur').disabled).toBe(false))
    expect(app.textContent).not.toMatch(/Face blur at the playhead|No face blur at the playhead/)
    expect(app.querySelectorAll('.face-blur-effect')).toHaveLength(0)
    expect(app.querySelector('button[aria-label^="Remove face blur"]')).toBeNull()
  })

  it('uses an explicitly selected effect range and settings away from the playhead', async () => {
    const session = createSession(metadata)
    session.playhead = 8
    const selected: FaceBlurEffect = {
      id: 'selected-face-blur', start: 1.25, duration: 2.5, sensitivity: 0.42, detail: 'small',
      holdSeconds: 0.55, strength: 0.81, style: 'mask'
    }
    const onRemove = vi.fn<(id: string) => void>()
    const app = renderPanel(session, [selected], vi.fn(), onRemove, selected)
    await vi.waitFor(() => expect(button(app, 'Apply face blur').disabled).toBe(false))
    expect(app.textContent).toContain('Apply to selected range.')
    expect(app.textContent).not.toMatch(/00:01.25 – 00:03.75/)
    expect(app.textContent).not.toMatch(/Selected face blur|Face blur at the playhead/)
    expect((labeledInput(app, 'Sensitivity') as HTMLInputElement).value).toBe('0.42')
    expect((labeledInput(app, 'Small faces (slower)') as HTMLInputElement).checked).toBe(true)
    expect((labeledInput(app, 'Hold missed faces seconds') as HTMLInputElement).value).toBe('0.55')
    expect((labeledInput(app, 'Strength') as HTMLInputElement).value).toBe('0.81')
    expect((labeledInput(app, 'Style') as HTMLSelectElement).value).toBe('mask')
    const remove = app.querySelector('button[aria-label^="Remove face blur"]')
    if (!(remove instanceof HTMLButtonElement)) throw new Error('remove button missing')
    act(() => { remove.click() })
    expect(onRemove).toHaveBeenCalledWith('selected-face-blur')
  })
})
