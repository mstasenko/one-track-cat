import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import {
  animatedAssets,
  audioAssets,
  catalogFingerprint,
  catalogVersion,
  imageAssets
} from './meme-catalog.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const distRoot = join(projectRoot, 'dist')
const cacheRoot = join(distRoot, 'media-cache')
const outputRoot = join(distRoot, 'meme-pack')
const archivePath = join(distRoot, 'otc-media-pack.zip')
const ffmpeg = join(projectRoot, 'node_modules', 'ffmpeg-static', 'ffmpeg')

function digest(path, algorithm) {
  return createHash(algorithm).update(readFileSync(path)).digest('hex')
}

function extension(asset) {
  return extname(new URL(asset.url).pathname).toLowerCase()
}

function cachePath(asset) {
  return join(cacheRoot, `${asset.id}${extension(asset)}`)
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function download(asset) {
  const path = cachePath(asset)
  if (existsSync(path) && digest(path, asset.algorithm) === asset.hash) return path
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(asset.url, {
      headers: { 'User-Agent': 'OneTrackCat media pack builder (https://github.com/mstasenko/one-track-cat)' }
    })
    if (response.ok) {
      writeFileSync(path, Buffer.from(await response.arrayBuffer()))
      if (digest(path, asset.algorithm) !== asset.hash) throw new Error(`Checksum mismatch for ${asset.id}`)
      return path
    }
    if (response.status !== 429 || attempt === 4) {
      throw new Error(`Download failed for ${asset.id}: HTTP ${response.status}`)
    }
    await delay(attempt * 2_000)
  }
  throw new Error(`Download failed for ${asset.id}`)
}

function convertGifToVideo(source, destination) {
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p', '-an', destination
  ])
}

function resizeImage(source, destination, width) {
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-vf', `scale=${width}:-2:force_original_aspect_ratio=decrease`, '-frames:v', '1', destination
  ])
}

function manifestEntry(asset, path, conversion) {
  return {
    path,
    author: asset.author,
    source: asset.page,
    license: asset.license,
    ...(conversion ? { conversion } : {})
  }
}

function copyDirect(asset, category, cached, manifest) {
  const relativePath = `${category}/${asset.name}${extension(asset)}`
  copyFileSync(cached.get(asset.id), join(outputRoot, relativePath))
  manifest.assets.push(manifestEntry(asset, relativePath))
}

function addImage(asset, cached, manifest) {
  const relativePath = `image/${asset.name}${extension(asset)}`
  const destination = join(outputRoot, relativePath)
  const resizeWidth = asset.id === 'uncle-sam' ? 1_600 : asset.id === 'iceberg' ? 2_000 : null
  if (resizeWidth) {
    resizeImage(cached.get(asset.id), destination, resizeWidth)
    manifest.assets.push(manifestEntry(asset, relativePath, `Resized to at most ${resizeWidth}px wide by OneTrackCat`))
    return
  }
  copyFileSync(cached.get(asset.id), destination)
  manifest.assets.push(manifestEntry(asset, relativePath))
}

function addAnimation(asset, cached, manifest) {
  const sourcePath = cached.get(asset.id)
  if (extension(asset) === '.gif') {
    const relativePath = `video/${asset.name}.mp4`
    convertGifToVideo(sourcePath, join(outputRoot, relativePath))
    manifest.assets.push(manifestEntry(asset, relativePath, 'Format-converted from the source GIF by OneTrackCat'))
    return
  }
  copyDirect(asset, 'video', cached, manifest)
}

function validateCatalog() {
  const categoryCounts = {
    image: imageAssets.length,
    video: animatedAssets.length,
    audio: audioAssets.length
  }
  for (const [category, count] of Object.entries(categoryCounts)) {
    if (count < 20 || count > 100) throw new Error(`${category} catalog must contain 20–100 assets; found ${count}`)
  }
  const ids = [...imageAssets, ...animatedAssets, ...audioAssets].map((asset) => asset.id)
  if (new Set(ids).size !== ids.length) throw new Error('Media catalog IDs must be unique')
  return categoryCounts
}

const categoryCounts = validateCatalog()
mkdirSync(cacheRoot, { recursive: true })
rmSync(outputRoot, { recursive: true, force: true })
for (const category of Object.keys(categoryCounts)) mkdirSync(join(outputRoot, category), { recursive: true })

const assets = [...imageAssets, ...animatedAssets, ...audioAssets]
const cached = new Map()
for (const asset of assets) cached.set(asset.id, await download(asset))

const manifest = {
  name: 'OneTrackCat Open Media Pack',
  version: catalogVersion,
  catalogFingerprint,
  description: 'Redistributable meme templates, reaction clips, and sound effects with source-level licensing.',
  categoryCounts,
  assets: []
}
for (const asset of imageAssets) addImage(asset, cached, manifest)
for (const asset of animatedAssets) addAnimation(asset, cached, manifest)
for (const asset of audioAssets) copyDirect(asset, 'audio', cached, manifest)

writeFileSync(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const zip = new AdmZip()
zip.addLocalFolder(outputRoot, 'meme')
zip.writeZip(archivePath)
if (!process.argv.includes('--quiet')) {
  process.stdout.write(`Created ${archivePath} with ${manifest.assets.length} licensed assets\n`)
}
