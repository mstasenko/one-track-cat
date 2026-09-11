import { opendir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { VideoDirectory, VideoDirectoryEntry } from '../video-picker'
import { categoryFor } from './assets'

export const maxVideoDirectoryEntries = 500
export const maxVideoDirectoryVisited = 10_000

export function initialVideoDirectory(requestedPath: string | undefined, fallbackDirectory: string): string {
  return requestedPath ? dirname(resolve(requestedPath)) : fallbackDirectory
}

function requestedDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw new Error('An absolute video directory path is required')
  return directory
}

function compareNames(left: VideoDirectoryEntry, right: VideoDirectoryEntry): number {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
}

function compareEntries(left: VideoDirectoryEntry, right: VideoDirectoryEntry): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  return compareNames(left, right)
}

export async function listVideoDirectory(directory: string): Promise<VideoDirectory> {
  const canonical = await realpath(requestedDirectory(directory))
  if (!(await stat(canonical)).isDirectory()) throw new Error('The selected path is not a directory')

  const entries: VideoDirectoryEntry[] = []
  let truncated = false
  let visited = 0
  const handle = await opendir(canonical)
  for await (const entry of handle) {
    visited += 1
    if (visited > maxVideoDirectoryVisited) {
      truncated = true
      break
    }
    if (entry.name.startsWith('.')) continue
    const path = join(canonical, entry.name)
    const kind = entry.isDirectory()
      ? 'directory'
      : entry.isFile() && categoryFor(path) === 'video'
        ? 'video'
        : null
    if (!kind) continue
    if (entries.length >= maxVideoDirectoryEntries) {
      truncated = true
      break
    }
    entries.push({ path, name: entry.name, kind })
  }

  entries.sort(compareEntries)
  const parentPath = dirname(canonical)
  return {
    path: canonical,
    parent: parentPath === canonical ? null : parentPath,
    entries,
    truncated
  }
}
