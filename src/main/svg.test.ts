import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { svgDataUrl } from './svg'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('SVG export input', () => {
  it('returns an embeddable data URL for an authorized SVG file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-svg-'))
    directories.push(directory)
    const path = join(directory, 'picture.svg')
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')
    const dataUrl = await svgDataUrl(path)
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(Buffer.from(dataUrl.split(',')[1] ?? '', 'base64').toString()).toContain('<svg')
  })

  it('rejects files that are not SVG images', async () => {
    await expect(svgDataUrl('/tmp/picture.png')).rejects.toThrow('Only SVG')
  })
})
