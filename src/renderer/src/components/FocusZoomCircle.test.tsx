import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FocusZoomEffect } from '@shared/types'
import { FocusZoomCircle } from './FocusZoomCircle'

const output = { width: 320, height: 180, fit: 'contain' as const }
const circle: FocusZoomEffect = {
  id: 'circle', start: 0, duration: 2, transitionDuration: 0.5, mode: 'circle', zoom: 2, focusX: 0.5, focusY: 0.5
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function mount(outputTime = 1, effect: FocusZoomEffect = circle): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<FocusZoomCircle effects={[effect]} outputTime={outputTime} canvas={output} />) })
  return container
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

describe('FocusZoomCircle', () => {
  it('renders only an output-sized red and black SVG outline', () => {
    const app = mount()
    const svg = app.querySelector<SVGSVGElement>('svg.focus-zoom-circle')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('viewBox')).toBe('0 0 320 180')
    expect(svg?.querySelectorAll('circle')).toHaveLength(2)
    expect(app.querySelector('canvas')).toBeNull()
    expect(app.querySelector('video')).toBeNull()
    expect(svg?.querySelector('image')).toBeNull()

    const strokes = [...(svg?.querySelectorAll('circle') ?? [])]
    expect(strokes.map((item) => item.getAttribute('stroke'))).toEqual(['#000', '#ff0000'])
    expect(strokes.map((item) => item.getAttribute('stroke-linecap'))).toEqual(['butt', 'butt'])
    expect(strokes[0]?.getAttribute('transform')).toContain('rotate(-90')
    expect(strokes[1]?.getAttribute('transform')).toContain('rotate(-90')
    expect(svg?.style.opacity).toBe('1')
  })

  it('draws clockwise from an invisible start through a smooth endpoint', () => {
    const app = mount(0)
    const readOutline = (): { offset: number; length: number } => {
      const outline = app.querySelectorAll('circle')[1]
      if (!outline) throw new Error('circle outline missing')
      return { offset: Number(outline.getAttribute('stroke-dashoffset')), length: Number(outline.getAttribute('stroke-dasharray')) }
    }
    const start = readOutline()
    expect(start.offset).toBeCloseTo(start.length)
    expect(app.querySelector<SVGSVGElement>('svg')?.style.opacity).toBe('0')

    act(() => { root?.render(<FocusZoomCircle effects={[circle]} outputTime={0.25} canvas={output} />) })
    const middle = readOutline()
    expect(middle.offset).toBeGreaterThan(0)
    expect(middle.offset).toBeLessThan(start.offset)
    expect(app.querySelector<SVGSVGElement>('svg')?.style.opacity).toBe('0.5')

    act(() => { root?.render(<FocusZoomCircle effects={[circle]} outputTime={0.5} canvas={output} />) })
    expect(readOutline().offset).toBeCloseTo(0)
    expect(app.querySelector<SVGSVGElement>('svg')?.style.opacity).toBe('1')
  })

  it('uses the configured transition duration for the outline draw', () => {
    const effect = { ...circle, transitionDuration: 1 }
    const app = mount(0.5, effect)
    const outline = app.querySelectorAll('circle')[1]
    const offset = Number(outline?.getAttribute('stroke-dashoffset'))
    const length = Number(outline?.getAttribute('stroke-dasharray'))
    expect(offset).toBeCloseTo(length / 2)
  })

  it('shrinks the highlight with zoom while keeping its focus center and source-free SVG', () => {
    const app = mount(1, { ...circle, zoom: 2 })
    const readOutline = (): { cx: number; cy: number; radius: number; dash: number; fills: string[] } => {
      const svg = app.querySelector<SVGSVGElement>('svg.focus-zoom-circle')
      if (!svg) throw new Error('circle SVG missing')
      const circles = [...svg.querySelectorAll('circle')]
      const outline = circles[1]
      if (!outline) throw new Error('circle outline missing')
      return {
        cx: Number(outline.getAttribute('cx')),
        cy: Number(outline.getAttribute('cy')),
        radius: Number(outline.getAttribute('r')),
        dash: Number(outline.getAttribute('stroke-dasharray')),
        fills: circles.map((item) => item.getAttribute('fill') ?? '')
      }
    }
    const zoom2 = readOutline()
    expect(app.querySelector('image')).toBeNull()
    expect(app.querySelector('video')).toBeNull()
    expect(app.querySelector('canvas')).toBeNull()

    act(() => { root?.render(<FocusZoomCircle effects={[{ ...circle, zoom: 4 }]} outputTime={1} canvas={output} />) })
    const zoom4 = readOutline()
    expect(zoom4.cx).toBeCloseTo(zoom2.cx, 6)
    expect(zoom4.cy).toBeCloseTo(zoom2.cy, 6)
    expect(zoom4.radius).toBeLessThan(zoom2.radius)
    expect(zoom4.radius / zoom2.radius).toBeCloseTo(0.5, 1)
    expect(zoom4.dash / zoom2.dash).toBeCloseTo(0.5, 1)
    expect(zoom4.fills).toEqual(['none', 'none'])
    expect(app.querySelector('image')).toBeNull()
    expect(app.querySelector('video')).toBeNull()
    expect(app.querySelector('canvas')).toBeNull()
  })

  it('ignores frame-mode effects and times outside the active interval', () => {
    const app = mount(1, { ...circle, mode: 'frame' })
    expect(app.querySelector('svg')).toBeNull()
    for (const outputTime of [-0.01, 2.01]) {
      act(() => { root?.render(<FocusZoomCircle effects={[circle]} outputTime={outputTime} canvas={output} />) })
      expect(app.querySelector('svg')).toBeNull()
    }
  })
})
