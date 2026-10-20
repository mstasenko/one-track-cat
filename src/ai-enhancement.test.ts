import { describe, expect, it } from 'vitest'
import { aiEnhancementPlan, isFlashSpatialSupported } from './ai-enhancement'
import type { ExportRequest } from './types'

describe('FlashVSR+ enhancement planning', () => {
  const zoom = { id: 'zoom', start: 2, duration: 3, zoom: 2 as const, focusX: 0.5, focusY: 0.5 }
  const source4k: ExportRequest['sources'][number] = {
    id: '4k', metadata: { path: '/4k.mp4', name: '4k.mp4', size: 1, modifiedAt: 1,
      duration: 40, width: 3840, height: 2160, fps: 60, videoCodec: 'hevc', hasAudio: true }
  }
  const short = { width: 1080, height: 1920, fps: 60, fit: 'cover' as const }
  const timeline = { sources: [source4k], segments: [{ id: 'clip', sourceId: '4k', sourceStart: 0, sourceEnd: 40 }] }

  it.each(['turbo', 'base'] as const)('limits a 4K-source Short to its close-ups in %s mode', (mode) => {
    const plan = aiEnhancementPlan(short, mode, [zoom, { ...zoom, start: 9 }], timeline)
    expect(plan).toMatchObject({ spatial: true, spatialRanges: [[2, 5], [9, 12]], mode,
      canvas: { width: 2160, height: 3840, fps: 60 } })
    expect(isFlashSpatialSupported(plan)).toBe(true)
    expect(aiEnhancementPlan(short, mode, [], timeline).spatial).toBe(false)
  })

  it('does not mistake a low-resolution inserted clip for 4K footage', () => {
    const low = { ...source4k, id: 'low', metadata: { ...source4k.metadata, width: 1920, height: 1080 } }
    const sources = [source4k, low]
    // An unused imported source must not change the plan.
    expect(aiEnhancementPlan(short, 'turbo', [zoom], { ...timeline, sources }).spatialRanges).toEqual([[2, 5]])
    const mixed = { sources, segments: [...timeline.segments, { id: 'low-clip', sourceId: 'low', sourceStart: 0, sourceEnd: 10 }] }
    expect(aiEnhancementPlan(short, 'turbo', [zoom], mixed).spatialRanges).toBeUndefined()
    expect(aiEnhancementPlan(short, 'turbo', [zoom], mixed).spatial).toBe(true)
    expect(aiEnhancementPlan(short, 'turbo', [zoom], { sources, segments: [] }).spatialRanges).toBeUndefined()
    expect(aiEnhancementPlan(short, 'turbo', [zoom], { sources: [], segments: timeline.segments }).spatialRanges).toBeUndefined()
  })

  it.each([[3840, 2160], [2160, 3840]])('enhances only close-ups on a native %dx%d timeline', (width, height) => {
    const canvas = { width, height, fps: 60, fit: 'contain' as const }
    const plan = aiEnhancementPlan(canvas, 'base', [zoom, { ...zoom, start: 5 }, { ...zoom, start: 9 }])
    expect(plan).toMatchObject({ spatial: true, interpolate: false, mode: 'base', spatialRanges: [[2, 8], [9, 12]] })
    expect(plan.canvas).toEqual(canvas)
    expect(isFlashSpatialSupported(plan)).toBe(true)
    expect(aiEnhancementPlan(canvas).spatial).toBe(false)
  })

  it('still enhances the whole video below 4K and never shrinks a larger canvas', () => {
    const below = aiEnhancementPlan({ width: 1920, height: 1080, fps: 30, fit: 'contain' }, 'turbo', [zoom])
    expect(below.spatial).toBe(true)
    expect(below.spatialRanges).toBeUndefined()
    const above = aiEnhancementPlan({ width: 7680, height: 4320, fps: 60, fit: 'contain' }, 'turbo', [zoom])
    expect(above.spatial).toBe(false)
    expect(above.canvas.width).toBe(7680)
  })

  it('drops empty sub-frame ranges and joins ranges separated by no source frame', () => {
    const canvas = { width: 3840, height: 2160, fps: 60, fit: 'contain' as const }
    expect(aiEnhancementPlan(canvas, 'turbo', [{ ...zoom, start: 0.001, duration: 0.001 }]).spatial).toBe(false)
    const plan = aiEnhancementPlan(canvas, 'turbo', [{ ...zoom, start: 0, duration: 0.095 }, { ...zoom, start: 0.098, duration: 0.202 }])
    expect(plan.spatialRanges).toEqual([[0, 0.3]])
    expect(isFlashSpatialSupported(aiEnhancementPlan({ ...canvas, height: 2880 }, 'turbo', [zoom]))).toBe(false)
  })
  it('defaults spatial work to Turbo without changing the 4K landscape plan', () => {
    const plan = aiEnhancementPlan({ width: 1920, height: 1080, fps: 30, fit: 'contain' })
    expect(plan.mode).toBe('turbo')
    expect(plan.spatial).toBe(true)
    expect(plan.canvas).toMatchObject({ width: 3840, height: 2160, fps: 60 })
    expect(isFlashSpatialSupported(plan)).toBe(true)
  })

  it('preserves an explicitly selected Base mode', () => {
    const plan = aiEnhancementPlan({ width: 1920, height: 1080, fps: 60, fit: 'contain' }, 'base')
    expect(plan.mode).toBe('base')
    expect(isFlashSpatialSupported(plan)).toBe(true)
  })

  it('enhances the current Short to portrait 4K60 without cropping or stretching it', () => {
    const plan = aiEnhancementPlan({ width: 1080, height: 1920, fps: 30.000845094228005, fit: 'cover' }, 'base')
    expect(plan.spatial).toBe(true)
    expect(plan.canvas).toMatchObject({ width: 2160, height: 3840, fps: 60 })
    expect(plan.mode).toBe('base')
    expect(isFlashSpatialSupported(plan)).toBe(true)
  })

  it.each([[1440, 1080], [1920, 800]])('still rejects an unsupported %dx%d spatial aspect ratio', (width, height) => {
    const plan = aiEnhancementPlan({ width, height, fps: 30, fit: 'contain' })
    expect(isFlashSpatialSupported(plan)).toBe(false)
  })

  it('does not require Flash geometry for RIFE-only work', () => {
    const plan = aiEnhancementPlan({ width: 2160, height: 3840, fps: 30, fit: 'contain' })
    expect(plan.spatial).toBe(false)
    expect(plan.interpolate).toBe(true)
    expect(isFlashSpatialSupported(plan)).toBe(true)
  })
})
