import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, Overlay } from '../src/types'

vi.mock('../src/main/binaries', () => ({ ffmpegPath: () => '/ffmpeg', ffprobePath: () => '/ffprobe' }))
vi.mock('../src/main/jobs', () => ({ jobs: { run: vi.fn() } }))

let buildFilterGraph: typeof import('../src/main/exporter').buildFilterGraph

beforeAll(async () => {
  ;({ buildFilterGraph } = await import('../src/main/exporter'))
})

describe('FFmpeg overlay animation', () => {
  it.each(['image', 'video'] as const)('animates %s overlays on their local clock without changing default opacity', (type) => {
    const common = { id: 'overlay', name: 'Overlay', start: 0.5, duration: 2, zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 0.6 }
    const overlay: Extract<Overlay, { type: 'image' | 'video' }> = type === 'image'
      ? { ...common, type, path: '/image.png' }
      : { ...common, type, path: '/clip.mp4', sourceIn: 0.25, sourceDuration: 3, loop: false, hasAudio: true, audioEnabled: true, volume: 1 }
    const source = { path: '/base.mp4', name: 'base.mp4', size: 1, modifiedAt: 1, duration: 6, width: 320, height: 180, fps: 24, videoCodec: 'h264', hasAudio: true }
    const request: ExportRequest = {
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' }, sources: [{ id: 'base', metadata: source }],
      outputPath: '/out.mp4', segments: [{ id: 'segment', sourceId: 'base', sourceStart: 0, sourceEnd: 6 }], overlays: [overlay]
    }
    const original = buildFilterGraph(request, [{ overlay, index: 1 }]).graph
    const none = { ...overlay, animation: 'none' as const }
    expect(buildFilterGraph({ ...request, overlays: [none] }, [{ overlay: none, index: 1 }]).graph).toBe(original)
    expect(original).toContain('colorchannelmixer=aa=0.6')
    const fade = { ...overlay, animation: 'fade' as const }
    const animated = buildFilterGraph({ ...request, overlays: [fade] }, [{ overlay: fade, index: 1 }]).graph
    expect(animated).toContain("sendcmd=c='0 [expr] colorchannelmixer@visualalpha0 aa 0.6*(")
    expect(animated).toContain('colorchannelmixer@visualalpha0=aa=0.6')
    expect(animated).not.toContain('geq=')
    expect(animated).toContain('(T-0.500000)/0.220000')
    expect(animated).toContain('(2.000000-(T-0.500000))/0.220000')
    expect(animated).toContain("enable='gte(t,0.500000)*lt(t,2.500000)'")
    const customFade = { ...fade, animationFadeIn: 0, animationFadeOut: 0.8 }
    const custom = buildFilterGraph({ ...request, overlays: [customFade] }, [{ overlay: customFade, index: 1 }]).graph
    expect(custom).toContain('min(1')
    expect(custom).toContain('(2.000000-(T-0.500000))/0.800000')
    expect(custom).not.toContain('/0.000000')
    const shortFade = { ...fade, duration: 0.2 }
    expect(buildFilterGraph({ ...request, overlays: [shortFade] }, [{ overlay: shortFade, index: 1 }]).graph).toContain('(T-0.500000)/0.100000')
    for (const animation of ['pop', 'bounce', 'shake'] as const) {
      const effect = { ...overlay, animation }
      const graph = buildFilterGraph({ ...request, overlays: [effect] }, [{ overlay: effect, index: 1 }]).graph
      expect(graph).toContain("overlay=x='0+320/2-overlay_w/2+")
      expect(graph).toContain(':eval=frame:eof_action=repeat')
      expect(graph).toContain('(t-0.500000)')
      if (animation === 'shake') expect(graph).toContain('sin(9*PI*')
      else {
        expect(graph).toContain("scale=w='max(2,2*round(iw*(")
        expect(graph).not.toContain('geq=')
        expect(graph.indexOf('colorchannelmixer@visualalpha0')).toBeLessThan(graph.indexOf("scale=w='max(2,2*round(iw*("))
      }
    }
  })

  it('applies custom motion timing and text fade timing without zero divisors', () => {
    const source = { path: '/base.mp4', name: 'base.mp4', size: 1, modifiedAt: 1, duration: 3, width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: false }
    const canvas = { width: 320, height: 180, fps: 30, fit: 'contain' as const }
    const media: Extract<Overlay, { type: 'image' }> = {
      id: 'image', type: 'image', name: 'Picture', path: '/picture.png',
      start: 0.5, duration: 2, zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 0.6,
      animation: 'pop', animationDuration: 0.8
    }
    const request = (overlay: Overlay): ExportRequest => ({
      canvas, sources: [{ id: 'base', metadata: source }], outputPath: '/out.mp4',
      segments: [{ id: 'base', sourceId: 'base', sourceStart: 0, sourceEnd: 3 }], overlays: [overlay]
    })
    const customMotion = buildFilterGraph(request(media), [{ overlay: media, index: 1 }]).graph
    expect(customMotion).toContain('(t-0.500000)/0.520000')
    expect(customMotion).toContain('(t-0.500000),0.800000')

    const zeroMotion = { ...media, animation: 'bounce' as const, animationDuration: 0 }
    const zeroMotionGraph = buildFilterGraph(request(zeroMotion), [{ overlay: zeroMotion, index: 1 }]).graph
    expect(zeroMotionGraph).not.toContain('/0.000000')
    expect(zeroMotionGraph).not.toContain("scale=w='max(2,2*round(iw*(")

    const shortMotion = { ...media, duration: 0.2, animation: 'shake' as const, animationDuration: 5 }
    const shortMotionGraph = buildFilterGraph(request(shortMotion), [{ overlay: shortMotion, index: 1 }]).graph
    expect(shortMotionGraph).toContain('(t-0.500000)/0.200000')
    expect(shortMotionGraph).not.toContain('/5.000000')

    const text: Extract<Overlay, { type: 'text' }> = {
      id: 'text', type: 'text', name: 'Title', start: 0.5, duration: 2, zIndex: 1,
      x: 0.25, y: 0.25, width: 0.5, height: 0.2, opacity: 0.8, text: 'FADE',
      fontFamily: 'Anton', fontSize: 7, color: '#fff', outlineColor: '#000', outlineWidth: 2,
      shadow: false, align: 'center', animation: 'fade', animationDuration: 0,
      animationFadeIn: 0.4, animationFadeOut: 0.8,
      renderedTextBitmap: { dataUrl: 'data:image/png;base64,AA==', x: 70, y: 35, anchorX: 160, anchorY: 63 }
    }
    const textFade = buildFilterGraph(request(text), [{ overlay: text, index: 1 }]).graph
    expect(textFade).toContain('T/0.400000')
    expect(textFade).toContain('(2.000000-T)/0.800000')
    expect(textFade).not.toContain('/0.000000')

    const shortText = { ...text, duration: 0.2, animationFadeIn: 5, animationFadeOut: 5 }
    const shortTextGraph = buildFilterGraph(request(shortText), [{ overlay: shortText, index: 1 }]).graph
    expect(shortTextGraph).toContain('T/0.200000')
    expect(shortTextGraph).toContain('(0.200000-T)/0.200000')
  })
})
