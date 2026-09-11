import { app } from 'electron'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function facePackDirectory(): string {
  return app.isPackaged
    ? join(dirname(process.env.APPIMAGE ?? app.getPath('exe')), 'face-pack')
    : join(process.cwd(), 'dist', 'face-pack')
}

export async function requireFacePack(directory = facePackDirectory()): Promise<{ executable: string; model: string }> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object' || !('format' in manifest) || manifest.format !== 1) {
      throw new Error('Unsupported face pack format')
    }
    const executable = join(directory, 'otc-face-blur')
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
