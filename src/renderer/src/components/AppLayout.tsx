import { useState, type DragEvent } from 'react'
import type { EditSession, FaceBlurEffect, FaceBlurSettings, FocusZoomAmount, GpuDiagnostics, Overlay } from '@shared/types'
import brandIcon from '../../../../assets/icon.svg'
import type { EditorState } from '../model/editor-state'
import { primarySource } from '../model/timeline'
import { AssetPanel } from './AssetPanel'
import type { AssetCategory } from './AssetPanel'
import { Inspector } from './Inspector'
import { Preview } from './Preview'
import type { RenderedFacePreview } from '../model/use-face-preview'
import { Timeline } from './Timeline'

function accelerationUnavailable(gpu: GpuDiagnostics): boolean {
  return !gpu.hardwareAcceleration
    || !gpu.videoDecode.startsWith('enabled')
    || !gpu.gpuCompositing.startsWith('enabled')
}

export function GpuWarning({ gpu, dismissed, onDismiss }: {
  gpu: GpuDiagnostics | null
  dismissed: boolean
  onDismiss: () => void
}): React.JSX.Element | null {
  if (!gpu || dismissed || !accelerationUnavailable(gpu)) return null
  return (
    <div className="modal-backdrop">
      <div className="warning-dialog" role="alertdialog" aria-labelledby="gpu-warning-title" aria-describedby="gpu-warning-description">
        <h2 id="gpu-warning-title">Hardware acceleration is unavailable</h2>
        <p id="gpu-warning-description">Playback may use more CPU and feel less smooth.</p>
        <button autoFocus onClick={onDismiss}>Continue</button>
      </div>
    </div>
  )
}

export function StatusBanners({ store }: { store: EditorState }): React.JSX.Element {
  return (
    <div className="status-stack">
      {store.error && <div className="error-banner"><span>{store.error}</span><button onClick={store.clearError}>×</button></div>}
      {store.busy && <div className="busy-banner">{store.busy}</div>}
    </div>
  )
}


export function Welcome({ onOpen, onOpenShort, onDrop }: {
  onOpen: () => void
  onOpenShort: () => void
  onDrop: (event: DragEvent<HTMLElement>, short: boolean) => void
}): React.JSX.Element {
  const drop = (event: DragEvent<HTMLElement>, short: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    onDrop(event, short)
  }
  return (
    <main className="welcome">
      <div className="welcome-brand"><img src={brandIcon} alt="" /><strong>OneTrackCat</strong></div>
      <h1>Drop a video</h1>
      <div className="welcome-actions">
        <button type="button" aria-label="Open" onClick={onOpen} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, false)}>
          <span className="welcome-icon" aria-hidden="true">▶</span><strong>Open</strong><span>Original format</span>
        </button>
        <button type="button" aria-label="Open Short" onClick={onOpenShort} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, true)}>
          <span className="welcome-icon" aria-hidden="true">▯</span><strong>Open Short</strong><span>YouTube Short</span>
        </button>
      </div>
      <small>Your video stays on this computer.</small>
    </main>
  )
}

function ProjectActions({ store, exporting, onExport }: {
  store: EditorState
  exporting: boolean
  onExport: () => void
}): React.JSX.Element {
  return (
    <div className="project-actions">
      <button onClick={() => void store.loadVideo()}>Open</button>
      <button onClick={() => void store.openShort()}>Open Short</button>
      <button className="export-button" disabled={exporting} onClick={onExport}>{exporting ? 'Exporting…' : 'Export'}</button>
    </div>
  )
}

function SidePanel({ store, session, selected, selectedFaceBlur, duration, exporting, onExport, onPause, onFocusPick, onPreviewText, onApplyFaceBlur, onSelectFaceBlur }: {
  store: EditorState
  session: EditSession
  selected: Overlay | null
  selectedFaceBlur: FaceBlurEffect | null
  duration: number
  exporting: boolean
  onExport: () => void
  onPause: () => void
  onFocusPick: (zoom: FocusZoomAmount) => void
  onPreviewText: (overlay: Overlay) => void
  onApplyFaceBlur: (settings: FaceBlurSettings) => void
  onSelectFaceBlur: (id: string | null) => void
}): React.JSX.Element {
  const [assetCategory, setAssetCategory] = useState<AssetCategory | null>(null)
  return (
    <aside className="side-panel">
      <div className="side-brand"><img src={brandIcon} alt="" /><strong>OneTrackCat</strong></div>
      <ProjectActions store={store} exporting={exporting} onExport={onExport} />
      <div className="source-name" title={primarySource(session).metadata.name}>
        {primarySource(session).metadata.name}
      </div>
      {selected && !selectedFaceBlur
        ? (
            <Inspector
              overlay={selected}
              maxDuration={duration}
              framesPerSecond={session.canvas.fps}
              onBack={() => store.selectOverlay(null)}
              onChange={(patch) => store.updateOverlay(selected.id, patch)}
              onRemove={store.removeSelectedOverlay}
              onAnimation={(preset) => store.setTextAnimation(selected.id, preset)}
              onPreviewAnimation={() => onPreviewText(selected)}
            />
          )
        : (
            <AssetPanel
              assets={store.assets}
              session={session}
              category={assetCategory}
              onCategory={setAssetCategory}
              onText={() => { setAssetCategory(null); store.addText() }}
              onNew={() => { setAssetCategory(null); void store.addExternalMedia() }}
              onInsert={(transitions) => void store.insertVideo(transitions)}
              onAsset={(asset) => void store.addAsset(asset)}
              onError={store.showError}
              onSpeed={(rate) => { onPause(); store.setSpeed(rate) }}
              onFocusPick={(zoom) => { onPause(); onFocusPick(zoom) }}
              onRemoveFocusZoom={() => { onPause(); store.removeFocusZoom() }}
              onVideoTransition={(into, out) => { onPause(); store.applyVideoTransition(into, out) }}
              onFreeze={(effectDuration) => { onPause(); store.insertFreeze(effectDuration) }}
              onRemoveFreeze={() => { onPause(); store.removeFreeze() }}
              onReplay={() => { onPause(); store.insertReplay() }}
              onRemoveReplay={() => { onPause(); store.removeReplay() }}
              faceBlurs={session.faceBlurs ?? []}
              selectedFaceBlur={selectedFaceBlur}
              onSelectFaceBlur={onSelectFaceBlur}
              onApplyFaceBlur={(settings: FaceBlurSettings) => { onPause(); onApplyFaceBlur(settings) }}
              onRemoveFaceBlur={(id) => {
                onPause()
                store.removeFaceBlur(id)
                if (selectedFaceBlur?.id === id) onSelectFaceBlur(null)
              }}
            />
          )}
    </aside>
  )
}

export function EditorWorkspace({
  store,
  session,
  selected,
  selectedFaceBlur,
  selectedFaceBlurId,
  duration,
  playing,
  zoom,
  exporting,
  resetting,
  renderedPreview,
  renderedPreviews,
  onPlayingChange,
  onZoom,
  onExport,
  onStep,
  onApplyFaceBlur,
  onSelectFaceBlur,
  facePreviewing
}: {
  store: EditorState
  session: EditSession
  selected: Overlay | null
  selectedFaceBlur: FaceBlurEffect | null
  selectedFaceBlurId: string | null
  duration: number
  playing: boolean
  zoom: number
  exporting: boolean
  resetting: boolean
  renderedPreview: RenderedFacePreview | null
  renderedPreviews?: RenderedFacePreview[]
  onPlayingChange: (value: boolean) => void
  onZoom: (value: number) => void
  onExport: () => void
  onStep: (direction: -1 | 1) => void
  onApplyFaceBlur: (settings: FaceBlurSettings) => void
  onSelectFaceBlur: (id: string | null) => void
  facePreviewing: boolean
}): React.JSX.Element {
  const [focusPicking, setFocusPicking] = useState<FocusZoomAmount | null>(null)
  const selectOverlay = (id: string | null): void => {
    onSelectFaceBlur(null)
    store.selectOverlay(id)
  }
  const seek = (time: number): void => {
    onSelectFaceBlur(null)
    onPlayingChange(false)
    store.setPlayhead(time)
  }
  return (
    <main className="workspace" inert={exporting || resetting || facePreviewing}>
      <SidePanel store={store} session={session} selected={selected} selectedFaceBlur={selectedFaceBlur} duration={duration} exporting={exporting} onExport={onExport} onPause={() => onPlayingChange(false)} onFocusPick={setFocusPicking} onApplyFaceBlur={onApplyFaceBlur} onSelectFaceBlur={onSelectFaceBlur} onPreviewText={(overlay) => {
        onPlayingChange(false)
        store.setPlayhead(overlay.start)
        setTimeout(() => onPlayingChange(true), 0)
      }} />
      <div className="editor-column">
        <Preview
          session={session}
          playing={playing}
          zoom={zoom}
          canUndo={store.history.length > 0}
          canRedo={store.future.length > 0}
          onPlayingChange={onPlayingChange}
          onZoom={onZoom}
          onPlayhead={store.setPlayhead}
          onSelect={selectOverlay}
          onOverlayChange={store.updateOverlayGesture}
          onOverlayGestureStart={store.beginOverlayGesture}
          onOverlayGestureEnd={store.commitOverlayGesture}
          onOverlayGestureCancel={store.cancelOverlayGesture}
          onAddMark={store.addMark}
          onClearMarks={store.clearMarks}
          onRemoveMarked={store.removeMarked}
          onUndo={store.undo}
          onRedo={store.redo}
          onStep={onStep}
          renderedPreview={renderedPreview}
          renderedPreviews={renderedPreviews}
          focusPicking={focusPicking}
          onFocusZoom={(focusZoom, x, y) => { store.addFocusZoom(focusZoom, x, y); setFocusPicking(null) }}
          onCancelFocusPick={() => setFocusPicking(null)}
        />
        <Timeline
          session={session}
          zoom={zoom}
          onZoom={onZoom}
          onSeek={seek}
          onSelectOverlay={selectOverlay}
          selectedFaceBlurId={selectedFaceBlurId}
          onSelectFaceBlur={onSelectFaceBlur}
          onOverlayChange={store.updateOverlayGesture}
          onOverlayGestureStart={store.beginOverlayGesture}
          onOverlayGestureEnd={store.commitOverlayGesture}
          onOverlayGestureCancel={store.cancelOverlayGesture}
        />
      </div>
    </main>
  )
}
