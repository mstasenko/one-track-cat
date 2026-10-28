import { lstat, mkdir } from 'node:fs/promises'

/** Never chmod or follow an occupied path: it may belong to someone else. */
export async function ensurePrivateModelDirectory(directory: string, message: string): Promise<void> {
  let info
  try { info = await lstat(directory) } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    await mkdir(directory, { recursive: true, mode: 0o700 })
    info = await lstat(directory)
  }
  if (!info.isDirectory() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid())) throw new Error(message)
}
