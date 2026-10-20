import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { createSession } from '../model/timeline'
import { Preview } from './Preview'
import { root, metadata, props, mount, sourceVideo } from './preview-test-support'

describe('rendered and Short previews', () => {
  it('shows the full source frame and the animated visible-area guide for Shorts', () => {
    const session = createSession(metadata, true)
    session.playhead = 3
    session.shortFramePoints = [{ id: 'start', time: 1, position: 0.5 }, { id: 'right', time: 3, position: 1 }]
    const app = mount({ session })
    const stage = app.querySelector('.preview-stage')
    const guide = app.querySelector('.short-frame-guide')
    if (!(stage instanceof HTMLDivElement) || !(guide instanceof HTMLDivElement)) throw new Error('Short frame guide missing')
    expect(stage.classList.contains('short-framing')).toBe(true)
    expect(stage.style.aspectRatio).toBe('320 / 180')
    expect(sourceVideo(app).style.objectFit).toBe('contain')
    expect(parseFloat(guide.style.left)).toBeCloseTo(68.359375)
    expect(parseFloat(guide.style.width)).toBeCloseTo(31.640625)
    expect(parseFloat(guide.style.height)).toBe(100)
    act(() => { root?.render(<Preview {...props({ session: { ...session, playhead: 2 } })} />) })
    expect(parseFloat(guide.style.left)).toBeCloseTo(51.26953125)
  })

  it('previews Short zoom inside the fixed framing guide', () => {
    const session = createSession(metadata, true)
    session.playhead = 3
    session.shortFramePoints = [{ id: 'right', time: 0, position: 1 }]
    session.focusZooms = [{ id: 'zoom', start: 1, duration: 5, zoom: 3, focusX: 0.5, focusY: 0.5 }]
    const app = mount({ session })
    const camera = app.querySelector('.camera-layer')
    const guide = app.querySelector('.short-frame-guide')
    if (!(camera instanceof HTMLDivElement) || !(guide instanceof HTMLDivElement)) throw new Error('Short camera missing')
    const guideStyle = guide.getAttribute('style')
    expect(camera.style.transform).toBe('scale(3) translate(-56.119792%, -33.333333%)')
    expect(camera.style.transformOrigin).toBe('top left')
    expect(camera.contains(guide)).toBe(false)

    act(() => { root?.render(<Preview {...props({ session: { ...session, playhead: 1.25 } })} />) })
    expect(camera.style.transform).toContain('scale(2)')
    expect(guide.getAttribute('style')).toBe(guideStyle)
    act(() => { root?.render(<Preview {...props({ session: { ...session, playhead: 7 } })} />) })
    expect(camera.style.transform).toBe('')
    expect(guide.getAttribute('style')).toBe(guideStyle)
  })

  it('uses the rendered range in the same stage without source overlays or audio', () => {
    const session = createSession(metadata)
    session.playhead = 3
    const app = mount({ session, renderedPreview: { url: 'media://rendered', start: 2, end: 5 } })
    expect(app.querySelector('.preview-rendered-video')).not.toBeNull()
    expect(app.querySelector('.preview-source-video:not(.preview-rendered-video)')).toBeNull()
    expect(app.querySelector('.visual-overlay')).toBeNull()
    expect(app.querySelector('audio')).toBeNull()
    expect(app.querySelector('.transport')).not.toBeNull()
  })

  it('retains silent full-frame source footage around a rendered Short and follows framing changes', () => {
    const session = createSession(metadata, true)
    session.playhead = 3
    session.shortFramePoints = [{ id: 'start', time: 2, position: 0.5 }, { id: 'move', time: 4, position: 1 }]
    const rendered = { url: 'media://rendered', start: 2, end: 5 }
    const app = mount({ session, renderedPreview: rendered })
    const backdrop = app.querySelector('.preview-short-backdrop')
    if (!(backdrop instanceof HTMLVideoElement)) throw new Error('Short backdrop missing')
    expect(backdrop.muted).toBe(true)
    expect(backdrop.src).toContain('/source.mp4')
    expect(backdrop.style.objectFit).toBe('contain')
    act(() => { backdrop.dispatchEvent(new Event('loadedmetadata')) })
    expect(backdrop.currentTime).toBeCloseTo(3 + 0.5 / 30)
    const guide = app.querySelector('.short-frame-rendered')
    if (!(guide instanceof HTMLDivElement)) throw new Error('Rendered viewport missing')
    const previousLeft = parseFloat(guide.style.left)
    act(() => { root?.render(<Preview {...props({ session: { ...session, playhead: 3.1 }, renderedPreview: rendered })} />) })
    expect(parseFloat(guide.style.left)).toBeGreaterThan(previousLeft)
    expect(app.querySelector('.visual-overlay')).toBeNull()
  })

  it('returns to source media outside the range and retains a full-project final frame', () => {
    const session = createSession(metadata)
    session.playhead = 3
    const rendered = { url: 'media://rendered', start: 2, end: 5 }
    const app = mount({ session, renderedPreview: rendered })
    expect(app.querySelector('.preview-rendered-video')).not.toBeNull()

    const sourceSession = { ...session, playhead: 1 }
    act(() => { root?.render(<Preview {...props({ session: sourceSession, renderedPreview: rendered })} />) })
    expect(app.querySelector('.preview-rendered-video')).toBeNull()
    expect(app.querySelector('.preview-source-video:not(.preview-rendered-video)')).not.toBeNull()

    const finalSession = { ...session, playhead: 10 }
    const fullRendered = { url: rendered.url, start: 0, end: 10 }
    act(() => { root?.render(<Preview {...props({ session: finalSession, renderedPreview: fullRendered })} />) })
    expect(app.querySelector('.preview-rendered-video')).not.toBeNull()
  })

  it('selects the rendered partial preview containing the current playhead', () => {
    const first = { url: 'media://first-rendered', start: 1, end: 2 }
    const second = { url: 'media://second-rendered', start: 6, end: 7 }
    const session = createSession(metadata)
    session.playhead = 1.5
    const app = mount({ session, renderedPreviews: [first, second] })
    expect(app.querySelector('.preview-rendered-video')?.getAttribute('src')).toContain(first.url)

    const secondSession = { ...session, playhead: 6.5 }
    act(() => { root?.render(<Preview {...props({ session: secondSession, renderedPreviews: [first, second] })} />) })
    expect(app.querySelector('.preview-rendered-video')?.getAttribute('src')).toContain(second.url)
  })

})
