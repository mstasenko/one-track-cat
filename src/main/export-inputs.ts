import { writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Overlay } from '../types'

async function prepareRenderedImage(
  overlay: Pick<Overlay, 'id' | 'name'>,
  dataUrl: string | undefined,
  directory: string
): Promise<string> {
  if (!dataUrl?.startsWith('data:image/png;base64,')) {
    throw new Error(`Overlay “${overlay.name}” was not rendered before export`)
  }
  const path = join(directory, `${overlay.id}.png`)
  const encoded = dataUrl.slice('data:image/png;base64,'.length)
  await writeFile(path, Buffer.from(encoded, 'base64'))
  return path
}

async function prepareVisualPath(overlay: Overlay, directory: string): Promise<string> {
  if (overlay.type === 'text') return prepareRenderedImage(overlay, overlay.renderedTextBitmap?.dataUrl, directory)
  if (overlay.type === 'audio') throw new Error('Audio overlays do not have a visual path')
  if (extname(overlay.path).toLowerCase() !== '.svg') return overlay.path
  return prepareRenderedImage(
    overlay,
    overlay.type === 'image' ? overlay.renderedImageDataUrl : undefined,
    directory
  )
}

function needsAudioValidation(overlay: Overlay): boolean {
  return overlay.type === 'video' && overlay.audioEnabled && !overlay.hasAudio
}

export function loopsInput(overlay: Overlay): boolean {
  return overlay.type === 'gif' || (overlay.type === 'video' && overlay.loop)
}

function stillInput(overlay: Overlay): boolean {
  return overlay.type === 'image' || overlay.type === 'text'
}

export async function overlayInputArgs(overlay: Overlay, directory: string): Promise<string[]> {
  if (needsAudioValidation(overlay)) throw new Error(`Video clip has no audio stream: ${overlay.name}`)
  const path = overlay.type === 'audio' ? overlay.path : await prepareVisualPath(overlay, directory)
  const options: string[] = []
  if (stillInput(overlay)) options.push('-loop', '1')
  if (loopsInput(overlay)) options.push('-stream_loop', '-1')
  return [...options, '-threads', '2', '-i', path]
}
