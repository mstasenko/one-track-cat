import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OnlineTemplate, TemplateCategory, TemplateSource } from '@shared/online-templates'
import type { AssetItem } from '@shared/types'
import { OnlineTemplates } from './OnlineTemplates'

interface Api {
  searchTemplates: ReturnType<typeof vi.fn<(source: TemplateSource, category: TemplateCategory, query: string) => Promise<OnlineTemplate[]>>>
  importTemplate: ReturnType<typeof vi.fn<(source: TemplateSource, id: string) => Promise<AssetItem>>>
  openTemplatePage: ReturnType<typeof vi.fn<(source: TemplateSource, id: string) => Promise<void>>>
}

const imageAsset: AssetItem = { type: 'image', name: 'added.png', path: '/cache/added.png' }
const imageTemplate = (id: number, name = `Image ${id}`): OnlineTemplate => ({
  id: String(id), source: 'imgflip', name, type: 'image', url: `https://i.imgflip.com/${id}.jpg`
})
const videoTemplate = (id: number, name = `Video ${id}`): OnlineTemplate => ({
  id: String(id), source: 'imgflip', name, type: 'video', url: `https://i.imgflip.com/${id}.mp4`
})

let api: Api
let root: Root | undefined
let container: HTMLDivElement | undefined
let originalLoad: PropertyDescriptor | undefined

type MountOverrides = Partial<{
  category: TemplateCategory
  query: string
  projectId: string
  onAsset: (asset: AssetItem) => void
  onError: (message: string) => void
  children: ReactNode
}>

function mount(overrides: MountOverrides = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<OnlineTemplates
      category={overrides.category ?? 'image'}
      query={overrides.query ?? 'cat'}
      projectId={overrides.projectId ?? 'project-a'}
      onAsset={overrides.onAsset ?? vi.fn()}
      onError={overrides.onError ?? vi.fn()}
    >
      {overrides.children}
    </OnlineTemplates>)
  })
  return container
}

function rerender(props: MountOverrides): void {
  act(() => {
    root?.render(<OnlineTemplates
      category={props.category ?? 'image'}
      query={props.query ?? 'cat'}
      projectId={props.projectId ?? 'project-a'}
      onAsset={props.onAsset ?? vi.fn()}
      onError={props.onError ?? vi.fn()}
    >
      {props.children}
    </OnlineTemplates>)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function importButton(app: HTMLDivElement, id: string): HTMLButtonElement {
  const button = app.querySelector(`[data-template-id="${id}"]`)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Template ${id} missing`)
  return button
}

function sourceLink(app: HTMLDivElement, name: string): HTMLButtonElement {
  const button = app.querySelector('.online-template-link')
  if (!(button instanceof HTMLButtonElement)) throw new Error('Source link missing')
  if (button.getAttribute('aria-label') !== `View source for ${name}`) throw new Error('Source link label missing')
  return button
}

function mouseOver(target: HTMLElement, relatedTarget: EventTarget | null = null): void {
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget }))
}

function mouseOut(target: HTMLElement, relatedTarget: EventTarget | null = null): void {
  target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget }))
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  api = {
    searchTemplates: vi.fn<(source: TemplateSource, category: TemplateCategory, query: string) => Promise<OnlineTemplate[]>>().mockResolvedValue([]),
    importTemplate: vi.fn<(source: TemplateSource, id: string) => Promise<AssetItem>>().mockResolvedValue(imageAsset),
    openTemplatePage: vi.fn<(source: TemplateSource, id: string) => Promise<void>>().mockResolvedValue(undefined)
  }
  Object.defineProperty(window, 'otc', { configurable: true, writable: true, value: api })
  originalLoad = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'load')
  Object.defineProperty(HTMLMediaElement.prototype, 'load', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  if (originalLoad) Object.defineProperty(HTMLMediaElement.prototype, 'load', originalLoad)
  else delete (HTMLMediaElement.prototype as Partial<HTMLMediaElement>).load
  originalLoad = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('OnlineTemplates', () => {
  it('debounces search and renders Imgflip while MemeFact is still pending', async () => {
    const meme = deferred<OnlineTemplate[]>()
    api.searchTemplates.mockImplementation((source: TemplateSource) => source === 'memefact' ? meme.promise : Promise.resolve([imageTemplate(2)]))
    const app = mount()

    await act(async () => { await vi.advanceTimersByTimeAsync(349) })
    expect(api.searchTemplates).not.toHaveBeenCalled()
    expect(app.textContent).not.toContain('No online templates found.')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await flush()

    expect(api.searchTemplates).toHaveBeenCalledTimes(3)
    expect(importButton(app, '2').textContent).toContain('Image 2')
    expect(app.textContent).toContain('MemeFact · HF searching…')
    meme.resolve([{
      id: '1', source: 'memefact', name: 'HF cat', type: 'image', url: 'https://i.imgflip.com/1.jpg'
    }])
    await flush()
    expect(importButton(app, '1').textContent).toContain('HF cat')
  })

  it('does not request blank searches and only searches Imgflip for video templates', async () => {
    const app = mount({ category: 'video', query: ' ' })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(api.searchTemplates).not.toHaveBeenCalled()
    expect(app.textContent).not.toContain('Type at least 2 characters')

    rerender({ category: 'video', query: 'c' })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(api.searchTemplates).not.toHaveBeenCalled()
    expect(app.textContent).not.toContain('Type at least 2 characters')

    rerender({ category: 'video', query: 'ca' })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    expect(api.searchTemplates).toHaveBeenCalledOnce()
    expect(api.searchTemplates).toHaveBeenCalledWith('imgflip', 'video', 'ca')

    api.searchTemplates.mockClear()
    rerender({ category: 'image', query: 'ca' })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    expect(api.searchTemplates).toHaveBeenCalledTimes(3)
    expect(api.searchTemplates.mock.calls.map(([source]) => source)).toEqual(['memefact', 'imgflip', 'imkg'])
  })

  it('ignores stale query responses and keeps one provider error local', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<OnlineTemplate[]>>>()
    api.searchTemplates.mockImplementation((source: TemplateSource, _category: TemplateCategory, query: string) => {
      if (source === 'memefact') return Promise.reject(new Error('HF offline'))
      if (source === 'imgflip') {
        const request = deferred<OnlineTemplate[]>()
        pending.set(`${source}:${query}`, request)
        return request.promise
      }
      return Promise.resolve([])
    })
    const app = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    rerender({ query: 'dog' })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    pending.get('imgflip:cat')?.resolve([imageTemplate(1, 'Stale cat')])
    pending.get('imgflip:dog')?.resolve([imageTemplate(2, 'Fresh dog')])
    await flush()

    expect(app.textContent).not.toContain('Stale cat')
    expect(app.textContent).toContain('Fresh dog')
    expect(app.textContent).toContain('MemeFact · HF unavailable. HF offline')
  })

  it('deduplicates numeric IDs with MemeFact first and caps visible rows at 24', async () => {
    api.searchTemplates.mockImplementation((source: TemplateSource) => {
      if (source === 'memefact') return Promise.resolve([
        { id: '7', source, name: 'MemeFact winner', type: 'image', url: 'https://i.imgflip.com/7.jpg' },
        { id: '8', source, name: 'MemeFact eight', type: 'image', url: 'https://i.imgflip.com/8.jpg' }
      ])
      if (source === 'imkg') return Promise.resolve([])
      return Promise.resolve([
        { id: '007', source, name: 'Imgflip duplicate', type: 'image', url: 'https://i.imgflip.com/007.jpg' },
        { id: '9', source, name: 'Imgflip nine', type: 'image', url: 'https://i.imgflip.com/9.jpg' },
        ...Array.from({ length: 30 }, (_, index) => imageTemplate(index + 20))
      ])
    })
    const app = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()

    expect(app.textContent).toContain('MemeFact winner')
    expect(app.textContent).not.toContain('Imgflip duplicate')
    expect(app.querySelectorAll('[data-template-id]')).toHaveLength(24)
  })

  it('does not starve distinct Imgflip rows behind a full MemeFact page', async () => {
    api.searchTemplates.mockImplementation((source: TemplateSource) => source === 'memefact'
      ? Promise.resolve(Array.from({ length: 24 }, (_, index) => ({
        id: String(100 + index), source, name: `MemeFact ${index}`, type: 'image' as const,
        url: `https://i.imgflip.com/${100 + index}.jpg`
      })))
      : Promise.resolve([imageTemplate(999, 'Imgflip tail')]))
    const app = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()

    expect(importButton(app, '999').textContent).toContain('Imgflip tail')
  })

  it('owns one common local-first asset list without a separate online scroller', async () => {
    api.searchTemplates.mockResolvedValue([imageTemplate(21, 'Readable online')])
    const app = mount({
      children: <button className="visual-asset" data-local-asset="true">Local Cat</button>
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()

    const list = app.querySelector('.asset-list')
    if (!(list instanceof HTMLDivElement)) throw new Error('shared asset list missing')
    expect(app.querySelectorAll('.asset-list')).toHaveLength(1)
    expect(list.firstElementChild?.getAttribute('data-local-asset')).toBe('true')
    expect(list.querySelector('[data-template-id="21"]')).not.toBeNull()
    expect(app.querySelector('.online-template-results')).toBeNull()
    expect(app.querySelector('h3')).toBeNull()
    expect(app.querySelector('.online-template-source')).toBeNull()
    expect(importButton(app, '21').classList.contains('visual-asset')).toBe(true)
    expect(importButton(app, '21').title).toContain('Online · Imgflip')
  })

  it('retries a failed provider without losing local children', async () => {
    let firstSearch = true
    api.searchTemplates.mockImplementation((source: TemplateSource) => {
      if (source === 'memefact' && firstSearch) {
        firstSearch = false
        return Promise.reject(new Error('HF offline'))
      }
      return Promise.resolve([])
    })
    const app = mount({
      projectId: 'project-a',
      children: <button className="visual-asset" data-local-asset="true">Local Cat</button>
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    expect(app.textContent).toContain('MemeFact · HF unavailable. HF offline')
    expect(app.textContent).not.toContain('No online templates found.')
    const retry = app.querySelector('.online-template-retry')
    if (!(retry instanceof HTMLButtonElement)) throw new Error('retry button missing')

    api.searchTemplates.mockResolvedValue([imageTemplate(31, 'Recovered')])
    act(() => { retry.click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    expect(importButton(app, '31').textContent).toContain('Recovered')
    expect(app.querySelector('[data-local-asset="true"]')).not.toBeNull()
    expect(api.searchTemplates).toHaveBeenCalledTimes(6)
  })

  it('disables retry while a template import is pending', async () => {
    let firstSearch = true
    api.searchTemplates.mockImplementation((source: TemplateSource) => {
      if (source === 'memefact' && firstSearch) {
        firstSearch = false
        return Promise.reject(new Error('HF offline'))
      }
      return Promise.resolve([imageTemplate(32, 'Import while retry')])
    })
    const app = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    const retry = app.querySelector('.online-template-retry')
    if (!(retry instanceof HTMLButtonElement)) throw new Error('retry button missing')
    const pending = deferred<AssetItem>()
    api.importTemplate.mockReturnValue(pending.promise)
    act(() => { importButton(app, '32').click() })
    expect(retry.disabled).toBe(true)
    act(() => { retry.click() })
    expect(api.searchTemplates).toHaveBeenCalledTimes(3)
    pending.resolve(imageAsset)
    await flush()
    expect(retry.disabled).toBe(false)
  })

  it('shows Adding, imports once, and reports a failed import without disabling future attempts', async () => {
    api.searchTemplates.mockResolvedValue([imageTemplate(4)])
    const onAsset = vi.fn()
    const onError = vi.fn()
    const app = mount({ onAsset, onError })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()

    const first = deferred<AssetItem>()
    api.importTemplate.mockReturnValueOnce(first.promise)
    act(() => { importButton(app, '4').click() })
    expect(importButton(app, '4').disabled).toBe(true)
    expect(importButton(app, '4').textContent).toContain('Adding…')
    act(() => { importButton(app, '4').click() })
    expect(api.importTemplate).toHaveBeenCalledOnce()
    first.resolve(imageAsset)
    await flush()
    expect(onAsset).toHaveBeenCalledOnce()
    expect(onAsset).toHaveBeenCalledWith(imageAsset)

    api.importTemplate.mockRejectedValueOnce(new Error('download failed'))
    act(() => { importButton(app, '4').click() })
    await flush()
    expect(onError).toHaveBeenCalledWith('Could not add template. download failed')
    expect(importButton(app, '4').disabled).toBe(false)
  })

  it('ignores completed imports when the project changes or the component unmounts', async () => {
    api.searchTemplates.mockResolvedValue([imageTemplate(5)])
    const onAsset = vi.fn()
    const app = mount({ onAsset })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    const pending = deferred<AssetItem>()
    api.importTemplate.mockReturnValue(pending.promise)
    act(() => { importButton(app, '5').click() })
    rerender({ projectId: 'project-b' })
    pending.resolve(imageAsset)
    await flush()
    expect(onAsset).not.toHaveBeenCalled()

    api.searchTemplates.mockResolvedValue([imageTemplate(6)])
    rerender({ projectId: 'project-b' })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    const secondPending = deferred<AssetItem>()
    api.importTemplate.mockReturnValue(secondPending.promise)
    act(() => { importButton(app, '6').click() })
    act(() => {
      root?.unmount()
      root = undefined
    })
    secondPending.resolve(imageAsset)
    await flush()
    expect(onAsset).not.toHaveBeenCalled()
  })

  it('uses the validated fixed-page API for the separate Imgflip source action', async () => {
    api.searchTemplates.mockResolvedValue([imageTemplate(11, 'Linkable')])
    const app = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    const link = sourceLink(app, 'Linkable')
    expect(link.querySelector('svg')).not.toBeNull()
    act(() => { link.click() })
    await flush()
    expect(api.openTemplatePage).toHaveBeenCalledWith('imgflip', '11')
    expect(api.importTemplate).not.toHaveBeenCalled()
  })

  it('keeps an IMKG numeric-looking ID distinct and passes its source to actions', async () => {
    api.searchTemplates.mockImplementation((source: TemplateSource) => {
      if (source === 'memefact') return Promise.resolve([{ id: '7', source, name: 'Blank Cat', type: 'image', url: 'https://i.imgflip.com/7.jpg' }])
      if (source === 'imgflip') return Promise.resolve([{ id: '007', source, name: 'Duplicate Blank', type: 'image', url: 'https://i.imgflip.com/007.jpg' }])
      return Promise.resolve([{ id: '007', source, name: 'IMKG Cat', type: 'image', url: 'https://i.imgflip.com/007-imkg.jpg' }])
    })
    const app = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()

    expect(app.querySelectorAll('[data-template-id]')).toHaveLength(2)
    const imkgButton = importButton(app, '007')
    expect(imkgButton.dataset.templateSource).toBe('imkg')
    expect(imkgButton.title).toContain('Online · IMKG')
    const imkgLink = Array.from(app.querySelectorAll<HTMLButtonElement>('.online-template-link'))
      .find((link) => link.getAttribute('aria-label') === 'View source for IMKG Cat')
    if (!imkgLink) throw new Error('IMKG source link missing')
    act(() => { imkgLink.click() })
    expect(api.openTemplatePage).toHaveBeenCalledWith('imkg', '007')
    act(() => { imkgButton.click() })
    await flush()
    expect(api.importTemplate).toHaveBeenCalledWith('imkg', '007')
  })

  it('shows one allowed preview for hover or focus and releases it on leave', async () => {
    api.searchTemplates.mockResolvedValue([videoTemplate(12)])
    const app = mount({ category: 'video' })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    const button = importButton(app, '12')
    act(() => { mouseOver(button) })
    const video = app.querySelector('.online-template-preview video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('online preview video missing')
    const pause = vi.spyOn(video, 'pause')
    expect(video.getAttribute('src')).toBe('https://i.imgflip.com/12.mp4')
    expect(video.muted).toBe(true)
    expect(video.loop).toBe(true)
    expect(app.querySelectorAll('.online-template-preview video, .online-template-preview img')).toHaveLength(1)

    act(() => { mouseOut(button) })
    expect(pause).toHaveBeenCalled()
    expect(app.querySelector('.online-template-preview')).toBeNull()

    act(() => { button.focus() })
    expect(app.querySelector('.online-template-preview video')).not.toBeNull()
    act(() => { button.blur() })
    expect(app.querySelector('.online-template-preview')).toBeNull()
  })

  it('retains the same video when focus replaces hover ownership', async () => {
    api.searchTemplates.mockResolvedValue([videoTemplate(14, 'Retained')])
    const app = mount({ category: 'video' })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    const button = importButton(app, '14')
    act(() => { mouseOver(button) })
    const video = app.querySelector('.online-template-preview video')
    if (!(video instanceof HTMLVideoElement)) throw new Error('online preview video missing')
    const pause = vi.spyOn(video, 'pause')
    const load = vi.spyOn(video, 'load')
    pause.mockClear()
    load.mockClear()

    act(() => { button.focus() })
    act(() => { mouseOut(button) })
    expect(app.querySelector('.online-template-preview video')).toBe(video)
    expect(video.getAttribute('src')).toBe('https://i.imgflip.com/14.mp4')
    expect(pause).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  })

  it('tracks and releases a new video when the preview changes from A to B', async () => {
    api.searchTemplates.mockResolvedValue([videoTemplate(15, 'Video A'), videoTemplate(16, 'Video B')])
    const app = mount({ category: 'video' })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    const first = importButton(app, '15')
    const second = importButton(app, '16')
    act(() => { mouseOver(first) })
    const firstVideo = app.querySelector('.online-template-preview video')
    if (!(firstVideo instanceof HTMLVideoElement)) throw new Error('first preview video missing')
    act(() => { mouseOut(first, second) })
    act(() => { mouseOver(second, first) })
    const secondVideo = app.querySelector('.online-template-preview video')
    if (!(secondVideo instanceof HTMLVideoElement)) throw new Error('second preview video missing')
    const pause = vi.spyOn(secondVideo, 'pause')
    expect(secondVideo).not.toBe(firstVideo)
    expect(secondVideo.getAttribute('src')).toBe('https://i.imgflip.com/16.mp4')

    act(() => { mouseOut(second) })
    expect(pause).toHaveBeenCalled()
    expect(secondVideo.getAttribute('src')).toBeNull()
  })

  it('does not load an unapproved preview origin', async () => {
    api.searchTemplates.mockResolvedValue([{
      id: '13', source: 'imgflip', name: 'Unsafe', type: 'image', url: 'https://evil.example/unsafe.jpg'
    } satisfies OnlineTemplate])
    const app = mount({ category: 'video' })
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()
    act(() => { mouseOver(importButton(app, '13')) })
    expect(app.querySelector('.online-template-preview img')).toBeNull()
    expect(app.textContent).toContain('Preview unavailable.')
  })
})
