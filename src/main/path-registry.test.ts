import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionPathRegistry } from './path-registry'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('session path registry', () => {
  it('allows only files and destinations selected during this session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-paths-'))
    temporaryDirectories.push(directory)
    const source = join(directory, 'source.mp4')
    await writeFile(source, 'video')
    const registry = new SessionPathRegistry()

    expect(() => registry.assertReadable(source)).toThrow('not authorized')
    expect(await registry.allowRead(source)).toBe(source)
    expect(registry.assertReadable(source)).toBe(source)

    const output = join(directory, 'edited.mp4')
    expect(() => registry.assertWritable(output)).toThrow('not authorized')
    expect(await registry.allowWrite(output)).toBe(output)
    expect(registry.assertWritable(output)).toBe(output)
  })

  it('rejects relative paths and directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-paths-'))
    temporaryDirectories.push(directory)
    const registry = new SessionPathRegistry()
    await expect(registry.allowRead(directory)).rejects.toThrow('not a file')
    await expect(registry.allowRead('video.mp4')).rejects.toThrow('absolute')
    expect(registry.canRead('/not/selected.mp4')).toBe(false)
  })

  it('authorizes the canonical target rather than a replaceable symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otc-paths-'))
    temporaryDirectories.push(directory)
    const source = join(directory, 'source.mp4')
    const link = join(directory, 'selected.mp4')
    await writeFile(source, 'video')
    await symlink(source, link)
    const registry = new SessionPathRegistry()
    expect(await registry.allowRead(link)).toBe(source)
    expect(registry.assertReadable(source)).toBe(source)
    expect(() => registry.assertReadable(link)).toThrow('not authorized')
  })
})
