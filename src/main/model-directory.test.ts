import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensurePrivateModelDirectory } from './model-directory'

let root: string
const message = 'Unsafe model directory'
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'otc-model-directory-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('Model directory', () => {
  it('creates private directories and reuses them without changing permissions', async () => {
    const path = join(root, 'models')
    await ensurePrivateModelDirectory(path, message)
    expect((await lstat(path)).mode & 0o777).toBe(0o700)
    await ensurePrivateModelDirectory(path, message)
  })
  it('rejects public directories without repairing permissions', async () => {
    await chmod(root, 0o755)
    await expect(ensurePrivateModelDirectory(root, message)).rejects.toThrow(message)
    expect((await lstat(root)).mode & 0o777).toBe(0o755)
  })
  it('rejects symlinks and files without modifying their targets', async () => {
    await symlink(root, join(root, 'link'))
    await expect(ensurePrivateModelDirectory(join(root, 'link'), message)).rejects.toThrow(message)
    await writeFile(join(root, 'file'), 'unchanged')
    await expect(ensurePrivateModelDirectory(join(root, 'file'), message)).rejects.toThrow(message)
    await expect(ensurePrivateModelDirectory(join(root, 'file', 'child'), message)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
  it('rejects directories owned by another user', async () => {
    await mkdir(join(root, 'models'), { mode: 0o700 })
    vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1)
    await expect(ensurePrivateModelDirectory(join(root, 'models'), message)).rejects.toThrow(message)
  })
})
