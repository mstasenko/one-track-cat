import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetItem, FaceBlurEffect, MediaMetadata } from '@shared/types'
import { createSession } from '../model/timeline'
import { insertFreezeFrame } from '../model/freeze'
import { insertReplay } from '../model/replay'
import { AssetPanel } from './AssetPanel'

vi.mock('./useMediaUrl', () => ({
  useMediaUrl: (path: string | null | undefined) => path ? `media:${path}` : null
}))

const { onlineTemplateProps } = vi.hoisted(() => ({
  onlineTemplateProps: { current: undefined as Record<string, unknown> | undefined }
}))

vi.mock('./OnlineTemplates', () => ({
  OnlineTemplates: (props: Record<string, unknown>) => {
    onlineTemplateProps.current = props
    return <div className="online-templates"><div className="asset-list">{props.children as ReactNode}</div></div>
  }
}))

const metadata: MediaMetadata = {
  path: '/source.mp4', name: 'source.mp4', size: 1, modifiedAt: 1, duration: 10,
  width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: true
}

const assets: AssetItem[] = [
  { type: 'image', name: 'cat.png', path: '/cat.png' },
  { type: 'video', name: 'clip.mp4', path: '/clip.mp4' },
  { type: 'gif', name: 'loop.gif', path: '/loop.gif' },
  { type: 'audio', name: 'music.ogg', path: '/music.ogg' }
]

type Props = Parameters<typeof AssetPanel>[0]

let root: Root | undefined
let container: HTMLDivElement | undefined

function defaultProps(overrides: Partial<Props> = {}): Props {
  return {
    assets,
    session: createSession(metadata),
    category: null,
    onCategory: vi.fn(),
    onText: vi.fn(),
    onNew: vi.fn(),
    onInsert: vi.fn(),
    onAsset: vi.fn(),
    onError: vi.fn(),
    onSpeed: vi.fn(),
    onFocusPick: vi.fn(),
    onRemoveFocusZoom: vi.fn(),
    onFreeze: vi.fn(),
    onRemoveFreeze: vi.fn(),
    onReplay: vi.fn(),
    onRemoveReplay: vi.fn(),
    faceBlurs: [],
    selectedFaceBlur: null,
    onSelectFaceBlur: vi.fn(),
    onApplyFaceBlur: vi.fn(),
    onRemoveFaceBlur: vi.fn(),
    ...overrides
  }
}

function mount(overrides: Partial<Props> = {}): HTMLDivElement {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<AssetPanel {...defaultProps(overrides)} />) })
  return container
}

function button(app: HTMLDivElement, name: string | RegExp): HTMLButtonElement {
  const result = [...app.querySelectorAll('button')].find((candidate) => {
    const text = candidate.getAttribute('aria-label') ?? candidate.textContent
    return typeof name === 'string' ? text === name : name.test(text)
  })
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Button ${String(name)} missing`)
  return result
}

function selectValue(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  onlineTemplateProps.current = undefined
  Object.defineProperty(window, 'otc', {
    configurable: true,
    value: {
      getPathUrl: vi.fn((path: string) => Promise.resolve(`media:${path}`)),
      facePackStatus: vi.fn().mockResolvedValue({ available: true, message: 'ready' })
    }
  })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('asset panel', () => {
  it('exposes insert, media, and effect actions from the add menu', () => {
    const onText = vi.fn()
    const onNew = vi.fn()
    const onCategory = vi.fn()
    const onReplay = vi.fn()
    const onInsert = vi.fn()
    const app = mount({ onText, onNew, onCategory, onReplay, onInsert })
    expect([...app.querySelectorAll('.effect-add button')].map((candidate) => candidate.textContent)).toEqual([
      'Speed', 'Replay', 'Zoom', 'Freeze', 'Transition', 'Blur faces'
    ])

    act(() => { button(app, 'Text').click() })
    act(() => { button(app, 'New').click() })
    expect(onText).toHaveBeenCalledOnce()
    expect(onNew).toHaveBeenCalledOnce()

    act(() => { button(app, 'Images').click() })
    expect(onCategory).toHaveBeenCalledWith('image')
    act(() => { button(app, 'Video').click() })
    expect(app.textContent).toContain('Insert video')
    act(() => { button(app, /Back/).click() })
    expect(app.textContent).toContain('Insert')

    expect(button(app, 'Speed').disabled).toBe(true)
    expect(button(app, 'Zoom').disabled).toBe(true)
    expect(button(app, 'Replay').disabled).toBe(true)
    expect(app.textContent).toContain('Add marks around a moment first.')
    expect(onInsert).not.toHaveBeenCalled()
    expect(onReplay).not.toHaveBeenCalled()
  })

  it('configures insertion transitions and reports the chosen values', () => {
    const onInsert = vi.fn()
    const app = mount({ onInsert })
    act(() => { button(app, 'Video').click() })
    const selects = [...app.querySelectorAll('select')]
    expect(selects).toHaveLength(3)
    const into = selects[0]
    const back = selects[1]
    const duration = selects[2]
    if (!into || !back || !duration) throw new Error('transition controls missing')
    selectValue(into, 'fade')
    selectValue(back, 'wipeleft')
    selectValue(duration, '1')
    expect(duration.disabled).toBe(false)
    act(() => { button(app, 'Select video').click() })
    expect(onInsert).toHaveBeenCalledWith({
      into: { effect: 'fade', duration: 1 },
      back: { effect: 'wipeleft', duration: 1 }
    })
  })

  it('configures an In video range transition with the full range duration', () => {
    const onVideoTransition = vi.fn()
    const app = mount({ onVideoTransition })

    act(() => { button(app, 'Transition').click() })
    expect(app.textContent).toContain('Video transition')
    const selects = [...app.querySelectorAll('select')]
    expect(selects).toHaveLength(2)
    const effect = selects[0]
    const direction = selects[1]
    if (!effect || !direction) throw new Error('video transition controls missing')
    expect(direction.value).toBe('in')
    expect([...direction.options].map((option) => option.value)).toEqual(['in', 'out'])
    selectValue(effect, 'dissolve')

    act(() => { button(app, 'Apply transition').click() })
    expect(onVideoTransition).toHaveBeenCalledWith(
      { effect: 'dissolve', duration: 10 },
      undefined
    )
  })

  it('uses the selected range for an Out transition', () => {
    const session = createSession(metadata)
    session.marks = [2, 6]
    session.playhead = 3
    const onVideoTransition = vi.fn()
    const app = mount({ session, onVideoTransition })

    act(() => { button(app, 'Transition').click() })
    const selects = [...app.querySelectorAll('select')]
    const effect = selects[0]
    const direction = selects[1]
    if (!effect || !direction) throw new Error('video transition controls missing')
    selectValue(direction, 'out')
    act(() => { button(app, 'Apply transition').click() })

    expect(onVideoTransition).toHaveBeenCalledWith(
      undefined,
      { effect: 'fade', duration: 4 }
    )
  })

  it('handles speed, zoom, freeze, and replay controls for a selected range', () => {
    const session = createSession(metadata)
    session.marks = [2, 6]
    session.playhead = 3
    session.focusZooms = [{ id: 'zoom', start: 2, duration: 4, zoom: 2, focusX: 0.5, focusY: 0.5 }]
    const onSpeed = vi.fn()
    const onFocusPick = vi.fn()
    const onRemoveFocusZoom = vi.fn()
    const onFreeze = vi.fn()
    const app = mount({ session, onSpeed, onFocusPick, onRemoveFocusZoom, onFreeze })

    act(() => { button(app, 'Speed').click() })
    expect(app.textContent).toContain('Changes the highlighted video moment.')
    act(() => { button(app, '½×').click() })
    expect(onSpeed).toHaveBeenCalledWith(0.5)
    act(() => { button(app, /Back/).click() })

    act(() => { button(app, 'Zoom').click() })
    act(() => { button(app, '2×').click() })
    expect(onFocusPick).toHaveBeenCalledWith(2)
    expect(button(app, 'Remove zoom').disabled).toBe(false)
    act(() => { button(app, 'Remove zoom').click() })
    expect(onRemoveFocusZoom).toHaveBeenCalledOnce()
    act(() => { button(app, /Back/).click() })

    act(() => { button(app, 'Freeze').click() })
    expect(button(app, '1s').disabled).toBe(false)
    act(() => { button(app, '1s').click() })
    expect(onFreeze).toHaveBeenCalledWith(1)
  })

  it('keeps Replay add-only after a replay is inserted', () => {
    const selected = createSession(metadata)
    selected.marks = [2, 4]
    selected.playhead = 3
    const session = insertReplay(selected, 2, 4)
    const onReplay = vi.fn()
    const onRemoveReplay = vi.fn()
    const app = mount({ session, onReplay, onRemoveReplay })

    const replay = button(app, 'Replay')
    expect(replay.disabled).toBe(true)
    expect(replay.title).toBe('Use Undo to remove this Replay')
    act(() => { replay.click() })
    expect(onReplay).not.toHaveBeenCalled()
    expect(onRemoveReplay).not.toHaveBeenCalled()
  })

  it('enables Replay for a long selection and reports the insertion', () => {
    const session = createSession({ ...metadata, duration: 20 })
    session.marks = [0, 20]
    session.playhead = 10
    const onReplay = vi.fn()
    const app = mount({ session, onReplay })

    const replay = button(app, 'Replay')
    expect(replay.disabled).toBe(false)
    act(() => { replay.click() })
    expect(onReplay).toHaveBeenCalledOnce()
  })

  it('keeps Replay disabled without a message at a transition boundary', () => {
    const session = createSession(metadata)
    const sourceId = session.segments[0]?.sourceId
    if (!sourceId) throw new Error('source segment missing')
    session.segments = [
      { id: 'first', sourceId, sourceStart: 0, sourceEnd: 5 },
      { id: 'second', sourceId, sourceStart: 5, sourceEnd: 10, transition: { effect: 'fade', duration: 1 } }
    ]
    session.marks = [5.5, 8]
    session.playhead = 6.5
    const app = mount({ session })

    expect(button(app, 'Replay').disabled).toBe(true)
    expect(app.querySelector('.empty-note')).toBeNull()
  })

  it('disables speed on a freeze and freeze during a transition', () => {
    const frozen = insertFreezeFrame(createSession(metadata), 3, 1)
    frozen.marks = [3.1, 3.9]
    frozen.playhead = 3.5
    const speedPanel = mount({ session: frozen })
    act(() => { button(speedPanel, 'Speed').click() })
    expect(speedPanel.textContent).toContain('Speed does not change a freeze frame.')
    expect(button(speedPanel, '½×').disabled).toBe(true)

    const frozenEffectPanel = mount({ session: frozen })
    act(() => { button(frozenEffectPanel, 'Freeze').click() })
    expect(frozenEffectPanel.textContent).toContain('Use Undo to remove this freeze.')
    expect(frozenEffectPanel.textContent).not.toContain('Remove freeze')
    for (const duration of ['0.5s', '1s', '2s', '3s', '4s', '5s']) {
      expect(button(frozenEffectPanel, duration).disabled).toBe(true)
    }

    const transitioned = createSession(metadata)
    const sourceId = transitioned.segments[0]?.sourceId
    if (!sourceId) throw new Error('source segment missing')
    transitioned.segments = [
      { id: 'first', sourceId, sourceStart: 0, sourceEnd: 5 },
      { id: 'second', sourceId, sourceStart: 5, sourceEnd: 10, transition: { effect: 'fade', duration: 1 } }
    ]
    transitioned.playhead = 5.5
    const freezePanel = mount({ session: transitioned })
    act(() => { button(freezePanel, 'Freeze').click() })
    expect(freezePanel.textContent).toContain('Move the playhead outside the transition')
    expect(button(freezePanel, '1s').disabled).toBe(true)
  })

  it('opens the face blur editor and returns to the add menu', async () => {
    const onSelectFaceBlur = vi.fn()
    const app = mount({ onSelectFaceBlur })
    act(() => { button(app, 'Blur faces').click() })
    await vi.waitFor(() => expect(button(app, 'Apply face blur').disabled).toBe(false))
    expect(app.textContent).toContain('Apply to entire video')
    act(() => { button(app, /Back/).click() })
    expect(app.textContent).toContain('Effects')
    expect(onSelectFaceBlur).not.toHaveBeenCalled()
  })

  it('shows selected face settings and lets the user leave that panel', () => {
    const selected: FaceBlurEffect = {
      id: 'face', start: 2, duration: 3, sensitivity: 0.7, detail: 'standard',
      holdSeconds: 0.3, strength: 0.7, style: 'pixelate'
    }
    const onSelectFaceBlur = vi.fn()
    const app = mount({ selectedFaceBlur: selected, faceBlurs: [selected], onSelectFaceBlur })
    expect(app.textContent).toContain('Apply to selected range.')
    act(() => { button(app, /Back/).click() })
    expect(onSelectFaceBlur).toHaveBeenCalledWith(null)
  })

  it('filters category assets, previews visual media, and selects assets', () => {
    const onAsset = vi.fn()
    const onCategory = vi.fn()
    const imagePanel = mount({ category: 'image', onAsset, onCategory })
    const visual = imagePanel.querySelector('.visual-asset')
    if (!(visual instanceof HTMLButtonElement)) throw new Error('image asset missing')
    act(() => { visual.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(imagePanel.querySelector('.asset-hover-card img')).not.toBeNull()
    act(() => { visual.click() })
    expect(onAsset).toHaveBeenCalledWith(assets[0])
    act(() => { button(imagePanel, /Back/).click() })
    expect(onCategory).toHaveBeenCalledWith(null)

    const videoPanel = mount({ category: 'video' })
    expect(videoPanel.querySelectorAll('.visual-asset')).toHaveLength(2)
    const video = videoPanel.querySelector('.visual-asset')
    if (!(video instanceof HTMLButtonElement)) throw new Error('video asset missing')
    act(() => { video.focus() })
    expect(videoPanel.querySelector('.asset-hover-card video')).not.toBeNull()
    act(() => { video.blur() })

    const emptyPanel = mount({ category: 'video', assets: [] })
    expect(emptyPanel.textContent).toContain('No media here.')
  })

  it('passes online template category, query, and project context for every media category', () => {
    const session = createSession(metadata)
    const source = session.sources[0]
    if (!source) throw new Error('source missing')
    source.id = 'project-source'
    const app = mount({ session, category: 'image' })
    const search = app.querySelector('.asset-search')
    if (!(search instanceof HTMLInputElement)) throw new Error('asset search missing')

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(search)
    act(() => {
      setter?.('cat')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const forwarded = onlineTemplateProps.current
    if (!forwarded) throw new Error('online template props missing')
    expect(forwarded).toMatchObject({ category: 'image', query: 'cat', projectId: 'project-source' })
    expect(typeof forwarded.onAsset).toBe('function')
    expect(typeof forwarded.onError).toBe('function')
    expect(forwarded.children).toBeTruthy()
    expect(app.querySelectorAll('.asset-list')).toHaveLength(1)

    const audioPanel = mount({ session, category: 'audio' })
    const audioForwarded = onlineTemplateProps.current
    if (!audioForwarded) throw new Error('audio online template props missing')
    expect(audioForwarded).toMatchObject({ category: 'audio', query: '', projectId: 'project-source' })
    expect(audioPanel.querySelectorAll('.asset-list')).toHaveLength(1)
  })

  it('previews audio and reports a failed media URL', async () => {
    const onError = vi.fn()
    const app = mount({ category: 'audio', onError })
    const preview = button(app, 'Play music.ogg')
    await act(async () => { preview.click(); await Promise.resolve() })
    await vi.waitFor(() => expect(button(app, 'Pause music.ogg')).toBeTruthy())
    await act(async () => { button(app, 'Pause music.ogg').click(); await Promise.resolve() })

    vi.mocked(window.otc.getPathUrl).mockRejectedValueOnce(new Error('missing'))
    await act(async () => { button(app, 'Play music.ogg').click(); await Promise.resolve() })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('OneTrackCat could not preview this audio.'))
  })
})
