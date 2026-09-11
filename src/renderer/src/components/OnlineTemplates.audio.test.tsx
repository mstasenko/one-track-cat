import { act } from 'react'
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

const audioAsset: AssetItem = { type: 'audio', name: 'added.ogg', path: '/cache/added.ogg' }
const audioTemplate = (id: number, name = `Audio ${id}`): OnlineTemplate => ({
  id: String(id), source: 'wikimedia', name, type: 'audio', url: `https://upload.wikimedia.org/wikipedia/commons/a/b/${id}.ogg`
})

let api: Api
let root: Root | undefined
let container: HTMLDivElement | undefined
let originalLoad: PropertyDescriptor | undefined

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<OnlineTemplates
      category="audio"
      query="cat"
      projectId="project-a"
      onAsset={vi.fn()}
      onError={vi.fn()}
    />)
  })
  return container
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

function mouseOver(target: HTMLElement, relatedTarget: EventTarget | null = null): void {
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget }))
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  api = {
    searchTemplates: vi.fn<(source: TemplateSource, category: TemplateCategory, query: string) => Promise<OnlineTemplate[]>>().mockResolvedValue([]),
    importTemplate: vi.fn<(source: TemplateSource, id: string) => Promise<AssetItem>>().mockResolvedValue(audioAsset),
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
  it('searches Wikimedia only for audio and previews/imports audio results', async () => {
    api.searchTemplates.mockImplementation((source: TemplateSource) =>
      source === 'wikimedia' ? Promise.resolve([audioTemplate(17)]) : Promise.resolve([]))
    api.importTemplate.mockResolvedValue(audioAsset)
    const app = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await flush()

    expect(api.searchTemplates).toHaveBeenCalledOnce()
    expect(api.searchTemplates).toHaveBeenCalledWith('wikimedia', 'audio', 'cat')
    const result = importButton(app, '17')
    expect(result.dataset.templateSource).toBe('wikimedia')
    expect(result.title).toContain('Online · Wikimedia Commons')
    const link = app.querySelector('.online-template-link')
    if (!(link instanceof HTMLButtonElement)) throw new Error('Wikimedia source link missing')
    expect(link.getAttribute('aria-label')).toBe('View source for Audio 17')

    act(() => { mouseOver(result) })
    const preview = app.querySelector('.online-template-preview audio')
    if (!(preview instanceof HTMLAudioElement)) throw new Error('online preview audio missing')
    expect(preview.autoplay).toBe(true)
    expect(preview.loop).toBe(true)
    expect(preview.controls).toBe(true)
    expect(app.querySelector('.online-template-preview img')).toBeNull()

    act(() => { link.click() })
    expect(api.openTemplatePage).toHaveBeenCalledWith('wikimedia', '17')
    act(() => { result.click() })
    await flush()
    expect(api.importTemplate).toHaveBeenCalledWith('wikimedia', '17')
  })
})
