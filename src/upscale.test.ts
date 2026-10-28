import { describe, expect, it } from 'vitest'
import { upscalePlan, upscaleRenderRequest, isFlashSpatialSupported } from './upscale'
import type { ExportRequest } from './types'

describe('FlashVSR+ enhancement planning', () => {
  const zoom = { id: 'zoom', start: 2, duration: 3, zoom: 2 as const, focusX: 0.5, focusY: 0.5 }
  const source4k: ExportRequest['sources'][number] = {
    id: '4k', metadata: { path: '/4k.mp4', name: '4k.mp4', size: 1, modifiedAt: 1,
      duration: 40, width: 3840, height: 2160, fps: 60, videoCodec: 'hevc', hasAudio: true }
  }
  const short = { width: 1080, height: 1920, fps: 60, fit: 'cover' as const }
  const clip = { id: 'clip', sourceId: '4k', sourceStart: 0, sourceEnd: 40 }
  const timeline = { sources: [source4k], segments: [clip] }

  it.each([30, 50, 50.426654053916, 59, 59.000001, 59.94, 60, 120])('uses the inclusive 59 fps eligibility rule at %s fps', (fps) => {
    const plan = upscalePlan({ ...short, fps })
    expect(plan.interpolate).toBe(fps <= 59)
    expect(plan.canvas.fps).toBe(fps <= 59 ? 60 : fps)
  })

  it('checks used clips, not the first clip or unused imports, and accounts for slow motion', () => {
    const low = { ...source4k, id: 'low', metadata: { ...source4k.metadata, fps: 30 } }
    const sources = [source4k, low]
    expect(upscalePlan(short, 'turbo', [], { ...timeline, sources }).interpolate).toBe(false)
    const mixed = { sources, segments: [...timeline.segments, { ...clip, id: 'next', sourceId: 'low' }] }
    const plan = upscalePlan(short, 'turbo', [], mixed)
    expect(plan.interpolate).toBe(true)
    expect(plan.canvas.fps).toBe(60)
    expect(plan.interpolationRanges).toEqual([[40, 80]])
    expect(upscalePlan(short, 'turbo', [], { sources: [], segments: [] }).interpolate).toBe(false)
    const slow = { ...timeline, segments: [{ ...clip, playbackRate: 0.5 as const }] }
    expect(upscalePlan(short, 'turbo', [], slow).interpolationRanges).toEqual([[0, 80]])
    const frozen = { ...timeline, segments: [{ ...clip, kind: 'freeze' as const, sourceTime: 0, duration: 2 }] }
    expect(upscalePlan(short, 'turbo', [], frozen).interpolate).toBe(false)
  })

  it.each(['turbo', 'base'] as const)('limits a 4K-source Short to its close-ups in %s mode', (mode) => {
    const plan = upscalePlan(short, mode, [zoom, { ...zoom, start: 9 }], timeline)
    expect(plan).toMatchObject({ spatial: true, spatialRanges: [[2, 5], [9, 12]], mode,
      canvas: { width: 2160, height: 3840, fps: 60 } })
    expect(isFlashSpatialSupported(plan)).toBe(true)
    expect(upscalePlan(short, mode, [], timeline).spatial).toBe(false)
  })

  it('does not upscale an unchanged area highlighted by a circle', () => {
    const circle = { ...zoom, mode: 'circle' as const }
    const native = { width: 3840, height: 2160, fps: 60, fit: 'contain' as const }
    expect(upscalePlan(native, 'turbo', [circle]).spatial).toBe(false)
    expect(upscalePlan(short, 'turbo', [circle], timeline).spatial).toBe(false)
    expect(upscalePlan(native, 'turbo', [circle, zoom]).spatialRanges).toEqual([[2, 5]])
  })

  it('does not mistake a low-resolution inserted clip for 4K footage', () => {
    const low = { ...source4k, id: 'low', metadata: { ...source4k.metadata, width: 1920, height: 1080 } }
    const sources = [source4k, low]
    // An unused imported source must not change the plan.
    expect(upscalePlan(short, 'turbo', [zoom], { ...timeline, sources }).spatialRanges).toEqual([[2, 5]])
    const mixed = { sources, segments: [...timeline.segments, { id: 'low-clip', sourceId: 'low', sourceStart: 0, sourceEnd: 10 }] }
    expect(upscalePlan(short, 'turbo', [zoom], mixed).spatialRanges).toBeUndefined()
    expect(upscalePlan(short, 'turbo', [zoom], mixed).spatial).toBe(true)
    expect(upscalePlan(short, 'turbo', [zoom], { sources, segments: [] }).spatialRanges).toBeUndefined()
    expect(upscalePlan(short, 'turbo', [zoom], { sources: [], segments: timeline.segments }).spatialRanges).toBeUndefined()
  })

  it.each([[3840, 2160], [2160, 3840]])('enhances only close-ups on a native %dx%d timeline', (width, height) => {
    const canvas = { width, height, fps: 60, fit: 'contain' as const }
    const plan = upscalePlan(canvas, 'base', [zoom, { ...zoom, start: 5 }, { ...zoom, start: 9 }])
    expect(plan).toMatchObject({ spatial: true, interpolate: false, mode: 'base', spatialRanges: [[2, 8], [9, 12]] })
    expect(plan.canvas).toEqual(canvas)
    expect(isFlashSpatialSupported(plan)).toBe(true)
    expect(upscalePlan(canvas).spatial).toBe(false)
  })

  it('still enhances the whole video below 4K and never shrinks a larger canvas', () => {
    const below = upscalePlan({ width: 1920, height: 1080, fps: 30, fit: 'contain' }, 'turbo', [zoom])
    expect(below.spatial).toBe(true)
    expect(below.spatialRanges).toBeUndefined()
    const above = upscalePlan({ width: 7680, height: 4320, fps: 60, fit: 'contain' }, 'turbo', [zoom])
    expect(above.spatial).toBe(false)
    expect(above.canvas.width).toBe(7680)
  })

  it('drops empty sub-frame ranges and joins ranges separated by no source frame', () => {
    const canvas = { width: 3840, height: 2160, fps: 60, fit: 'contain' as const }
    expect(upscalePlan(canvas, 'turbo', [{ ...zoom, start: 0.001, duration: 0.001 }]).spatial).toBe(false)
    const plan = upscalePlan(canvas, 'turbo', [{ ...zoom, start: 0, duration: 0.095 }, { ...zoom, start: 0.098, duration: 0.202 }])
    expect(plan.spatialRanges).toEqual([[0, 0.3]])
    expect(isFlashSpatialSupported(upscalePlan({ ...canvas, height: 2880 }, 'turbo', [zoom]))).toBe(false)
  })
  it('defaults spatial work to Turbo without changing the 4K landscape plan', () => {
    const plan = upscalePlan({ width: 1920, height: 1080, fps: 30, fit: 'contain' })
    expect(plan.mode).toBe('turbo')
    expect(plan.spatial).toBe(true)
    expect(plan.canvas).toMatchObject({ width: 3840, height: 2160, fps: 60 })
    expect(isFlashSpatialSupported(plan)).toBe(true)
  })

  it('preserves an explicitly selected Base mode', () => {
    const plan = upscalePlan({ width: 1920, height: 1080, fps: 60, fit: 'contain' }, 'base')
    expect(plan.mode).toBe('base')
    expect(isFlashSpatialSupported(plan)).toBe(true)
  })

  it('enhances the current Short to portrait 4K60 without cropping or stretching it', () => {
    const plan = upscalePlan({ width: 1080, height: 1920, fps: 30.000845094228005, fit: 'cover' }, 'base')
    expect(plan.spatial).toBe(true)
    expect(plan.canvas).toMatchObject({ width: 2160, height: 3840, fps: 60 })
    expect(plan.mode).toBe('base')
    expect(isFlashSpatialSupported(plan)).toBe(true)
  })

  it.each([[1440, 1080], [1920, 800]])('still rejects an unsupported %dx%d spatial aspect ratio', (width, height) => {
    const plan = upscalePlan({ width, height, fps: 30, fit: 'contain' })
    expect(isFlashSpatialSupported(plan)).toBe(false)
  })

  it.each([30, 50.426654053916, 51.06664065180121, 56.88029616158317])('converts %s fps to 60 without spatial upscaling', (fps) => {
    const plan = upscalePlan({ width: 3840, height: 2160, fps, fit: 'contain' })
    expect(plan.spatial).toBe(false)
    expect(plan.interpolate).toBe(true)
    expect(plan.canvas.fps).toBe(60)
  })

  it('renders RIFE-only conversion at 60 fps and marks gaps without changing project state', () => {
    const canvas = { width: 3840, height: 2160, fps: 50.426654053916, fit: 'contain' as const }
    const request = { ...timeline, canvas, outputPath: '/output.mp4' } as ExportRequest
    request.sources = [{ ...source4k, metadata: { ...source4k.metadata, fps: canvas.fps } }]
    const plan = upscalePlan(canvas, 'turbo', [], request)
    expect(plan.interpolationRanges).toEqual([[0, 40]])
    expect(upscaleRenderRequest(request, plan).canvas.fps).toBe(60)
    expect(request.canvas.fps).toBe(canvas.fps)
    // Flash must never upscale 60 images when only 24 original images exist.
    const spatial = upscalePlan({ ...canvas, width: 1920, height: 1080 })
    expect(upscaleRenderRequest(request, spatial)).toBe(request)
    expect(upscaleRenderRequest(request, { ...plan, interpolate: false })).toBe(request)
  })

  it('does not lower a faster canvas when filling a slower inserted clip', () => {
    const canvas = { width: 3840, height: 2160, fps: 120, fit: 'contain' as const }
    const sources = [{ ...source4k, metadata: { ...source4k.metadata, fps: 30 } }]
    const plan = upscalePlan(canvas, 'turbo', [], { ...timeline, sources })
    expect(plan.interpolate).toBe(true)
    expect(plan.canvas.fps).toBe(120)
    expect(plan.interpolationRanges).toEqual([[0, 40]])
  })

  it('does not require Flash geometry for RIFE-only work', () => {
    const plan = upscalePlan({ width: 2160, height: 3840, fps: 30, fit: 'contain' })
    expect(plan.spatial).toBe(false)
    expect(plan.interpolate).toBe(true)
    expect(isFlashSpatialSupported(plan)).toBe(true)
  })
})
