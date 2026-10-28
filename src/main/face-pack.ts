import { app } from 'electron'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readModelManifest } from './model-download'
import { optionalPackDirectory } from './optional-pack'

export interface FacePack { executable: string; model: string; catalog?: string }

export function facePackDirectory(): string {
  return optionalPackDirectory('face')
}

export async function requireFacePack(directory = facePackDirectory()): Promise<FacePack> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object' || !('format' in manifest) || manifest.format !== 1) {
      throw new Error('Unsupported face pack format')
    }
    const executable = join(directory, 'otc-face-blur')
    await access(executable, constants.X_OK)
    const catalog = join(directory, 'sources.json')
    // New packs need only their runtime/catalog to enable the effect. Model
    // downloads happen inside the cancellable Apply/Export job, never a status check.
    if (await access(catalog).then(() => true, () => false)) {
      const sources = await readModelManifest(catalog)
      if (!sources.modelId.startsWith('retinaface-resnet50-') || sources.artifacts.length !== 2 ||
          !['model.xml', 'model.bin'].every((name) => sources.artifacts.some((item) => item.path === name))) {
        throw new Error('Unsupported face model catalog')
      }
      return { executable, model: join(app.getPath('userData'), 'otc-face-models', sources.modelId, 'model.xml'), catalog }
    }
    const model = join(directory, 'model.xml')
    await Promise.all([
      access(executable, constants.X_OK), access(model, constants.R_OK),
      access(join(directory, 'model.bin'), constants.R_OK)
    ])
    return { executable, model }
  } catch {
    throw new Error('Blur faces requires the optional OneTrackCat face pack. Download otc-face-pack.zip and extract its face-pack folder beside the OneTrackCat AppImage, then try again. In development, place it in dist/face-pack.')
  }
}

export async function facePackStatus(): Promise<{ available: boolean; message: string }> {
  try {
    await requireFacePack()
    return { available: true, message: 'Face pack available. Processing stays on this computer.' }
  } catch (error) {
    return { available: false, message: error instanceof Error ? error.message : 'Face pack unavailable' }
  }
}
