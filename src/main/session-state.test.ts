import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const fsPromiseMock = vi.hoisted(() => ({ writeFile: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  fsPromiseMock.writeFile.mockImplementation(actual.writeFile)
  return {
    ...actual,
    writeFile: fsPromiseMock.writeFile,
    default: { ...actual, writeFile: fsPromiseMock.writeFile }
  }
})
let loadSessionFile: typeof import('./session-state').loadSessionFile
let resetSessionFile: typeof import('./session-state').resetSessionFile
let saveSessionFile: typeof import('./session-state').saveSessionFile

beforeAll(async () => {
  ({ loadSessionFile, resetSessionFile, saveSessionFile } = await import('./session-state'))
})

const directories: string[] = []

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'otc-state-test-'))
  directories.push(directory)
  return join(directory, 'nested', 'editor-state.json')
}

const metadata = {
  path: '/video.mp4', name: 'video.mp4', size: 10, modifiedAt: 100, duration: 3,
  width: 320, height: 180, fps: 24, videoCodec: 'h264',
  hasAudio: true
}
const session = {
  canvas: { width: 320, height: 180, fps: 24, fit: 'contain' },
  sources: [{ id: 'source', metadata }],
  segments: [
    { id: 'first', sourceId: 'source', sourceStart: 0, sourceEnd: 1 },
    {
      id: 'segment', sourceId: 'source', sourceStart: 1, sourceEnd: 3,
      transition: { effect: 'wipeleft', duration: 0.5 }
    }
  ],
  overlays: [], selectedOverlayId: null, playhead: 1, marks: [1]
}
const persistedSession = {
  ...session,
  history: [{ ...session, playhead: 0, marks: [] }],
  future: [{ ...session, playhead: 2, marks: [1, 2] }]
}

afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('saved editor state', () => {
  it('atomically saves, loads, and resets a valid session', async () => {
    const path = await statePath()
    await saveSessionFile(path, persistedSession)
    expect(await loadSessionFile(path)).toEqual(persistedSession)
    await resetSessionFile(path)
    expect(await loadSessionFile(path)).toBeNull()
  })

  it('does not replace an unchanged saved session', async () => {
    const path = await statePath()
    const temporary = `${path}.tmp`
    await saveSessionFile(path, persistedSession)
    await writeFile(temporary, 'left by an interrupted older save')

    await saveSessionFile(path, persistedSession)
    expect(await readFile(temporary, 'utf8')).toBe('left by an interrupted older save')

    await saveSessionFile(path, { ...persistedSession, playhead: 2 })
    expect((await loadSessionFile(path))?.playhead).toBe(2)
    expect(await readFile(temporary, 'utf8')).toBe('left by an interrupted older save')
  })

  it('uses independent temporary files for concurrent saves', async () => {
    const path = await statePath()
    const first = { ...persistedSession, playhead: 0 }
    const second = { ...persistedSession, playhead: 2 }
    await Promise.all([saveSessionFile(path, first), saveSessionFile(path, second)])

    expect([first.playhead, second.playhead]).toContain((await loadSessionFile(path))?.playhead)
    expect(await readdir(dirname(path))).toEqual(['editor-state.json'])
  })

  it('cleans a unique temporary file when writing fails', async () => {
    const path = await statePath()
    await saveSessionFile(path, persistedSession)
    fsPromiseMock.writeFile.mockImplementationOnce((temporary: string) => {
      writeFileSync(temporary, '{"partial":')
      throw new Error('disk full')
    })

    await expect(saveSessionFile(path, { ...persistedSession, playhead: 2 })).rejects.toThrow('disk full')
    expect(await loadSessionFile(path)).toEqual(persistedSession)
    expect(await readdir(dirname(path))).toEqual(['editor-state.json'])
  })

  it('ignores missing, malformed, and invalid state', async () => {
    const path = await statePath()
    expect(await loadSessionFile(path)).toBeNull()
    await saveSessionFile(path, persistedSession)
    await writeFile(path, '{')
    expect(await loadSessionFile(path)).toBeNull()
    await expect(saveSessionFile(path, { ...persistedSession, playhead: 99 })).rejects.toThrow('Playhead')
  })
})
