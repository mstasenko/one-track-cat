import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const release = 'autobuild-2026-07-31-14-10'
const archiveName = 'ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1.tar.xz'
const archiveDirectory = 'ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1'
const expectedHash = '09fc77be269c7053e438b7e96548e4af97604faf96a42c4a3c56a1ad74c22c0a'
const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${release}/${archiveName}`
const projectRoot = resolve(import.meta.dirname, '..')
const cacheRoot = join(projectRoot, 'dist', 'ffmpeg-cache')
const outputRoot = join(projectRoot, 'dist', 'ffmpeg-vaapi')
const archivePath = join(cacheRoot, archiveName)
const binaryPath = join(outputRoot, 'ffmpeg')

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function downloadArchive() {
  if (existsSync(archivePath) && digest(archivePath) === expectedHash) return
  const response = await fetch(url, { headers: { 'User-Agent': 'OneTrackCat release builder' } })
  if (!response.ok) throw new Error(`FFmpeg download failed: HTTP ${response.status}`)
  writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()))
  if (digest(archivePath) !== expectedHash) throw new Error('FFmpeg download checksum mismatch')
}

function extractBundle() {
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })
  execFileSync('tar', [
    '-xJf', archivePath, '--strip-components=2', '-C', outputRoot,
    `${archiveDirectory}/bin/ffmpeg`
  ])
  execFileSync('tar', [
    '-xJf', archivePath, '--strip-components=1', '-C', outputRoot,
    `${archiveDirectory}/LICENSE.txt`
  ])
  chmodSync(binaryPath, 0o755)
  writeFileSync(join(outputRoot, 'SOURCE.txt'), [
    `Binary: ${url}`,
    'Build scripts: https://github.com/BtbN/FFmpeg-Builds',
    'FFmpeg source: https://github.com/FFmpeg/FFmpeg/commit/9b6c8969e0',
    ''
  ].join('\n'))
}

function verifyBundle() {
  const encoders = execFileSync(binaryPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
  for (const encoder of ['av1_vaapi', 'hevc_vaapi', 'h264_vaapi', 'libx264']) {
    if (!encoders.includes(encoder)) throw new Error(`Bundled FFmpeg lacks ${encoder}`)
  }
}

mkdirSync(cacheRoot, { recursive: true })
await downloadArchive()
extractBundle()
verifyBundle()
process.stdout.write(`Prepared VAAPI-enabled FFmpeg ${archiveName}\n`)
