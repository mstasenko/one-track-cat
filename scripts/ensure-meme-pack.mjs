import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  animatedAssets,
  audioAssets,
  catalogFingerprint,
  catalogVersion,
  imageAssets
} from './meme-catalog.mjs'

const root = resolve(import.meta.dirname, '..', 'dist', 'meme-pack')
const expectedAssetCount = imageAssets.length + animatedAssets.length + audioAssets.length

function currentPackExists() {
  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    // Avoid hashing or rebuilding every media file on each dev launch. The catalog
    // fingerprint identifies their pinned inputs; count and existence checks catch
    // interrupted builds while keeping the warm-start check effectively instant.
    return manifest.version === catalogVersion
      && manifest.catalogFingerprint === catalogFingerprint
      && manifest.assets.length === expectedAssetCount
      && manifest.assets.every((asset) => existsSync(join(root, asset.path)))
  } catch {
    return false
  }
}

if (!currentPackExists()) await import('./build-meme-pack.mjs')
