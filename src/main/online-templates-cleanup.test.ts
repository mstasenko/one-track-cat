import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearOnlineTemplateCache } from './online-templates'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Online template cleanup', () => {
  it('clears generated imports and stale temps without touching unrelated files or symlinks', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'otc-online-clear-'))
    directories.push(userData)
    const directory = join(userData, 'online-templates')
    await mkdir(directory)
    const uuid = '00000000-0000-0000-0000-000000000000'
    await writeFile(join(directory, 'memefact-321.jpg'), 'imported')
    await writeFile(join(directory, `.imgflip-123.mp4.${uuid}.tmp`), 'stale')
    await writeFile(join(directory, 'keep.mp4'), 'keep')
    const outside = join(userData, 'outside.mp4')
    await writeFile(outside, 'outside')
    await symlink(outside, join(directory, 'wikimedia-52.ogg'))

    await clearOnlineTemplateCache(userData)

    await expect(readFile(join(directory, 'memefact-321.jpg'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(directory, `.imgflip-123.mp4.${uuid}.tmp`))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(directory, 'keep.mp4'), 'utf8')).resolves.toBe('keep')
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside')
    await expect(readFile(join(directory, 'wikimedia-52.ogg'), 'utf8')).resolves.toBe('outside')
  })
})
