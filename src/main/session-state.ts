import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SavedSession } from '../types'
import { parseSavedSession } from './validation'

export async function loadSessionFile(path: string): Promise<SavedSession | null> {
  try {
    return parseSavedSession(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

export async function saveSessionFile(path: string, value: unknown): Promise<void> {
  const session = parseSavedSession(value)
  const serialized = JSON.stringify(session)
  await mkdir(dirname(path), { recursive: true })
  try {
    if (await readFile(path, 'utf8') === serialized) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, serialized)
    // Same-directory rename prevents a normal shutdown from leaving partial JSON.
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function resetSessionFile(path: string): Promise<void> {
  return rm(path, { force: true })
}
