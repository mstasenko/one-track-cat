import type { EditSession, ExportRequest, ImageOverlay, Overlay } from '@shared/types'
import { renderTextBitmap } from './text-render'
import { fitVideoRangeTransition } from '@shared/video-range-transition'

function loadedImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The SVG image could not be loaded'))
    image.src = url
  })
}

async function renderSvg(overlay: ImageOverlay): Promise<string> {
  const image = await loadedImage(await window.otc.getSvgDataUrl(overlay.path))
  const naturalWidth = Math.max(1, image.naturalWidth)
  const naturalHeight = Math.max(1, image.naturalHeight)
  const scale = Math.min(1, 4096 / naturalWidth, 4096 / naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(naturalHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas image renderer is unavailable')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

function isSvgImage(overlay: Overlay): overlay is ImageOverlay {
  return overlay.type === 'image' && overlay.path.toLowerCase().endsWith('.svg')
}

async function prepareOverlay(overlay: Overlay, session: EditSession): Promise<Overlay> {
  if (overlay.type === 'audio') return overlay
  if (overlay.type === 'text') {
    return {
      ...overlay,
      renderedTextBitmap: await renderTextBitmap(overlay, session.canvas.width, session.canvas.height)
    }
  }
  return isSvgImage(overlay)
    ? { ...overlay, renderedImageDataUrl: await renderSvg(overlay) }
    : overlay
}

export async function prepareExportRequest(session: EditSession, outputPath: string): Promise<ExportRequest> {
  const overlays: Overlay[] = []
  // Rasterize one overlay at a time to avoid keeping many full-size canvases live together.
  for (const overlay of session.overlays) overlays.push(await prepareOverlay(overlay, session))
  return {
    canvas: session.canvas,
    sources: session.sources.map(({ id, metadata }) => ({ id, metadata })),
    outputPath,
    segments: session.segments,
    overlays,
    focusZooms: session.focusZooms,
    videoTransitions: session.videoTransitions?.map(fitVideoRangeTransition),
    faceBlurs: session.faceBlurs
  }
}
