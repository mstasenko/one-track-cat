import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportRequest, Overlay } from '../src/types'

vi.mock('../../src/main/binaries', () => ({ ffmpegPath: () => '/ffmpeg', ffprobePath: () => '/ffprobe' }))
vi.mock('../../src/main/jobs', () => ({ jobs: { run: vi.fn() } }))

let buildFilterGraph: typeof import('../src/main/exporter').buildFilterGraph
let estimatedExportBytes: typeof import('../src/main/exporter').estimatedExportBytes
let loopsInput: typeof import('../src/main/exporter').loopsInput
let prepareTimelineInputs: typeof import('../src/main/exporter').prepareTimelineInputs

beforeAll(async () => {
  ;({ buildFilterGraph, estimatedExportBytes, loopsInput, prepareTimelineInputs } = await import('../src/main/exporter'))
})

describe('FFmpeg export graph', () => {
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

  it('estimates output space from timeline duration rather than source file size', () => {
    const source = { path: '/huge.mp4', name: 'huge.mp4', size: 100 * 1024 ** 3, modifiedAt: 1, duration: 3600, width: 1920, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: true }
    const request: ExportRequest = {
      canvas: { width: 1920, height: 1080, fps: 30, fit: 'contain' },
      sources: [{ id: 's', metadata: source }], outputPath: '/out.mp4',
      segments: [{ id: 'short', sourceId: 's', sourceStart: 0, sourceEnd: 10 }], overlays: []
    }
    expect(estimatedExportBytes(request)).toBeLessThan(1024 ** 3)
  })

  it('always loops GIF input', () => {
    const gif: Overlay = {
      id: 'gif', type: 'gif', name: 'Reaction', path: '/reaction.gif', playbackPath: '/reaction.mp4',
      start: 0, duration: 2, zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1,
      sourceIn: 0, sourceDuration: 2
    }
    expect(loopsInput(gif)).toBe(true)
  })

  it('holds freeze frames with silence and applies focus before overlays', () => {
    const source = { path: '/v.mp4', name: 'v.mp4', size: 1, modifiedAt: 1, duration: 2, width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true }
    const graph = buildFilterGraph({ canvas: { width: 320, height: 180, fps: 30, fit: 'contain' }, sources: [{ id: 's', metadata: source }], outputPath: '/out.mp4', segments: [{ kind: 'freeze', id: 'f', sourceId: 's', sourceTime: 1, duration: 1 }], overlays: [], focusZooms: [{ id: 'z', start: 0, duration: 1, zoom: 1.5, focusX: 0.5, focusY: 0.5 }] }, []).graph
    expect(graph).toContain("select='eq(n,0)',scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=1.000000")
    expect(graph).not.toContain("select='eq(n,0)',tpad=stop_mode=clone")
    expect(graph).toContain('anullsrc=channel_layout=stereo:sample_rate=48000:d=1.000000')
    expect(graph).toContain('[basev]zoompan=')
  })

  it('exports every supported segment speed with matching video, audio, and silence timing', () => {
    const source = { path: '/speed.mp4', name: 'speed.mp4', size: 1, modifiedAt: 1, duration: 10, width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true }
    const rates = [0.25, 0.5, 1, 2, 4] as const
    const graph = buildFilterGraph({ canvas: { width: 320, height: 180, fps: 30, fit: 'contain' }, sources: [{ id: 's', metadata: source }], outputPath: '/speed.mp4', segments: rates.map((playbackRate, index) => ({ id: `s${index}`, sourceId: 's', sourceStart: 0, sourceEnd: 1, playbackRate })), overlays: [] }, []).graph
    expect(graph).toContain('setpts=(PTS-STARTPTS)/0.25')
    expect(graph).toContain('atempo=0.5,atempo=0.5')
    expect(graph).toContain('setpts=(PTS-STARTPTS)/4')
    expect(graph).toContain('atempo=2,atempo=2')
  })

  it('exports Replay through the existing half-speed segment path without another source', () => {
    const source = { path: '/game.mp4', name: 'game.mp4', size: 1, modifiedAt: 1, duration: 4, width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true }
    const graph = buildFilterGraph({
      canvas: { width: 320, height: 180, fps: 30, fit: 'contain' },
      sources: [{ id: 'game', metadata: source }], outputPath: '/replay.mp4', overlays: [],
      segments: [
        { id: 'original', sourceId: 'game', sourceStart: 0, sourceEnd: 1 },
        { id: 'replay', sourceId: 'game', sourceStart: 0, sourceEnd: 1, playbackRate: 0.5, replayGroupId: 'replay-one' }
      ]
    }, []).graph
    expect(graph).toContain('[0:v:0]trim=start=0.000000:end=1.000000')
    expect(graph).toContain('setpts=(PTS-STARTPTS)/0.5')
    expect(graph).toContain('atempo=0.5')
    expect(graph).not.toContain('[1:v:0]trim=')
  })

  it('opens each edited segment at its own source range to keep future frames unbuffered', () => {
    const source = { path: '/game.mp4', name: 'game.mp4', size: 1, modifiedAt: 1, duration: 20, width: 1920, height: 1080, fps: 60, videoCodec: 'h264', hasAudio: true }
    const request: ExportRequest = {
      canvas: { width: 1920, height: 1080, fps: 60, fit: 'contain' },
      sources: [{ id: 'game', metadata: source }], outputPath: '/edited.mp4', overlays: [],
      segments: [
        { id: 'first', sourceId: 'game', sourceStart: 2, sourceEnd: 7 },
        { id: 'second', sourceId: 'game', sourceStart: 10, sourceEnd: 14 },
        { kind: 'freeze', id: 'freeze', sourceId: 'game', sourceTime: 16, duration: 1 }
      ]
    }
    const args: string[] = []
    const prepared = prepareTimelineInputs(request, args)

    expect(args).toEqual([
      '-ss', '2.000000', '-t', '5.000000', '-threads', '4', '-i', '/game.mp4',
      '-ss', '10.000000', '-t', '4.000000', '-threads', '4', '-i', '/game.mp4',
      '-ss', '16.000000', '-t', '1', '-threads', '4', '-i', '/game.mp4'
    ])
    expect(prepared.sources.map((item) => item.id)).toEqual([
      'export-segment-0', 'export-segment-1', 'export-segment-2'
    ])
    expect(prepared.segments).toMatchObject([
      { sourceId: 'export-segment-0', sourceStart: 0, sourceEnd: 5 },
      { sourceId: 'export-segment-1', sourceStart: 0, sourceEnd: 4 },
      { sourceId: 'export-segment-2', sourceTime: 0, duration: 1 }
    ])
    const graph = buildFilterGraph(prepared, []).graph
    expect(graph).toContain('[0:v:0]trim=start=0.000000:end=5.000000')
    expect(graph).toContain('[1:v:0]trim=start=0.000000:end=4.000000')
    expect(graph).toContain('[2:v:0]trim=start=0.000000')
    expect(request.segments[0]).toMatchObject({ sourceId: 'game', sourceStart: 2, sourceEnd: 7 })
  })

  it('animates only a prepared local text bitmap while None stays static', () => {
    const source = { path: '/game.mp4', name: 'game.mp4', size: 1, modifiedAt: 1, duration: 3, width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: false }
    const text = {
      id: 'text', type: 'text' as const, name: 'Title', start: 0.5, duration: 2, zIndex: 1,
      x: 0.25, y: 0.25, width: 0.5, height: 0.2, opacity: 0.8, text: 'POP',
      fontFamily: 'Anton', fontSize: 7, color: '#fff', outlineColor: '#000', outlineWidth: 2,
      shadow: false, align: 'center' as const, animation: 'pop' as const,
      renderedTextBitmap: { dataUrl: 'data:image/png;base64,AA==', x: 70, y: 35, anchorX: 160, anchorY: 63 }
    }
    const request: ExportRequest = {
      canvas: { width: 320, height: 180, fps: 30, fit: 'contain' }, sources: [{ id: 'game', metadata: source }],
      outputPath: '/text.mp4', segments: [{ id: 'game', sourceId: 'game', sourceStart: 0, sourceEnd: 3 }], overlays: [text]
    }
    const animated = buildFilterGraph(request, [{ overlay: text, index: 1 }]).graph
    expect(animated).toContain("scale=w='max(2,2*round(iw*(")
    expect(animated).toContain("sendcmd=c='0 [expr] colorchannelmixer@textalpha0 aa 0.8*(")
    expect(animated).toContain('colorchannelmixer@textalpha0=aa=0.8')
    expect(animated).not.toContain('geq=')
    expect(animated).toContain("overlay=x='160-overlay_w/2")
    const still = { ...text, animation: 'none' as const }
    const staticGraph = buildFilterGraph({ ...request, overlays: [still] }, [{ overlay: still, index: 1 }]).graph
    expect(staticGraph).toContain('overlay=x=70:y=35')
    expect(staticGraph).not.toContain('eval=frame')
  })

  it('builds retained segments, visual overlays, and equal audio mixing', () => {
    const overlays: Overlay[] = [
      {
        id: 'v', type: 'video', name: 'meme', path: '/meme.mp4', start: 1, duration: 2,
        zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1, loop: true,
        audioEnabled: true, hasAudio: true, volume: 1, sourceIn: 0.5, sourceDuration: 2
      },
      {
        id: 'a', type: 'audio', name: 'sound', path: '/sound.wav', start: 2, duration: 1,
        zIndex: 2, volume: 0.8, sourceIn: 0.25
      }
    ]
    const source = {
      path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 10,
      width: 1280, height: 720, fps: 30, videoCodec: 'h264',
      hasAudio: true
    }
    const request: ExportRequest = {
      canvas: { width: source.width, height: source.height, fps: source.fps, fit: 'contain' },
      sources: [{ id: 'source', metadata: source }],
      outputPath: '/output.mp4',
      segments: [
        { id: 's1', sourceId: 'source', sourceStart: 0, sourceEnd: 4 },
        { id: 's2', sourceId: 'source', sourceStart: 6, sourceEnd: 10 }
      ],
      overlays
    }
    const [video, audio] = overlays
    if (!video || !audio) throw new Error('Overlay fixture is incomplete')
    const result = buildFilterGraph(request, [{ overlay: video, index: 1 }, { overlay: audio, index: 2 }])
    expect(result.graph).toContain('concat=n=2:v=1:a=0')
    expect(result.graph).toContain('overlay=x=0:y=0')
    expect(result.graph).toContain('amix=inputs=3')
    expect(result.graph).toContain('trim=start=0.500000:end=2.500000')
    expect(result.graph).toContain('atrim=start=0.250000:end=1.250000')
    expect(result.graph).toContain('alimiter=limit=0.95')
    expect(result.videoLabel).toBe('vout0')
  })

  it('creates silence for a source without audio', () => {
    const source = {
      path: '/silent.mp4', name: 'silent.mp4', size: 10, modifiedAt: 1, duration: 3,
      width: 320, height: 180, fps: 24, videoCodec: 'h264',
      hasAudio: false
    }
    const request: ExportRequest = {
      canvas: { width: source.width, height: source.height, fps: source.fps, fit: 'contain' },
      sources: [{ id: 'source', metadata: source }],
      outputPath: '/output.mp4', segments: [{ id: 's', sourceId: 'source', sourceStart: 0, sourceEnd: 3 }], overlays: []
    }
    expect(buildFilterGraph(request, []).graph).toContain('anullsrc=channel_layout=stereo')
  })

  it('centers contained media and applies text opacity exactly once', () => {
    const overlays: Overlay[] = [
      {
        id: 'text', type: 'text', name: 'Title', start: 0, duration: 2, zIndex: 1,
        x: 0.1, y: 0.1, width: 0.8, height: 0.2, opacity: 0.5, text: 'Hello',
        fontFamily: 'Anton', fontSize: 7, color: '#fff', outlineColor: '#000',
        outlineWidth: 2, shadow: false, align: 'center'
      },
      {
        id: 'image', type: 'image', name: 'Picture', path: '/picture.png',
        start: 0, duration: 2, zIndex: 2, x: 0.25, y: 0.25,
        width: 0.5, height: 0.5, opacity: 1
      }
    ]
    const source = {
      path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 2,
      width: 1280, height: 720, fps: 60, videoCodec: 'h264',
      hasAudio: false
    }
    const request: ExportRequest = {
      canvas: { width: source.width, height: source.height, fps: source.fps, fit: 'contain' },
      sources: [{ id: 'source', metadata: source }],
      outputPath: '/output.mp4',
      segments: [{ id: 'source', sourceId: 'source', sourceStart: 0, sourceEnd: 2 }],
      overlays
    }
    const graph = buildFilterGraph(request, overlays.map((overlay, offset) => ({ overlay, index: offset + 1 }))).graph
    expect(graph.match(/colorchannelmixer=aa=0\.5/g)).toHaveLength(1)
    expect(graph).toContain('pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black@0')
    expect(graph).toContain('overlay=x=320:y=180')
  })

  it('normalizes multiple sources into a cropped 9:16 Short canvas', () => {
    const landscape = {
      path: '/landscape.mp4', name: 'landscape.mp4', size: 100, modifiedAt: 1, duration: 2,
      width: 1920, height: 1080, fps: 30, videoCodec: 'h264',
      hasAudio: true
    }
    const silent = {
      ...landscape, path: '/silent.mp4', name: 'silent.mp4', width: 640, height: 480,
      fps: 24, hasAudio: false
    }
    const request: ExportRequest = {
      canvas: { width: 1080, height: 1920, fps: 30, fit: 'cover' },
      sources: [{ id: 'landscape', metadata: landscape }, { id: 'silent', metadata: silent }],
      outputPath: '/short.mp4',
      segments: [
        { id: 'a', sourceId: 'landscape', sourceStart: 0, sourceEnd: 2 },
        { id: 'b', sourceId: 'silent', sourceStart: 0, sourceEnd: 2 }
      ],
      overlays: []
    }
    const graph = buildFilterGraph(request, []).graph
    expect(graph).toContain('[0:v:0]trim=')
    expect(graph).toContain('[1:v:0]trim=')
    expect(graph).toContain('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920')
    expect(graph).toContain('anullsrc=channel_layout=stereo:sample_rate=48000:d=2.000000')
    expect(graph).toContain('concat=n=2:v=1:a=0')
    expect(graph).toContain('concat=n=2:v=0:a=1')
    expect(graph).toContain('afade=t=out:st=1.990000:d=0.010000[aseg0]')
  })

  it('de-clicks both sides of an audio hard cut without changing video timing', () => {
    const source = {
      path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 4,
      width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: true
    }
    const graph = buildFilterGraph({
      canvas: { width: 320, height: 180, fps: 30, fit: 'contain' },
      sources: [{ id: 'source', metadata: source }], outputPath: '/joined.mp4',
      segments: [
        { id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 2 },
        { id: 'second', sourceId: 'source', sourceStart: 2, sourceEnd: 4 }
      ],
      overlays: []
    }, []).graph

    expect(graph).toContain('afade=t=out:st=1.990000:d=0.010000[aseg0]')
    expect(graph).toContain('afade=t=in:st=0:d=0.010000[aseg1]')
    expect(graph).toContain('[vseg0][vseg1]concat=n=2:v=1:a=0')
  })

  it('cover-fits a full-frame video overlay on a Short canvas', () => {
    const source = {
      path: '/short.mp4', name: 'short.mp4', size: 100, modifiedAt: 1, duration: 1,
      width: 320, height: 180, fps: 30, videoCodec: 'h264', hasAudio: false
    }
    const overlay: Overlay = {
      id: 'video', type: 'video', name: 'Bright clip', path: '/bright.mp4',
      start: 0, duration: 1, zIndex: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1,
      loop: false, audioEnabled: false, hasAudio: false, volume: 1, sourceIn: 0, sourceDuration: 1
    }
    const request: ExportRequest = {
      canvas: { width: 1080, height: 1920, fps: 30, fit: 'cover' },
      sources: [{ id: 'source', metadata: source }], outputPath: '/short-output.mp4',
      segments: [{ id: 'source', sourceId: 'source', sourceStart: 0, sourceEnd: 1 }], overlays: [overlay]
    }
    const graph = buildFilterGraph(request, [{ overlay, index: 1 }]).graph
    expect(graph).toContain(
      '[1:v:0]trim=start=0.000000:end=1.000000,settb=AVTB,setpts=PTS-STARTPTS+0.000000/TB,' +
      'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=rgba,setsar=1'
    )
  })

  it('keeps contain fitting for smaller video, still-image and GIF overlays', () => {
    const source = {
      path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 1,
      width: 1080, height: 1920, fps: 30, videoCodec: 'h264', hasAudio: false
    }
    const baseRequest: Omit<ExportRequest, 'overlays'> = {
      canvas: { width: 1080, height: 1920, fps: 30, fit: 'cover' },
      sources: [{ id: 'source', metadata: source }], outputPath: '/short-output.mp4',
      segments: [{ id: 'source', sourceId: 'source', sourceStart: 0, sourceEnd: 1 }]
    }
    const overlays: Overlay[] = [
      {
        id: 'small-video', type: 'video', name: 'Small clip', path: '/small.mp4',
        start: 0, duration: 1, zIndex: 1, x: 0.25, y: 0.25, width: 0.5, height: 0.5, opacity: 1,
        loop: false, audioEnabled: false, hasAudio: false, volume: 1, sourceIn: 0, sourceDuration: 1
      },
      {
        id: 'image', type: 'image', name: 'Picture', path: '/picture.png',
        start: 0, duration: 1, zIndex: 2, x: 0, y: 0, width: 1, height: 1, opacity: 1
      },
      {
        id: 'gif', type: 'gif', name: 'Reaction', path: '/reaction.gif', playbackPath: '/reaction.mp4',
        start: 0, duration: 1, zIndex: 3, x: 0, y: 0, width: 1, height: 1, opacity: 1,
        sourceIn: 0, sourceDuration: 1
      }
    ]
    const graph = buildFilterGraph(
      { ...baseRequest, overlays },
      overlays.map((overlay, index) => ({ overlay, index: index + 1 }))
    ).graph
    expect(graph).toContain('scale=540:960:force_original_aspect_ratio=decrease,format=rgba,pad=540:960:(ow-iw)/2:(oh-ih)/2:color=black@0')
    expect(graph.match(/scale=1080:1920:force_original_aspect_ratio=decrease,format=rgba,pad=1080:1920/g)).toHaveLength(2)
    expect(graph.match(/crop=1080:1920/g)).toHaveLength(1)
  })

  it('keeps duration while transitioning into and back from an inserted clip', () => {
    const source = {
      path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 5,
      width: 320, height: 180, fps: 24, videoCodec: 'h264',
      hasAudio: true
    }
    const request: ExportRequest = {
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
      sources: [
        { id: 'source', metadata: source },
        { id: 'inserted', metadata: { ...source, path: '/inserted.mp4', name: 'inserted.mp4', duration: 1 } }
      ],
      outputPath: '/transitioned.mp4',
      segments: [
        { id: 'left', sourceId: 'source', sourceStart: 0, sourceEnd: 2 },
        {
          id: 'inserted', sourceId: 'inserted', sourceStart: 0, sourceEnd: 1,
          transition: { effect: 'dissolve', duration: 0.35 }
        },
        {
          id: 'right', sourceId: 'source', sourceStart: 2, sourceEnd: 5,
          transition: { effect: 'circleopen', duration: 0.65 }
        }
      ],
      overlays: []
    }
    const graph = buildFilterGraph(request, []).graph
    expect(graph).toContain('trim=start=0.000000:end=2.350000')
    expect(graph).toContain('[vseg0][vseg1]xfade=transition=dissolve:duration=0.350000:offset=2.000000[vjoin1]')
    expect(graph).toContain('[vjoin1][vseg2]xfade=transition=circleopen:duration=0.650000:offset=3.000000[vjoin2]')
    expect(graph).not.toContain('vtail')
    expect(graph).toContain('[vjoin2]null[basev]')
    expect(graph).toContain('concat=n=3:v=0:a=1')
    expect(graph).toContain('afade=t=out:st=1.990000:d=0.010000[aseg0]')
    expect(graph).toContain('afade=t=in:st=0:d=0.010000,afade=t=out:st=0.990000:d=0.010000[aseg1]')
    expect(graph).toContain('afade=t=in:st=0:d=0.010000[aseg2]')
  })

  it('renders selected-range fade and blur edges before overlays', () => {
    const source = {
      path: '/source.mp4', name: 'source.mp4', size: 100, modifiedAt: 1, duration: 5,
      width: 320, height: 180, fps: 24, videoCodec: 'h264', hasAudio: true
    }
    const graph = buildFilterGraph({
      canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
      sources: [{ id: 'source', metadata: source }], outputPath: '/transitioned.mp4',
      segments: [{ id: 'source', sourceId: 'source', sourceStart: 0, sourceEnd: 5 }], overlays: [],
      videoTransitions: [{
        id: 'transition', start: 1, duration: 3,
        into: { effect: 'dissolve', duration: 0.5 },
        out: { effect: 'hblur', duration: 1 }
      }]
    }, []).graph
    expect(graph).toContain('[basev]null[vrfadeclean0]')
    expect(graph).toContain('color=c=black:s=320x180')
    expect(graph).toContain("[vrfadeclean0][vrblack0]blend@vrfade0=all_mode=normal:c0_opacity=1:c1_opacity=1:c2_opacity=1:c3_opacity=1,sendcmd=c='")
    expect(graph).toContain('blend@vrfade0 c0_opacity')
    expect(graph).toContain('[vrfade0]split=2[vrclean0][vrblurin0]')
    expect(graph).toContain("[vrblurin0]gblur=sigma=18:steps=2:enable='gt(")
    expect(graph).toContain("[vrclean0][vrblur0]blend@vrout0=all_mode=normal:c0_opacity=1:c1_opacity=1:c2_opacity=1:c3_opacity=1,sendcmd=c='")
    expect(graph).not.toContain('blend=all_expr=')
  })
})
