import { app } from 'electron'
import { dirname, join } from 'node:path'

/** Optional runtimes live beside the executable, not inside the replaceable AppImage. */
export function optionalPackDirectory(name: 'upscale' | 'face' | 'voice'): string {
  const root = app.isPackaged ? dirname(process.env.APPIMAGE ?? app.getPath('exe')) : join(process.cwd(), 'dist')
  return join(root, `${name}-pack`)
}
