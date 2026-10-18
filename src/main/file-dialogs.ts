import { dirname, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { dialog, ipcMain } from 'electron'
import { assetExtensions, categoryFor, displayName, mediaExtensions } from './assets'
import type { SessionPathRegistry } from './path-registry'
import { parseDefaultName, parsePath } from './validation'

interface FileDirectories { open: string; export: string; media: string }
interface TestFilePaths { video?: string; media?: string; output?: string }

async function authorizeExportDestination(
  destination: string, defaultName: string, directories: FileDirectories, paths: SessionPathRegistry
): Promise<string> {
  try {
    if ((await stat(destination)).isDirectory()) destination = join(destination, defaultName)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  const path = await paths.allowWrite(destination)
  directories.export = dirname(path)
  return path
}

export function registerFileDialogs(
  directories: FileDirectories, paths: SessionPathRegistry, test: TestFilePaths = {}
): void {
  const { video: testVideoPath, media: testMediaPath, output: testOutputPath } = test
  ipcMain.handle('dialog:open-video', async () => {
    const result = testVideoPath ? { filePaths: [testVideoPath] } : await dialog.showOpenDialog({
      title: 'Open a video',
      defaultPath: directories.open,
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: assetExtensions.video }]
    })
    const selected = testVideoPath ?? result.filePaths[0]
    if (!selected) return null
    const path = await paths.allowRead(selected)
    directories.open = dirname(path)
    return path
  })
  ipcMain.handle('dialog:open-media', async () => {
    const result = testMediaPath
      ? { filePaths: [testMediaPath] }
      : await dialog.showOpenDialog({
          title: 'Add media',
          defaultPath: directories.media,
          properties: ['openFile'],
          filters: [{ name: 'Audio, video, GIF, or image', extensions: mediaExtensions }]
        })
    const selected = testMediaPath ?? result.filePaths[0]
    if (!selected) return null
    const type = categoryFor(selected)
    if (!type) return null
    const path = await paths.allowRead(selected)
    directories.media = dirname(path)
    return { path, type, name: displayName(path) }
  })
  ipcMain.handle('dialog:export-path', async (_event, value: unknown, requestedPath?: unknown) => {
    const defaultName = parseDefaultName(value)
    if (testOutputPath) return paths.allowWrite(testOutputPath)
    if (requestedPath !== undefined) {
      return authorizeExportDestination(parsePath(requestedPath), defaultName, directories, paths)
    }
    const result = await dialog.showSaveDialog({
      title: 'Export edited video',
      defaultPath: join(directories.export, defaultName),
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    })
    if (!result.filePath) return null
    const path = await paths.allowWrite(result.filePath)
    directories.export = dirname(path)
    return path
  })
}
