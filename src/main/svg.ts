import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

const maximumSvgBytes = 5 * 1024 * 1024

export async function svgDataUrl(path: string): Promise<string> {
  if (extname(path).toLowerCase() !== '.svg') throw new Error('Only SVG images can be rasterized')
  if ((await stat(path)).size > maximumSvgBytes) throw new Error('The SVG image is too large')
  const encoded = (await readFile(path)).toString('base64')
  return `data:image/svg+xml;base64,${encoded}`
}
