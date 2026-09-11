import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  animatedAssets,
  audioAssets,
  catalogFingerprint,
  catalogVersion,
  imageAssets
} from './meme-catalog.mjs'

const root = resolve(import.meta.dirname, '..', 'dist', 'meme-pack')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const expectedCounts = {
  image: imageAssets.length,
  video: animatedAssets.length,
  audio: audioAssets.length
}

function fail(message) {
  throw new Error(`Media pack verification failed: ${message}`)
}

if (manifest.version !== catalogVersion || manifest.catalogFingerprint !== catalogFingerprint) {
  fail('manifest does not match the current catalog')
}

for (const [category, expected] of Object.entries(expectedCounts)) {
  const files = readdirSync(join(root, category))
  if (expected < 20 || expected > 100) fail(`${category} has ${expected} catalog entries`)
  if (files.length !== expected) fail(`${category} contains ${files.length} files instead of ${expected}`)
  if (manifest.categoryCounts[category] !== expected) fail(`${category} manifest count is incorrect`)
}

if (manifest.assets.length !== Object.values(expectedCounts).reduce((sum, count) => sum + count, 0)) {
  fail('manifest asset count is incorrect')
}
if (existsSync(join(root, 'gif'))) fail('duplicate GIF category still exists')
for (const entry of manifest.assets) {
  if (!entry.author || !entry.license || !entry.source?.startsWith('https://commons.wikimedia.org/wiki/File:')) {
    fail(`missing provenance for ${entry.path}`)
  }
  if (!existsSync(join(root, entry.path))) fail(`missing ${entry.path}`)
}

const imageNames = readdirSync(join(root, 'image'))
if (imageNames.some((name) => /six.?seven|this is fine|moon salute|nasa dance|space soda|zero gravity/i.test(name))) {
  fail('generated or reaction-frame still found in image category')
}
