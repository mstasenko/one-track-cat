import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { AssetItem } from '../types'
import { bundledMemePath } from './binaries'

const categories = ['video', 'audio', 'image', 'gif'] as const
type AssetCategory = (typeof categories)[number]

export const assetExtensions: Record<AssetCategory, string[]> = {
  video: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'svg'],
  gif: ['gif']
}
export const mediaExtensions = Object.values(assetExtensions).flat()

export function categoryFor(path: string): AssetCategory | null {
  const extension = extname(path).slice(1).toLowerCase()
  return categories.find((category) => assetExtensions[category].includes(extension)) ?? null
}

export function displayName(path: string): string {
  const original = basename(path, extname(path))
  const cleaned = original
    .replace(/^\d+[\s._-]*/, '')
    .replaceAll(/[-_]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
  return cleaned || original
}

async function collectFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 3) return []
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const results = await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return collectFiles(path, depth + 1)
      return entry.isFile() ? [path] : []
    }))
    return results.flat()
  } catch {
    return []
  }
}

export async function scanAssets(): Promise<AssetItem[]> {
  const assets: AssetItem[] = []
  for (const path of await collectFiles(bundledMemePath())) {
    const type = categoryFor(path)
    if (!type) continue
    assets.push({ type, name: displayName(path), path })
  }
  return assets.sort((left, right) => left.name.localeCompare(right.name))
}
