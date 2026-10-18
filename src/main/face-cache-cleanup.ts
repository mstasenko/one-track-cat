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
}

async function cacheFiles(directory: string): Promise<string[]> {
  try {
    // Refuse a substituted/symlinked cache directory so cleanup cannot traverse outside
    // the app-owned face-preview directory.
    const directoryStat = await lstat(directory)
    if (!directoryStat.isDirectory()) return []
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && isKnownCacheFile(entry.name))
      .map((entry) => join(directory, entry.name))
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
  const files = await cacheFiles(directory)
  await Promise.all(files.map(async (path) => {
    await rm(path, { force: true }).catch(() => undefined)
  }))
}
