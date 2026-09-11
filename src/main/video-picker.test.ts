import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

import { initialVideoDirectory, listVideoDirectory, maxVideoDirectoryEntries } from './video-picker'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'otc-video-picker-'))
  temporaryDirectories.push(path)
  return path
}

describe('listVideoDirectory', () => {
  it('canonicalizes the folder and returns visible folders and video files only', async () => {
    const directory = await temporaryDirectory()
    const nested = join(directory, '2 clips')
    await mkdir(nested)
    await writeFile(join(directory, '10.mp4'), '')
    await writeFile(join(directory, '2.MKV'), '')
    await writeFile(join(directory, 'notes.txt'), '')
    await writeFile(join(directory, '.hidden.mp4'), '')
    await symlink(join(directory, '10.mp4'), join(directory, 'linked.mp4'))

    const result = await listVideoDirectory(join(directory, '.'))

    expect(result.path).toBe(resolve(directory))
    expect(result.parent).toBe(resolve(join(directory, '..')))
    expect(result.truncated).toBe(false)
    expect(result.entries).toEqual([
      { path: nested, name: '2 clips', kind: 'directory' },
      { path: join(directory, '2.MKV'), name: '2.MKV', kind: 'video' },
      { path: join(directory, '10.mp4'), name: '10.mp4', kind: 'video' }
    ])
  })

  it('caps matching entries and reports truncation', async () => {
    const directory = await temporaryDirectory()
    await Promise.all(Array.from({ length: maxVideoDirectoryEntries + 1 }, (_, index) =>
      writeFile(join(directory, `clip-${String(index).padStart(4, '0')}.mp4`), '')
    ))

    const result = await listVideoDirectory(directory)

    expect(result.entries).toHaveLength(maxVideoDirectoryEntries)
    expect(result.truncated).toBe(true)
  })

  it('rejects relative, missing, and non-directory paths', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'clip.mp4')
    await writeFile(file, '')

    await expect(listVideoDirectory('videos')).rejects.toThrow('absolute')
    await expect(listVideoDirectory(join(directory, 'missing'))).rejects.toThrow()
    await expect(listVideoDirectory(file)).rejects.toThrow('directory')
  })
})

describe('initialVideoDirectory', () => {
  it('preserves the fallback when no startup video was requested', () => {
    expect(initialVideoDirectory(undefined, '/fallback/videos')).toBe('/fallback/videos')
  })

  it('uses the parent of an absolute startup video path', () => {
    const source = '/tmp/one-track-cat/start.mp4'
    expect(initialVideoDirectory(source, '/fallback/videos')).toBe(dirname(source))
  })

  it('resolves a relative startup video path before using its parent', () => {
    const source = 'clips/start.mp4'
    expect(initialVideoDirectory(source, '/fallback/videos')).toBe(dirname(resolve(source)))
  })
})
