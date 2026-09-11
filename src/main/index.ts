import { dirname, join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell
} from 'electron'
import packageMetadata from '../../package.json'
import type {
  ExportRequest,
  GpuDiagnostics,
  MediaMetadata,
  Overlay,
  SavedSession,
  SavedSessionSnapshot
} from '../types'
import { assetExtensions, categoryFor, displayName, mediaExtensions, scanAssets } from './assets'
import { exportVideo } from './exporter'
import { jobs } from './jobs'
import {
  createProxy,
  probeAsset,
  probeMedia,
  shutdownProxyJobs,
  waveformFor
} from './media'
import { mediaResponse, mediaUrl } from './media-protocol'
import { installDesktopIntegration } from './desktop'
import { loadSessionFile, resetSessionFile, saveSessionFile } from './session-state'
import { SessionPathRegistry } from './path-registry'
import { svgDataUrl } from './svg'
import {
  parseDefaultName,
  parseExportRequest,
  parseJobId,
  parseMediaMetadata,
  parsePath,
  parseSavedSession
} from './validation'
import { referencedExportSources } from '../export-sources'
import { facePackStatus } from './face-pack'
import { previewFaces, restoreFaces } from './face-preview'
import { cancelFaceExport, shutdownFaceExports } from './face-process'
import { initialVideoDirectory, listVideoDirectory } from './video-picker'
import { importTemplate, searchTemplates, templatePage } from './online-templates'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

app.setName('OneTrackCat')
if (process.env.otc_CPU_ONLY === '1') app.disableHardwareAcceleration()
app.setDesktopName('OneTrackCat.desktop')
app.commandLine.appendSwitch('ozone-platform', 'wayland')
app.commandLine.appendSwitch('enable-features', 'AcceleratedVideoDecodeLinuxZeroCopyGL')
const headlessTest = !app.isPackaged && process.env.otc_HEADLESS_TEST === '1'
const compactTest = headlessTest && process.env.otc_E2E_COMPACT === '1'
const forceGpuOff = headlessTest && process.env.otc_E2E_GPU_OFF === '1'
const testVideoPath = headlessTest ? process.env.otc_E2E_VIDEO : undefined
const testMediaPath = headlessTest ? process.env.otc_E2E_MEDIA : undefined
const testOutputPath = headlessTest ? process.env.otc_E2E_OUTPUT : undefined
const rendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
if (headlessTest) {
  // Headless GNOME reports mapped windows as occluded. Keep Chromium's frame
  // clock active so media and UI updates keep rendering during automation.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}

function startupVideo(): string | undefined {
  return process.argv.find((argument, index) =>
    index > 0 && categoryFor(argument) === 'video'
  )
}

function closeFailureDetail(value: unknown): string {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, 2000)
    : 'Check the available disk space and folder permissions, then try again.'
}

function gpuDiagnostics(): GpuDiagnostics {
  const status = app.getGPUFeatureStatus()
  return {
    hardwareAcceleration: forceGpuOff ? false : app.isHardwareAccelerationEnabled(),
    videoDecode: forceGpuOff ? 'disabled_off' : status.video_decode,
    gpuCompositing: forceGpuOff ? 'disabled_off' : status.gpu_compositing
  }
}

function createWindow(paths: SessionPathRegistry, requestedPath?: string): BrowserWindow {
  const windowSize = compactTest ? { width: 1100, height: 720 } : { width: 1500, height: 940 }
  const windowIcon = app.isPackaged
    ? join(process.resourcesPath, 'resources', 'icon.png')
    : join(__dirname, '../../src/icon.png')
  const window = new BrowserWindow({
    ...windowSize,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: '#101114',
    icon: windowIcon,
    show: false,
    title: 'OneTrackCat',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: !headlessTest
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'Project',
    submenu: [
      { label: `OneTrackCat ${packageMetadata.version}`, enabled: false },
      { type: 'separator' },
      { label: 'Reset project', click: () => window.webContents.send('project:reset-request') }
    ]
  }]))
  let closeReady = false
  let savePending = false
  const requestCloseSave = (): void => {
    if (savePending) return
    savePending = true
    window.webContents.send('session:save-request')
  }
  window.on('close', (event) => {
    if (closeReady) return
    event.preventDefault()
    requestCloseSave()
  })
  const onCloseReady = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== window.webContents) return
    closeReady = true
    window.close()
  }
  ipcMain.on('session:close-ready', onCloseReady)
  const applyCloseChoice = (response: number): void => {
    if (response === 2) {
      closeReady = true
      window.close()
      return
    }
    savePending = false
    if (response === 0) requestCloseSave()
  }
  const onCloseFailed = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (event.sender !== window.webContents) return
    if (!savePending) return
    const response = dialog.showMessageBoxSync(window, {
      type: 'error',
      title: 'Could not save project',
      message: 'Could not save project',
      detail: closeFailureDetail(value),
      buttons: ['Retry', 'Cancel close', 'Close without saving'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    applyCloseChoice(response)
  }
  ipcMain.on('session:close-failed', onCloseFailed)
  window.once('closed', () => {
    ipcMain.removeListener('session:close-ready', onCloseReady)
    ipcMain.removeListener('session:close-failed', onCloseFailed)
  })

  const renderer = rendererUrl
    ? window.loadURL(rendererUrl)
    : window.loadFile(join(__dirname, '../renderer/index.html'))
  void renderer.catch((error: unknown) => console.error('Renderer failed to load:', error))
  if (requestedPath) {
    window.webContents.once('did-finish-load', () => {
      void paths.allowRead(resolve(requestedPath))
        .then((path) => window.webContents.send('app:open-path', path))
        .catch(() => undefined)
    })
  }
  return window
}

async function authorizedAssets(paths: SessionPathRegistry): Promise<Awaited<ReturnType<typeof scanAssets>>> {
  const assets = await scanAssets()
  const authorized = await Promise.all(assets.map(async (asset) => {
    try {
      return { ...asset, path: await paths.allowRead(asset.path) }
    } catch {
      return null
    }
  }))
  return authorized.filter((asset) => asset !== null)
}

function authorizeOverlay(overlay: Overlay, paths: SessionPathRegistry): Overlay {
  if (overlay.type === 'text') return overlay
  return { ...overlay, path: paths.assertReadable(overlay.path) }
}

async function trustedExport(value: unknown, paths: SessionPathRegistry): Promise<ExportRequest> {
  const supplied = parseExportRequest(value)
  const liveSources = referencedExportSources(supplied.sources, supplied.segments)
  const sources = await Promise.all(liveSources.map(async (source) => ({
    id: source.id,
    metadata: await probeMedia(paths.assertReadable(source.metadata.path))
  })))
  const request = parseExportRequest({
    ...supplied,
    sources
  })
  return {
    ...request,
    outputPath: paths.assertWritable(request.outputPath),
    overlays: request.overlays.map((overlay) => authorizeOverlay(overlay, paths))
  }
}

function statePath(): string {
  return join(app.getPath('userData'), 'editor-state.json')
}

function authorizeSavedSnapshot(snapshot: SavedSessionSnapshot, paths: SessionPathRegistry): void {
  snapshot.sources.forEach((source) => paths.assertReadable(source.metadata.path))
  snapshot.overlays.forEach((overlay) => authorizeOverlay(overlay, paths))
}

function authorizedSessionStack(
  snapshots: SavedSessionSnapshot[] | undefined,
  paths: SessionPathRegistry
): SavedSessionSnapshot[] {
  return (snapshots ?? []).filter((snapshot) => {
    try {
      authorizeSavedSnapshot(snapshot, paths)
      return true
    } catch {
      return false
    }
  })
}

function authorizeSavedSession(session: SavedSession, paths: SessionPathRegistry): SavedSession {
  authorizeSavedSnapshot(session, paths)
  return {
    ...session,
    history: authorizedSessionStack(session.history, paths),
    future: authorizedSessionStack(session.future, paths)
  }
}

async function saveSession(value: unknown, paths: SessionPathRegistry): Promise<void> {
  const session = authorizeSavedSession(parseSavedSession(value), paths)
  await saveSessionFile(statePath(), session)
}

async function loadSession(paths: SessionPathRegistry): Promise<SavedSession | null> {
  try {
    const saved = await loadSessionFile(statePath())
    if (!saved) return null
    const metadata = new Map<string, Promise<MediaMetadata>>()
    const gifPlaybackPaths = new Map<string, Promise<string | undefined>>()
    const session = await refreshSavedSnapshot(saved, paths, metadata, gifPlaybackPaths)
    const [history, future] = await Promise.all([
      refreshSessionStack(saved.history, paths, metadata, gifPlaybackPaths),
      refreshSessionStack(saved.future, paths, metadata, gifPlaybackPaths)
    ])
    return parseSavedSession({ ...session, history, future })
  } catch {
    return null
  }
}

async function refreshSavedSnapshot(
  snapshot: SavedSessionSnapshot,
  paths: SessionPathRegistry,
  metadata: Map<string, Promise<MediaMetadata>>,
  gifPlaybackPaths: Map<string, Promise<string | undefined>>
): Promise<SavedSessionSnapshot> {
  const sources = await Promise.all(snapshot.sources.map(async (source) => {
    let refreshed = metadata.get(source.metadata.path)
    if (!refreshed) {
      refreshed = paths.allowRead(source.metadata.path).then(probeMedia)
      metadata.set(source.metadata.path, refreshed)
    }
    return { id: source.id, metadata: await refreshed }
  }))
  const overlays = await Promise.all(snapshot.overlays.map(async (overlay) => {
    if (overlay.type === 'text') return overlay
    const path = await paths.allowRead(overlay.path)
    if (overlay.type !== 'gif') return { ...overlay, path }
    let playbackPath = gifPlaybackPaths.get(path)
    if (!playbackPath) {
      playbackPath = trustedAssetMetadata(path, paths).then((item) => item.playbackPath)
      gifPlaybackPaths.set(path, playbackPath)
    }
    return { ...overlay, path, playbackPath: await playbackPath }
  }))
  return { ...snapshot, sources, overlays }
}

async function refreshSessionStack(
  snapshots: SavedSessionSnapshot[] | undefined,
  paths: SessionPathRegistry,
  metadata: Map<string, Promise<MediaMetadata>>,
  gifPlaybackPaths: Map<string, Promise<string | undefined>>
): Promise<SavedSessionSnapshot[]> {
  const restored = await Promise.all((snapshots ?? []).map(async (snapshot) => {
    try {
      return await refreshSavedSnapshot(snapshot, paths, metadata, gifPlaybackPaths)
    } catch {
      // A missing file used only by an old undo entry must not hide the current project.
      return null
    }
  }))
  return restored.filter((snapshot): snapshot is SavedSessionSnapshot => snapshot !== null)
}

async function trustedAssetMetadata(path: string, paths: SessionPathRegistry): Promise<Awaited<ReturnType<typeof probeAsset>>> {
  const metadata = await probeAsset(path)
  if (categoryFor(path) !== 'gif') return metadata
  const proxyPath = await createProxy(await probeMedia(path))
  return { ...metadata, playbackPath: await paths.allowRead(proxyPath) }
}

function registerIpc(
  directories: { open: string; export: string; media: string },
  paths: SessionPathRegistry,
  requestedPath?: string
): void {
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
  ipcMain.handle('video:list', async (_event, value: unknown) => {
    const directory = value === undefined ? directories.open : parsePath(value)
    const result = await listVideoDirectory(directory)
    directories.open = result.path
    return result
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
  ipcMain.handle('dialog:export-path', async (_event, value: unknown) => {
    const defaultName = parseDefaultName(value)
    if (testOutputPath) return paths.allowWrite(testOutputPath)
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
  ipcMain.handle('media:authorize-drop', async (_event, value: unknown) => {
    const path = parsePath(value)
    if (categoryFor(path) !== 'video') throw new Error('Only video files can be opened here')
    return paths.allowRead(path)
  })
  ipcMain.handle('media:probe', async (_event, value: unknown) =>
    parseMediaMetadata(await probeMedia(paths.assertReadable(parsePath(value)))))
  ipcMain.handle('media:probe-asset', (_event, value: unknown) => {
    const path = paths.assertReadable(parsePath(value))
    return trustedAssetMetadata(path, paths)
  })
  ipcMain.handle('media:waveform', (_event, value: unknown) => waveformFor(paths.assertReadable(parsePath(value))))
  ipcMain.handle('media:url', (_event, value: unknown) => mediaUrl(paths.assertReadable(parsePath(value))))
  ipcMain.handle('media:svg-data', (_event, value: unknown) => svgDataUrl(paths.assertReadable(parsePath(value))))
  ipcMain.handle('assets:scan', () => authorizedAssets(paths))
  ipcMain.handle('templates:search', (_event, source: unknown, category: unknown, query: unknown) =>
    searchTemplates(source, category, query))
  ipcMain.handle('templates:import', async (_event, source: unknown, id: unknown) => {
    const asset = await importTemplate(source, id, join(app.getPath('userData'), 'online-templates'))
    return { ...asset, path: await paths.allowRead(asset.path) }
  })
  ipcMain.handle('templates:open-page', (_event, source: unknown, id: unknown) =>
    shell.openExternal(templatePage(source, id)))
  ipcMain.handle('faces:pack-status', facePackStatus)
  ipcMain.handle('faces:preview', (_event, value: unknown) => previewFaces(value, paths, trustedExport))
  ipcMain.handle('faces:restore', (_event, value: unknown) => restoreFaces(value, paths, trustedExport))
  ipcMain.handle('session:load', () => requestedPath ? null : loadSession(paths))
  ipcMain.handle('session:save', (_event, value: unknown) => saveSession(value, paths))
  ipcMain.handle('session:reset', () => resetSessionFile(statePath()))
  ipcMain.handle('export:start', async (_event, value: unknown) => {
    try {
      await exportVideo(await trustedExport(value, paths))
    } catch (error) {
      // Cancellation is an expected user action; the exporter has already removed its partial file.
      if (error instanceof Error && error.message === 'Job cancelled') return
      throw error
    }
  })
  ipcMain.handle('job:cancel', (_event, value: unknown) => {
    const id = parseJobId(value)
    return cancelFaceExport(id) || jobs.cancel(id)
  })
  ipcMain.handle('gpu:diagnostics', gpuDiagnostics)
}

async function startApplication(): Promise<void> {
  if (process.env.XDG_SESSION_TYPE !== 'wayland' || !process.env.WAYLAND_DISPLAY) {
    dialog.showErrorBox(
      'OneTrackCat requires GNOME Wayland',
      'Start OneTrackCat from an Ubuntu 26 GNOME Wayland desktop session.'
    )
    app.quit()
    return
  }
  if (process.env.APPIMAGE) {
    const dataHome = process.env.XDG_DATA_HOME ?? join(app.getPath('home'), '.local', 'share')
    await installDesktopIntegration({
      appImagePath: process.env.APPIMAGE,
      resourcesPath: process.resourcesPath,
      dataHome
    }).catch((error: unknown) => console.warn('Desktop integration unavailable:', error))
  }
  const paths = new SessionPathRegistry()
  protocol.handle('media', (request) => mediaResponse(request, (path) => paths.canRead(path)))
  const requestedPath = startupVideo()
  const downloads = app.getPath('downloads')
  const videos = app.getPath('videos')
  registerIpc({
    open: initialVideoDirectory(requestedPath, videos),
    export: videos,
    media: downloads
  }, paths, requestedPath)
  createWindow(paths, requestedPath)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(paths, requestedPath)
  })
}

void app.whenReady().then(startApplication).catch((error: unknown) => {
  console.error('OneTrackCat failed to start:', error)
  app.quit()
})

let shutdownStarted = false
let shutdownComplete = false
app.on('before-quit', (event) => {
  if (shutdownComplete) return
  // Let the existing window close/save handshake run first. Electron may emit
  // before-quit before it asks a window whether it is ready to close.
  if (BrowserWindow.getAllWindows().length > 0) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  void Promise.all([shutdownProxyJobs(), jobs.shutdown(), shutdownFaceExports()]).then(
    () => {
      shutdownComplete = true
      app.quit()
    },
    (error: unknown) => {
      console.error('OneTrackCat shutdown failed:', error)
      shutdownComplete = true
      app.quit()
    }
  )
})

app.on('window-all-closed', () => app.quit())
