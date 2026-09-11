import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AssetItem,
  AssetMetadata,
  otcApi,
  ExportRequest,
  FacePreviewResult,
  GpuDiagnostics,
  JobProgress,
  MediaMetadata,
  SavedSession
} from './types'
import type { VideoDirectory } from './video-picker'
import type { OnlineTemplate, TemplateCategory, TemplateSource } from './online-templates'

const api: otcApi = {
  openVideo: () => ipcRenderer.invoke('dialog:open-video') as Promise<string | null>,
  listVideoDirectory: (directory?: string) =>
    ipcRenderer.invoke('video:list', directory) as Promise<VideoDirectory>,
  authorizeVideo: (path: string) =>
    ipcRenderer.invoke('media:authorize-drop', path) as Promise<string>,
  searchTemplates: (source: TemplateSource, category: TemplateCategory, query: string) =>
    ipcRenderer.invoke('templates:search', source, category, query) as Promise<OnlineTemplate[]>,
  importTemplate: (source: TemplateSource, id: string) =>
    ipcRenderer.invoke('templates:import', source, id) as Promise<AssetItem>,
  openTemplatePage: (source: TemplateSource, id: string) =>
    ipcRenderer.invoke('templates:open-page', source, id) as Promise<void>,
  openMedia: () => ipcRenderer.invoke('dialog:open-media') as Promise<AssetItem | null>,
  probe: (path: string) => ipcRenderer.invoke('media:probe', path) as Promise<MediaMetadata>,
  probeAsset: (path: string) => ipcRenderer.invoke('media:probe-asset', path) as Promise<AssetMetadata>,
  waveform: (path: string) => ipcRenderer.invoke('media:waveform', path) as Promise<number[]>,
  scanAssets: () => ipcRenderer.invoke('assets:scan') as Promise<AssetItem[]>,
  facePackStatus: () => ipcRenderer.invoke('faces:pack-status') as Promise<{ available: boolean; message: string }>,
  previewFaces: (request: ExportRequest) => ipcRenderer.invoke('faces:preview', request) as Promise<string>,
  restoreFacePreview: (request: ExportRequest) =>
    ipcRenderer.invoke('faces:restore', request) as Promise<FacePreviewResult[]>,
  chooseExportPath: (defaultName: string) =>
    ipcRenderer.invoke('dialog:export-path', defaultName) as Promise<string | null>,
  exportVideo: (request: ExportRequest) =>
    ipcRenderer.invoke('export:start', request) as Promise<void>,
  loadSession: () => ipcRenderer.invoke('session:load') as Promise<SavedSession | null>,
  saveSession: (session: SavedSession) => ipcRenderer.invoke('session:save', session) as Promise<void>,
  resetSession: () => ipcRenderer.invoke('session:reset') as Promise<void>,
  cancelJob: (id: string) => ipcRenderer.invoke('job:cancel', id) as Promise<boolean>,
  getGpuDiagnostics: () => ipcRenderer.invoke('gpu:diagnostics') as Promise<GpuDiagnostics>,
  getPathUrl: (path: string) => ipcRenderer.invoke('media:url', path) as Promise<string>,
  getSvgDataUrl: (path: string) => ipcRenderer.invoke('media:svg-data', path) as Promise<string>,
  getDroppedPath: (file: File) => {
    const path = webUtils.getPathForFile(file)
    return ipcRenderer.invoke('media:authorize-drop', path) as Promise<string>
  },
  onOpenPath: (callback: (path: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, path: string): void => callback(path)
    ipcRenderer.on('app:open-path', listener)
    return () => ipcRenderer.removeListener('app:open-path', listener)
  },
  onResetProject: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('project:reset-request', listener)
    return () => ipcRenderer.removeListener('project:reset-request', listener)
  },
  onJobProgress: (callback: (progress: JobProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: JobProgress): void => callback(progress)
    ipcRenderer.on('job:progress', listener)
    return () => ipcRenderer.removeListener('job:progress', listener)
  },
  onSaveRequest: (callback: () => Promise<void>) => {
    const listener = (): void => {
      void callback()
        .then(() => ipcRenderer.send('session:close-ready'))
        .catch((error: unknown) => ipcRenderer.send(
          'session:close-failed',
          error instanceof Error ? error.message : String(error)
        ))
    }
    ipcRenderer.on('session:save-request', listener)
    return () => ipcRenderer.removeListener('session:save-request', listener)
  }
}

contextBridge.exposeInMainWorld('otc', api)
