import type { EditSession } from '@shared/types'
import { formatTime } from '../model/timeline'

interface TransportProps {
  session: EditSession
  total: number
  playing: boolean
  zoom: number
  canUndo: boolean
  canRedo: boolean
  onPlayingChange: (playing: boolean) => void
  onZoom: (zoom: number) => void
  onStep: (direction: -1 | 1) => void
  onAddMark: () => void
  onClearMarks: () => void
  onRemoveMarked: () => void
  onUndo: () => void
  onRedo: () => void
}

function PlayButton({ playing, onChange }: { playing: boolean; onChange: (playing: boolean) => void }): React.JSX.Element {
  const label = playing ? 'Pause' : 'Play'
  return <button className="play-button" onClick={() => onChange(!playing)} aria-label={label}><span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span> {label}</button>
}

export function Transport(props: TransportProps): React.JSX.Element {
  return <div className="transport">
    <button className="transport-step" onClick={() => props.onStep(-1)} aria-label="Previous frame" title="Previous frame (Shift+Left)">|◀</button>
    <PlayButton playing={props.playing} onChange={props.onPlayingChange} />
    <button className="transport-step" onClick={() => props.onStep(1)} aria-label="Next frame" title="Next frame (Shift+Right)">▶|</button>
    <button onClick={props.onAddMark}>Mark</button><button disabled={props.session.marks.length === 0} onClick={props.onClearMarks} title="Clear the highlighted section's marks">Clear Marks</button><button className="danger" disabled={props.session.marks.length === 0} onClick={props.onRemoveMarked}>Remove Marked</button>
    <button className="transport-undo" disabled={!props.canUndo} onClick={props.onUndo} aria-label="Undo" title="Undo (Ctrl+Z)">↶</button><button disabled={!props.canRedo} onClick={props.onRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">↷</button>
    <span className="timeline-title">Timeline</span><span className="timeline-time">{formatTime(props.session.playhead, props.session.canvas.fps)} / {formatTime(props.total, props.session.canvas.fps)}</span>
    <button disabled={props.zoom <= 1} onClick={() => props.onZoom(Math.max(1, props.zoom - 0.25))} aria-label="Zoom out">−</button><button disabled={props.zoom >= 8} onClick={() => props.onZoom(Math.min(8, props.zoom + 0.25))} aria-label="Zoom in">+</button>
  </div>
}
