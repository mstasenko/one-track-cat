import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import packageMetadata from '../../package.json'

function pngDetails(data: Buffer): { width: number; height: number; rgba: boolean } {
  expect(data.toString('ascii', 1, 4)).toBe('PNG')
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    rgba: data[25] === 6
  }
}

describe('OneTrackCat branding assets', () => {
  it('keeps an editable vector source for the original design', async () => {
    const svg = await readFile(resolve('assets/icon.svg'), 'utf8')
    expect(svg).toContain('viewBox="0 0 512 512"')
    expect(svg).toContain('id="cat-head"')
    expect(svg).toContain('id="cat-body"')
    expect(svg).toContain('id="play-triangle"')
    expect(svg).toContain('<rect width="512" height="512" rx="82"')
    expect(svg).not.toContain('<rect width="512" height="512" fill="#000"')
    expect(svg).not.toMatch(/<image\b|data:image|<text\b/i)
  })

  it('ships the vector-derived native raster icon', async () => {
    const shipping = await readFile(resolve('src/icon.png'))
    expect(pngDetails(shipping)).toEqual({ width: 512, height: 512, rgba: true })
  })

  it('uses OneTrackCat package and Linux identifiers', () => {
    expect(packageMetadata).toMatchObject({
      name: 'one-track-cat',
      desktopName: 'OneTrackCat.desktop',
      build: {
        appId: 'io.github.mstasenko.otc',
        productName: 'OneTrackCat',
        linux: { executableName: 'OneTrackCat', icon: 'src/icon.png' }
      }
    })
  })
})
