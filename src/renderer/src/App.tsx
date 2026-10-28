import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { upscaleTargetFps, upscaleTargetLongEdge, type UpscaleOptions, type EditSession, type FaceBlurSettings } from '@shared/types'
import './components/video-picker.css'
import { EditorWorkspace, GpuWarning, StatusBanners, Welcome } from './components/AppLayout'
import { ExportProgress } from './components/ExportProgress'
import { ConfirmDialog } from './components/ConfirmDialog'
import { UpscaleDialog } from './components/UpscaleDialog'
import { VideoPicker } from './components/VideoPicker'
import { useEditorStore } from './model/store'
import { useVideoPickerStore } from './model/video-picker'
import { primarySource, timelineDuration } from './model/timeline'
import { stepOutputFrame } from './model/frame'
import { useFacePreview } from './model/use-face-preview'
import { prepareExportRequest } from './model/export-request'
import { saveCurrentSession, startAutosave } from './session-persistence'

function exportName(name: string): string {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name}-edited.mp4`
}

function shortcutId(event: KeyboardEvent): string {
  return `${Number(event.ctrlKey)}:${Number(event.shiftKey)}:${event.code}`
}

function ignoresShortcut(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    || (event.code === 'Space' && target.closest('button') !== null)
}

function exportWasCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.toLowerCase().includes('cancelled')
}

const defaultUpscaleCanvas = {
  width: upscaleTargetLongEdge,
  height: Math.round(upscaleTargetLongEdge * 9 / 16),
  fps: upscaleTargetFps,
  fit: 'contain' as const
}

export default function App(): React.JSX.Element {
  const store = useEditorStore()
  const pickerOpen = useVideoPickerStore((state) => state.open)
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const cancelModelDownload = useCallback((): void => { void window.otc.cancelModelDownload?.() }, [])
  const [gpuWarningDismissed, setGpuWarningDismissed] = useState(false)
  const [resetDialogOpen, setResetDialogOpen] = useState(false)
  const [selectedFaceBlurId, setSelectedFaceBlurId] = useState<string | null>(null)
  const session = store.session
  const selected = session?.overlays.find((overlay) => overlay.id === session.selectedOverlayId) ?? null
  const selectedFaceBlur = useMemo(() => {
    if (!session || !selectedFaceBlurId) return null
    return (session.faceBlurs ?? []).find((effect) => effect.id === selectedFaceBlurId) ?? null
  }, [session, selectedFaceBlurId])
  const selectedFaceBlurStart = selectedFaceBlur?.start
  const selectedFaceBlurDuration = selectedFaceBlur?.duration
  const selectedFaceBlurRange = useMemo<[number, number] | null>(() => {
    if (selectedFaceBlurStart === undefined || selectedFaceBlurDuration === undefined) return null
    return [selectedFaceBlurStart, selectedFaceBlurStart + selectedFaceBlurDuration]
  }, [selectedFaceBlurStart, selectedFaceBlurDuration])
  const duration = session ? timelineDuration(session.segments) : 0
  const facePreview = useFacePreview(session, store.job, store.showError, selectedFaceBlurRange ?? undefined)
  const startFacePreview = facePreview.start
  const previewActive = facePreview.rendering
  const resetBlockedRef = useRef(false)
  const resetDialogOpenRef = useRef(false)
  useLayoutEffect(() => {
    resetBlockedRef.current = exporting || previewActive || pickerOpen || exportDialogOpen
    resetDialogOpenRef.current = resetDialogOpen
  }, [exporting, previewActive, pickerOpen, exportDialogOpen, resetDialogOpen])

  useEffect(() => useVideoPickerStore.subscribe((next, previous) => {
    if (next.open && !previous.open) setPlaying(false)
  }), [])

  if (selectedFaceBlurId && !selectedFaceBlur) setSelectedFaceBlurId(null)

  const onSelectFaceBlur = useCallback((id: string | null): void => {
    setSelectedFaceBlurId(id)
    if (id) useEditorStore.getState().selectOverlay(null)
  }, [])

  const onApplyFaceBlur = useCallback((settings: FaceBlurSettings): void => {
    const currentStore = useEditorStore.getState()
    const previous = currentStore.session
    const selectedEffect = selectedFaceBlurId
      ? previous?.faceBlurs?.find((effect) => effect.id === selectedFaceBlurId) ?? null
      : null
    if (selectedEffect) {
      currentStore.updateFaceBlurSettings(selectedEffect.id, settings)
      const updated = useEditorStore.getState().session
      if (updated) {
        setPlaying(false)
        void startFacePreview(updated)
      }
      return
    }
    currentStore.applyFaceBlur(settings)
    const updated = useEditorStore.getState().session
    if (updated && updated !== previous) {
      setPlaying(false)
      void startFacePreview(updated)
    }
  }, [selectedFaceBlurId, startFacePreview])

  useEffect(() => {
    void store.initialize()
    const removeJobListener = window.otc.onJobProgress(store.setJob)
    const removeOpenListener = window.otc.onOpenPath((path) => void store.loadVideo(path))
    const removeResetListener = window.otc.onResetProject(() => {
      if (resetBlockedRef.current || resetDialogOpenRef.current || document.querySelector('[data-narration-busy="true"]')) return
      setPlaying(false)
      setSelectedFaceBlurId(null)
      setResetDialogOpen(true)
    })
    const removeSaveListener = window.otc.onSaveRequest(async () => { await saveCurrentSession() })
    const stopAutosave = startAutosave(() => {
      useEditorStore.getState().showError('OneTrackCat could not autosave this project. Your edits are still open; keep OneTrackCat running and try again.')
    })
    return () => {
      removeJobListener()
      removeOpenListener()
      removeResetListener()
      removeSaveListener()
      stopAutosave()
    }
    // Initialize the bridge subscription once; Zustand action identities are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent): void => {
    if (document.querySelector('[data-narration-busy="true"]')) return
    if (resetDialogOpen || exportDialogOpen || pickerOpen) return
    if (exporting || previewActive || ignoresShortcut(event)) return
    const currentStore = useEditorStore.getState()
    const actions: Record<string, () => void> = {
      '0:0:Space': () => setPlaying((value) => !value),
      '0:0:ArrowLeft': () => {
        const current = currentStore.session
        if (current) { setSelectedFaceBlurId(null); currentStore.setPlayhead(current.playhead - 5) }
      },
      '0:0:ArrowRight': () => {
        const current = currentStore.session
        if (current) { setSelectedFaceBlurId(null); currentStore.setPlayhead(current.playhead + 5) }
      },
      '0:1:ArrowLeft': () => {
        const current = currentStore.session
        if (current) { setSelectedFaceBlurId(null); setPlaying(false); currentStore.setPlayhead(stepOutputFrame(current, -1)) }
      },
      '0:1:ArrowRight': () => {
        const current = currentStore.session
        if (current) { setSelectedFaceBlurId(null); setPlaying(false); currentStore.setPlayhead(stepOutputFrame(current, 1)) }
      },
      '1:0:KeyZ': currentStore.undo,
      '1:1:KeyZ': currentStore.redo,
      '0:0:Delete': () => {
        const effect = selectedFaceBlurId
          ? currentStore.session?.faceBlurs?.find((candidate) => candidate.id === selectedFaceBlurId)
          : undefined
        if (effect) {
          currentStore.removeFaceBlur(effect.id)
          setSelectedFaceBlurId(null)
          return
        }
        if (currentStore.session?.selectedOverlayId) {
          currentStore.removeSelectedOverlay()
          return
        }
        setSelectedFaceBlurId(null)
        currentStore.removeMarked()
      }
    }
    const action = actions[shortcutId(event)]
    if (!action) return
    event.preventDefault()
    action()
  }, [exportDialogOpen, exporting, pickerOpen, previewActive, resetDialogOpen, selectedFaceBlurId])

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  const runExport = async (
    current: EditSession,
    upscale?: UpscaleOptions,
    requestedOutputPath?: string
  ): Promise<void> => {
    try {
      const defaultName = exportName(primarySource(current).metadata.name)
      const outputPath = requestedOutputPath
        ? await window.otc.chooseExportPath(defaultName, requestedOutputPath)
        : await window.otc.chooseExportPath(defaultName)
      if (!outputPath) return
      setPlaying(false)
      setExporting(true)
      const saved = await saveCurrentSession()
      if (saved) {
        const request = await prepareExportRequest(saved, outputPath)
        const exportRequest = upscale ? { ...request, upscale } : request
        await window.otc.exportVideo(exportRequest)
      }
    } catch (error) {
      if (!exportWasCancelled(error)) {
        store.showError(`OneTrackCat could not export this video. ${String(error).slice(0, 800)}`)
      }
    } finally {
      setExporting(false)
    }
  }

  const dropVideo = async (event: React.DragEvent, short = false): Promise<void> => {
    event.preventDefault()
    if (exporting || exportDialogOpen || pickerOpen || previewActive || resetDialogOpen) return
    const file = event.dataTransfer.files[0]
    if (!file) return
    try {
      setSelectedFaceBlurId(null)
      const path = await window.otc.getDroppedPath(file)
      await (short ? store.loadVideo(path, true) : store.loadVideo(path))
    } catch {
      store.showError('OneTrackCat could not open this video. Try another file.')
    }
  }

  return (
    <div className="app" data-initialized={store.initialized} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropVideo(event)}>
      <VideoPicker />
      <GpuWarning gpu={store.gpu} dismissed={gpuWarningDismissed} onDismiss={() => setGpuWarningDismissed(true)} />
      <StatusBanners store={store} />
      <ExportProgress
        exporting={exporting || facePreview.rendering}
        job={store.job}
        title={facePreview.rendering ? 'Applying face blur' : undefined}
        onCancel={facePreview.rendering ? facePreview.invalidate : undefined}
      />
      <UpscaleDialog
        open={exportDialogOpen}
        canvas={session?.canvas ?? defaultUpscaleCanvas}
        focusZooms={session?.focusZooms}
        timeline={session ?? undefined}
        defaultOutputName={session ? exportName(primarySource(session).metadata.name) : undefined}
        getUpscalePackStatus={window.otc.upscalePackStatus}
        onBrowse={() => session
          ? window.otc.chooseExportPath(exportName(primarySource(session).metadata.name))
          : Promise.resolve(null)}
        startModelDownload={window.otc.startModelDownload}
        cancelModelDownload={cancelModelDownload}
        subscribeModelDownload={window.otc.subscribeModelDownload}
        onCancel={() => setExportDialogOpen(false)}
        onStart={(upscale, outputPath) => {
          setExportDialogOpen(false)
          if (session) void runExport(session, upscale, outputPath)
        }}
      />
      <ConfirmDialog
        open={resetDialogOpen}
        title="Reset project?"
        description="Reset the current project and forget its saved state?"
        confirmLabel="Reset project"
        onCancel={() => setResetDialogOpen(false)}
        onConfirm={() => {
          setResetDialogOpen(false)
          void store.resetProject()
        }}
      />
      {!session
        ? <Welcome
            onOpen={() => void store.loadVideo()}
            onOpenShort={() => void store.openShort()}
            onDrop={(event, short) => void dropVideo(event, short)}
          />
        : <EditorWorkspace
            store={store}
            session={session}
            selected={selected}
            selectedFaceBlurId={selectedFaceBlurId}
            selectedFaceBlur={selectedFaceBlur}
            duration={duration}
            playing={playing}
            zoom={zoom}
            exporting={exporting}
            resetting={resetDialogOpen || exportDialogOpen}
            facePreviewing={previewActive}
            renderedPreview={facePreview.renderedPreview}
            renderedPreviews={facePreview.renderedPreviews}
            onPlayingChange={setPlaying}
            onZoom={setZoom}
            onExport={() => {
              setPlaying(false)
              setExportDialogOpen(true)
            }}
            onApplyFaceBlur={onApplyFaceBlur}
            onSelectFaceBlur={onSelectFaceBlur}
            onStep={(direction) => { setSelectedFaceBlurId(null); setPlaying(false); store.setPlayhead(stepOutputFrame(session, direction)) }}
          />}
    </div>
  )
}
