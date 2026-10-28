import { app } from 'electron'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { clearFaceDetectionCache } from './face-detection-cache'
import { hasActiveFaceExports } from './face-process'
import { clearFacePreview } from './face-preview-cache'
import { isFacePreviewRendering } from './face-preview'
import { hasActiveJobs } from './jobs'

const cacheDirectoryName = 'face-preview'
const previewFilePattern = /^preview.*\.(?:mp4|json)$/
const detectionCacheFiles = new Set(['detections.cache', 'detections.cache.json'])
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const previewTemporaryPattern = new RegExp(`^preview(?:-[0-9]+-[0-9]+)?\\.(?:mp4|json)\\.${uuidPattern}\\.tmp$`)
const detectionTemporaryPattern = new RegExp(`^detections\\.cache\\.json\\.${uuidPattern}\\.tmp$`)
const detectionJobDirectoryPattern = /^detections-job-[A-Za-z0-9]+$/

function cacheDirectory(): string | undefined {
  try {
    const userData = app.getPath('userData')
    return userData ? join(userData, cacheDirectoryName) : undefined
  } catch {
    return undefined
  }
}

function isKnownCacheFile(name: string): boolean {
  return previewFilePattern.test(name) || detectionCacheFiles.has(name)
    || previewTemporaryPattern.test(name) || detectionTemporaryPattern.test(name)
}

interface CacheEntry {
  path: string
  recursive: boolean
}

async function cacheEntries(directory: string): Promise<CacheEntry[]> {
  try {
    // Refuse a substituted/symlinked cache directory so cleanup cannot traverse outside
    // the app-owned face-preview directory.
    const directoryStat = await lstat(directory)
    if (!directoryStat.isDirectory()) return []
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .flatMap((entry): CacheEntry[] => {
        if (entry.isDirectory() && detectionJobDirectoryPattern.test(entry.name)) {
          return [{ path: join(directory, entry.name), recursive: true }]
        }
        // Atomic preview publication uses a temporary symlink. Removing only
        // the exact generated name is safe and never follows it.
        if ((entry.isFile() || entry.isSymbolicLink()) && isKnownCacheFile(entry.name)) {
          return [{ path: join(directory, entry.name), recursive: false }]
        }
        return []
      })
  } catch {
    return []
  }
}

/**
 * Discard persisted face-preview media and detector rows for a new project.
 * Active face work owns these files until it finishes, so cleanup is deliberately a no-op
 * while a preview or face export is running.
 */
export async function clearFaceCache(): Promise<void> {
  if (isFacePreviewRendering() || hasActiveFaceExports() || hasActiveJobs()) return

  clearFacePreview()
  clearFaceDetectionCache()
  const directory = cacheDirectory()
  if (!directory) return
  const entries = await cacheEntries(directory)
  await Promise.all(entries.map(({ path, recursive }) =>
    rm(path, { force: true, recursive }).catch(() => undefined)))
}
