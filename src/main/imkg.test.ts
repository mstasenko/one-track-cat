import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./imkg-catalog.json', () => ({
  default: {
    memes: [
      { id: '123', name: 'A different meme', caption: 'The cat is judging this project', url: 'https://i.imgflip.com/123.jpg' },
      { id: '000abc', name: 'Judging Cat', caption: 'This project needs more tests', url: 'https://i.imgflip.com/000abc.png' },
      { id: 'xyz', name: 'A quiet dog', caption: 'I have no idea what I am doing', url: 'https://i.imgflip.com/xyz.jpg' },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `many${index}`, name: `Many examples ${index}`, caption: 'Another caption', url: `https://i.imgflip.com/many${index}.jpg`
      }))
    ]
  }
}))

import { searchImkg } from './imkg'

afterEach(() => { vi.unstubAllGlobals() })

describe('captioned IMKG search', () => {
  it('matches captions but ranks matching names first', () => {
    expect(searchImkg('  CAT  ').map((meme) => meme.id)).toEqual(['000abc', '123'])
    expect(searchImkg('no idea').map((meme) => meme.id)).toEqual(['xyz'])
  })

  it('requires every word across the name and caption', () => {
    expect(searchImkg('cat tests').map((meme) => meme.id)).toEqual(['000abc'])
    expect(searchImkg('cat missing')).toEqual([])
    expect(searchImkg('   ')).toEqual([])
  })

  it('returns image instances with their unchanged base36 IDs and no extra metadata', () => {
    expect(searchImkg('cat tests')).toEqual([{
      id: '000abc', source: 'imkg', name: 'Judging Cat', type: 'image', url: 'https://i.imgflip.com/000abc.png'
    }])
  })

  it('caps matches and searches the bundled metadata without network requests', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(searchImkg('many examples')).toHaveLength(24)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ships a bounded genuine catalogue with safe, distinct captioned image entries', async () => {
    const { default: catalog } = await vi.importActual<{ default: typeof import('./imkg-catalog.json') }>('./imkg-catalog.json')
    expect(catalog.source).toBe('https://owncloud.ut.ee/owncloud/s/mFdPCY2mWdQLZ7Q')
    expect(catalog.archiveSha256).toBe('6523b96005fd36bcd363f680fe5cc40cdbcee7ca9a8bd703dddca7ef7799b8f1')
    expect(catalog.memes.length).toBeGreaterThan(658)
    expect(catalog.memes.length).toBeLessThanOrEqual(10_000)
    expect(new Set(catalog.memes.map((meme) => meme.id)).size).toBe(catalog.memes.length)
    for (const meme of catalog.memes) {
      expect(meme.id).toMatch(/^[a-z0-9]{1,12}$/)
      expect(meme.url).toMatch(new RegExp(`^https://i\\.imgflip\\.com/${meme.id}\\.(?:jpg|jpeg|png|webp)$`))
      expect(Array.from(meme.name).length).toBeGreaterThan(0)
      expect(Array.from(meme.name).length).toBeLessThanOrEqual(240)
      expect(Array.from(meme.caption).length).toBeGreaterThan(0)
      expect(Array.from(meme.caption).length).toBeLessThanOrEqual(512)
    }
  })
})
