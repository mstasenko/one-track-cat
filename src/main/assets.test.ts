import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/otc') } }))
vi.mock('./binaries', () => ({ bundledMemePath: () => '/tmp/meme' }))

import { categoryFor, displayName } from './assets'

describe('media library names', () => {
  it('shows clean names without extensions, counters, or separators', () => {
    expect(displayName('/media/01-a-few_moments-later.wav')).toBe('a few moments later')
    expect(displayName('/media/Wilhelm Scream.ogg')).toBe('Wilhelm Scream')
  })

  it('falls back to the original stem when cleaning removes the entire name', () => {
    expect(displayName('/media/01-.png')).toBe('01-')
    expect(displayName('/media/01.png')).toBe('01')
  })

  it('recognizes every supported library category', () => {
    expect(categoryFor('picture.jpg')).toBe('image')
    expect(categoryFor('reaction.gif')).toBe('gif')
    expect(categoryFor('clip.webm')).toBe('video')
    expect(categoryFor('phone.m4v')).toBe('video')
    expect(categoryFor('legacy.avi')).toBe('video')
    expect(categoryFor('effect.ogg')).toBe('audio')
    expect(categoryFor('notes.txt')).toBeNull()
  })
})
