import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { downloadModelManifest, missingModelArtifactBytes, modelManifestArtifacts, readModelManifest,
  type ModelArtifactDownloader } from './model-download'
import type { FacePack } from './face-pack'
import { runFacePreparation } from './face-process'
import { ensurePrivateModelDirectory } from './model-directory'

/** Model files outlive runtime upgrades and project resets; old bundled packs
 * continue working offline without migrating or copying their weights. */
export async function ensureFaceModels(pack: FacePack, jobId: string, downloader?: ModelArtifactDownloader): Promise<void> {
  if (!pack.catalog) return
  const catalog = pack.catalog
  await runFacePreparation(jobId, async (signal, progress) => {
    const directory = dirname(pack.model)
    for (const path of [dirname(directory), directory]) {
      await ensurePrivateModelDirectory(path, 'Face models need a private, owned directory')
    }
    const manifest = await readModelManifest(catalog)
    const missing = await missingModelArtifactBytes(modelManifestArtifacts(manifest, directory), signal)
    if (missing) {
      const disk = await statfs(directory, { bigint: true })
      if (disk.bavail * disk.bsize < BigInt(missing + 32 * 1024 ** 2)) throw new Error('Not enough free space for face model download')
    }
    await downloadModelManifest(manifest, directory, signal, (value) => progress(
      `${value.phase === 'verifying' ? 'Verifying' : 'Downloading'} face model: ${Math.floor(value.percent)}%`,
      value.percent / 100, value.etaSeconds ?? undefined), downloader)
  })
}
