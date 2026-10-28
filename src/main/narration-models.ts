import { app } from 'electron'
import { createReadStream } from 'node:fs'
import { access, link, lstat, open, readFile, statfs, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadModelManifest, isModelArtifactComplete, missingModelArtifactBytes, modelManifestArtifacts,
  parseModelManifest, type ModelArtifact, type ModelArtifactDownloader, type ModelManifest } from './model-download'
import { isObject } from './model-download-schema'
import type { NarrationProgress } from '../narration-api'
import { ensurePrivateModelDirectory } from './model-directory'

interface Assembly { target: ModelArtifact; parts: ModelArtifact[] }

/** The ordinary pinned downloader handles every file, including resumable chunks.
 * Only the GitHub-oversized file needs a bounded, verified reassembly step. */
export function parseVoiceSources(value: unknown, root: string): { manifest: ModelManifest; assemblies: Assembly[] } {
  if (!isObject(value) || Object.keys(value).some((key) => !['format', 'modelId', 'artifacts', 'assemblies'].includes(key)) ||
      !Array.isArray(value.assemblies) || value.assemblies.length > 8) throw new Error('Invalid voice model catalog')
  const manifest = parseModelManifest({ format: value.format, modelId: value.modelId, artifacts: value.artifacts })
  if (manifest.modelId !== 'otc-voice-models' || manifest.artifacts.some((item) => !/^(whisper|cleanup|voice|separator|vad)\/[A-Za-z0-9_.-]+$/.test(item.path))) {
    throw new Error('Invalid voice model catalog paths')
  }
  const downloads = modelManifestArtifacts(manifest, root)
  const paths = new Map(manifest.artifacts.map((item, index) => [item.path, downloads[index]]))
  const destinations = new Set(paths.keys())
  const assemblies = value.assemblies.map((entry): Assembly => {
    if (!isObject(entry) || Object.keys(entry).some((key) => !['path', 'bytes', 'sha256', 'parts'].includes(key)) ||
        typeof entry.path !== 'string' || !/^(whisper|cleanup|voice|separator|vad)\/[A-Za-z0-9_.-]+$/.test(entry.path) ||
        destinations.has(entry.path) || !Array.isArray(entry.parts) ||
        entry.parts.length < 2 || entry.parts.length > 32) throw new Error('Invalid voice model assembly')
    const path = entry.path
    const parts = entry.parts.map((name, index) => {
      const part = typeof name === 'string' ? paths.get(name) : undefined
      if (!part || name !== `${path}.part${index}`) throw new Error('Invalid voice model assembly part')
      return part
    })
    const first = parts[0]
    if (!first || parts.reduce((sum, part) => sum + part.bytes, 0) !== entry.bytes) throw new Error('Invalid voice model assembly size')
    // Reuse the path/hash/size validator. This URL identifies the first source
    // chunk; the complete target is only verified locally, never downloaded.
    const target = modelManifestArtifacts(parseModelManifest({ format: 1, modelId: manifest.modelId,
      artifacts: [{ path, bytes: entry.bytes, sha256: entry.sha256, url: first.url }] }), root)[0]
    if (!target) throw new Error('Missing voice model target')
    destinations.add(path)
    return { target, parts }
  })
  return { manifest, assemblies }
}

async function assembleModel({ target, parts }: Assembly, signal: AbortSignal,
  progress: (value: NarrationProgress) => void): Promise<void> {
  const temporary = `${target.destination}.assembling`
  const stale = await lstat(temporary).catch(() => undefined)
  if (stale) {
    if (!stale.isFile() || (process.getuid && stale.uid !== process.getuid())) throw new Error('Unsafe partial voice model')
    await unlink(temporary)
  }
  const file = await open(temporary, 'wx', 0o600)
  // The assembly is disposable until its verified hard-link publication. A
  // cancelled stream or checksum failure must not strand it beside the model.
  let copied = 0
  try {
    try {
      for (const part of parts) for await (const chunk of createReadStream(part.destination)) {
        signal.throwIfAborted()
        const data = chunk as Buffer
        for (let offset = 0; offset < data.length;) {
          const { bytesWritten } = await file.write(data, offset, data.length - offset)
          if (!bytesWritten) throw new Error('Could not assemble voice model')
          offset += bytesWritten
        }
        copied += data.length
        progress({ stage: 'Preparing voice model', fraction: copied / target.bytes })
      }
    } finally { await file.close() }
    if (!await isModelArtifactComplete({ ...target, destination: temporary }, signal)) throw new Error('Voice model assembly checksum mismatch')
    signal.throwIfAborted()
    // Publish without replacing an unexpected occupied path or symlink.
    await link(temporary, target.destination)
    // Chunks are disposable only after the complete file is verified/published.
    for (const part of parts) await unlink(part.destination)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

export async function ensureNarrationModels(pack: string, signal: AbortSignal,
  progress: (value: NarrationProgress) => void, options: {
    root?: string; downloader?: ModelArtifactDownloader
  } = {}): Promise<string> {
  signal.throwIfAborted()
  // Keep the qualified development install usable without duplicating models.
  // Newly downloadable packs contain no weights at all.
  const developmentModels = !app.isPackaged && !options.root && await Promise.all([
    'separator/model.bin', 'whisper/openvino_encoder_model.bin', 'cleanup/openvino_language_model.bin', 'voice/openvino_base_lm.bin'
  ].map((path) => access(join(pack, path)).then(() => true, () => false))).then((found) => found.every(Boolean))
  const root = options.root ?? (developmentModels ? pack : join(app.getPath('userData'), 'otc-voice-models'))
  await ensurePrivateModelDirectory(root, 'Voice models need a private, owned directory, not a symlink')
  for (const name of developmentModels ? ['vad'] : ['whisper', 'cleanup', 'voice', 'separator', 'vad']) {
    const path = join(root, name)
    await ensurePrivateModelDirectory(path, 'Unsafe voice model directory')
  }
  const catalog = parseVoiceSources(JSON.parse(await readFile(join(pack, 'sources.json'), 'utf8')), root)
  const manifest = developmentModels
    ? { ...catalog.manifest, artifacts: catalog.manifest.artifacts.filter((item) => item.path.startsWith('vad/')) }
    : catalog.manifest
  const assemblies = developmentModels ? [] : catalog.assemblies
  progress({ stage: 'Checking voice models', fraction: 0 })
  const pending: Assembly[] = []
  const completeParts = new Set<string>()
  for (const assembly of assemblies) {
    if (await isModelArtifactComplete(assembly.target, signal)) assembly.parts.forEach((part) => completeParts.add(part.destination))
    else pending.push(assembly)
  }
  const required = { ...manifest, artifacts: manifest.artifacts.filter((item) => !completeParts.has(join(root, item.path))) }
  const artifacts = required.artifacts.length ? modelManifestArtifacts(required, root) : []
  const missing = await missingModelArtifactBytes(artifacts, signal)
  const reserve = missing + pending.reduce((sum, item) => sum + item.target.bytes, 0) + 512 * 1024 ** 2
  const disk = await statfs(root, { bigint: true })
  if (disk.bavail * disk.bsize < BigInt(reserve)) throw new Error(`Not enough free space for voice models. ${Math.ceil(reserve / 1024 ** 3)} GiB required.`)
  if (required.artifacts.length) await downloadModelManifest(required, root, signal, (value) => progress({
    stage: `${value.phase === 'verifying' ? 'Verifying' : 'Downloading'} voice models: ${Math.floor(value.percent)}%`,
    fraction: value.percent / 100, etaSeconds: value.etaSeconds ?? undefined
  }), options.downloader)
  for (const assembly of pending) await assembleModel(assembly, signal, progress)
  return root
}
