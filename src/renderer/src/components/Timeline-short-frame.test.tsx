import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession } from '../model/timeline'
import { Timeline } from './Timeline'

vi.mock('./useMediaUrl', () => ({ useMediaUrl: () => '' }))

const metadata = {
  path: '/video.mp4', name: 'video.mp4', size: 1, modifiedAt: 1, duration: 10,
  width: 1920, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: true
}
type Props = Parameters<typeof Timeline>[0]
let root: Root | undefined
let container: HTMLDivElement | undefined

function mount(session: Props['session'], overrides: Partial<Props> = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<Timeline
    session={session} zoom={1} onZoom={vi.fn()} onSeek={vi.fn()}
    onSelectOverlay={vi.fn()} selectedFaceBlurId={null} onSelectFaceBlur={vi.fn()}
    onOverlayChange={vi.fn()} onOverlayGestureStart={vi.fn()}
    onOverlayGestureEnd={vi.fn()} onOverlayGestureCancel={vi.fn()}
    {...overrides}
  />) })
  return container
}

beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }) })
afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

describe('Short framing timeline', () => {
  it('uses framing at the playhead for arrow limits, not the global starting position', () => {
    const session = createSession(metadata, true)
    session.playhead = 5
    session.shortFramePoints = [{ id: 'left', time: 5, position: 0 }]
    const onNudgeFrame = vi.fn()
    const app = mount(session, { onNudgeFrame })
    const left = app.querySelector<HTMLButtonElement>('[aria-label="Move frame left"]')
    const right = app.querySelector<HTMLButtonElement>('[aria-label="Move frame right"]')
    if (!left || !right) throw new Error('Short framing controls missing')
    expect(left.disabled).toBe(true)
    expect(right.disabled).toBe(false)
    act(() => { right.click() })
    expect(onNudgeFrame).toHaveBeenCalledWith('right')
  })

  it('shows individually seekable framing points without changing the timeline selection', () => {
    const session = createSession(metadata, true)
    session.shortFramePoints = [{ id: 'a', time: 2, position: 0.2 }, { id: 'b', time: 8, position: 0.8 }]
    const onSeek = vi.fn()
    const app = mount(session, { onSeek })
    const points = app.querySelectorAll<HTMLButtonElement>('.short-frame-point')
    expect(points).toHaveLength(2)
    const first = points[0]
    const last = points[1]
    if (!first || !last) throw new Error('Short framing points missing')
    expect(first.style.left).toBe('20%')
    expect(last.style.left).toBe('80%')
    act(() => { last.click() })
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(8)
  })

  it('hides the framing controls for landscape projects', () => {
    const app = mount(createSession(metadata))
    expect(app.querySelector('.short-frame-controls')).toBeNull()
    expect(app.querySelector('.short-frame-point')).toBeNull()
  })
})
