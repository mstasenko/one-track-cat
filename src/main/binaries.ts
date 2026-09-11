import { app } from 'electron'
import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'

const systemFfmpegPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'] as const

function executablePath(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function hardwareFfmpegCandidates(): string[] {
  if (app.isPackaged) {
    return [...new Set([join(process.resourcesPath, 'bin', 'ffmpeg'), ...systemFfmpegPaths])]
  }
  const developmentPaths = [
    ...systemFfmpegPaths,
    join(process.cwd(), 'dist', 'ffmpeg-vaapi', 'ffmpeg'),
    join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
  ]
  return [...new Set(developmentPaths)]
}

export function ffmpegPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'bin', 'ffmpeg')
  const candidates = hardwareFfmpegCandidates()
  return candidates.find(executablePath) ?? join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
}

export function ffprobePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'ffprobe')
    : join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe')
}

export function sidecarMemePath(executablePath: string, appImagePath?: string): string {
  return join(dirname(appImagePath ?? executablePath), 'meme')
}

export function bundledMemePath(): string {
  if (!app.isPackaged) return join(process.cwd(), 'dist', 'meme-pack')
  return sidecarMemePath(app.getPath('exe'), process.env.APPIMAGE)
}
