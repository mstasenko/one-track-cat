import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

function absolutePath(path: string): string {
  if (!path || !isAbsolute(path)) throw new Error('An absolute file path is required')
  return resolve(path)
}

export class SessionPathRegistry {
  private readonly readable = new Set<string>()
  private readonly writable = new Set<string>()

  async allowRead(path: string): Promise<string> {
    const requested = absolutePath(path)
    const canonical = await realpath(requested)
    if (!(await stat(canonical)).isFile()) throw new Error('The selected path is not a file')
    this.readable.add(canonical)
    return canonical
  }

  async allowWrite(path: string): Promise<string> {
    const requested = absolutePath(path)
    const parent = await realpath(dirname(requested))
    const canonical = join(parent, basename(requested))
    this.writable.add(canonical)
    return canonical
  }

  assertReadable(path: string): string {
    const requested = absolutePath(path)
    if (!this.readable.has(requested)) throw new Error('This file is not authorized for this session')
    return requested
  }

  assertWritable(path: string): string {
    const requested = absolutePath(path)
    if (!this.writable.has(requested)) throw new Error('This destination is not authorized for this session')
    return requested
  }

  canRead(path: string): boolean {
    try {
      return this.readable.has(absolutePath(path))
    } catch {
      return false
    }
  }
}
