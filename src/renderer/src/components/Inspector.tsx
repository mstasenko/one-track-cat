import { audioFadeDurations, gameAudioLevels, mediaAnimationPresets, textAnimationPresets } from '@shared/types'
import type { MediaAnimationPreset, Overlay, TextAnimationPreset } from '@shared/types'
import { formatTime } from '../model/timeline'
import { NumberControl } from './NumberControl'

const fonts = ['Anton', 'Bangers', 'Bebas Neue', 'Comic Neue', 'Lobster', 'Oswald', 'Permanent Marker', 'Roboto']

interface InspectorProps {
  overlay: Overlay | null
  maxDuration: number
  framesPerSecond: number
  onBack: () => void
  onChange: (patch: Partial<Overlay>) => void
  onRemove: () => void
  onAnimation: (preset: TextAnimationPreset) => void
  onPreviewAnimation: () => void
}

function TextControls({ overlay, onChange, onAnimation, onPreviewAnimation }: Pick<InspectorProps, 'onChange' | 'onAnimation' | 'onPreviewAnimation'> & { overlay: Overlay }): React.JSX.Element | null {
  if (overlay.type !== 'text') return null
  return (
    <>
      <label className="stacked-control"><span>Text</span><textarea autoFocus value={overlay.text} onFocus={(event) => event.currentTarget.select()} onChange={(e) => onChange({ text: e.target.value } as Partial<Overlay>)} /></label>
      <label className="control-row"><span>Center text</span><input type="checkbox" checked={overlay.align === 'center'} onChange={(event) => onChange({ align: event.target.checked ? 'center' : 'left' } as Partial<Overlay>)} /></label>
      <label className="control-row"><span>Font</span><select value={overlay.fontFamily} onChange={(e) => onChange({ fontFamily: e.target.value } as Partial<Overlay>)}>{fonts.map((font) => <option key={font}>{font}</option>)}</select></label>
      <NumberControl label="Text size" value={overlay.fontSize} min={1} max={30} step={0.5} onChange={(fontSize) => onChange({ fontSize } as Partial<Overlay>)} />
      <label className="control-row"><span>Animation</span><span className="compact-controls">
        <select value={overlay.animation ?? 'none'} onChange={(event) => onAnimation(event.target.value as TextAnimationPreset)}>
          {textAnimationPresets.map((preset) => <option key={preset} value={preset}>{preset[0]?.toUpperCase()}{preset.slice(1)}</option>)}
        </select>
        <button disabled={!overlay.animation || overlay.animation === 'none'} onClick={onPreviewAnimation} aria-label="Preview text animation" title="Preview text animation">▶</button>
      </span></label>
      <AnimationTimingControls overlay={overlay} onChange={onChange} />
      <label className="control-row"><span>Color</span><input type="color" value={overlay.color} onChange={(e) => onChange({ color: e.target.value } as Partial<Overlay>)} /></label>
      <label className="control-row"><span>Outline</span><input type="color" value={overlay.outlineColor} onChange={(e) => onChange({ outlineColor: e.target.value } as Partial<Overlay>)} /></label>
      <NumberControl label="Outline width" value={overlay.outlineWidth} min={0} max={12} step={1} onChange={(outlineWidth) => onChange({ outlineWidth } as Partial<Overlay>)} />
      <label className="control-row"><span>Shadow</span><input type="checkbox" checked={overlay.shadow} onChange={(e) => onChange({ shadow: e.target.checked } as Partial<Overlay>)} /></label>
    </>
  )
}

function VisualControls({ overlay, onChange }: Pick<InspectorProps, 'onChange'> & { overlay: Overlay }): React.JSX.Element | null {
  if (overlay.type === 'audio') return null
  return <NumberControl label="Opacity" value={overlay.opacity} min={0} max={1} step={0.05} onChange={(opacity) => onChange({ opacity } as Partial<Overlay>)} />
}

type AnimatedOverlay = Extract<Overlay, { type: 'text' | 'image' | 'video' }>

function AnimationTimingControls({ overlay, onChange }: Pick<InspectorProps, 'onChange'> & { overlay: AnimatedOverlay }): React.JSX.Element | null {
  const animation = overlay.animation ?? 'none'
  const limit = Math.min(5, overlay.duration)
  if (animation === 'fade') {
    const defaultFadeDuration = Math.min(0.22, overlay.duration / 2)
    const displayedFadeDuration = (value: number | undefined): number => Math.max(0, Math.min(limit, value ?? defaultFadeDuration))
    return <>
      <NumberControl label="Visual fade in" value={displayedFadeDuration(overlay.animationFadeIn)} min={0} max={limit} step={0.05} onChange={(animationFadeIn) => onChange({ animationFadeIn } as Partial<Overlay>)} />
      <NumberControl label="Visual fade out" value={displayedFadeDuration(overlay.animationFadeOut)} min={0} max={limit} step={0.05} onChange={(animationFadeOut) => onChange({ animationFadeOut } as Partial<Overlay>)} />
    </>
  }
  if (animation === 'pop' || animation === 'bounce' || animation === 'shake') {
    const defaultDuration = animation === 'shake'
      ? Math.min(0.55, overlay.duration)
      : Math.min(animation === 'pop' ? 0.28 : 0.38, overlay.duration / 2)
    const value = Math.max(0, Math.min(limit, overlay.animationDuration ?? defaultDuration))
    return <NumberControl label="Animation duration" value={value} min={0} max={limit} step={0.05} onChange={(animationDuration) => onChange({ animationDuration } as Partial<Overlay>)} />
  }
  return null
}

function MediaAnimationControls({ overlay, onChange }: Pick<InspectorProps, 'onChange'> & { overlay: Overlay }): React.JSX.Element | null {
  if (overlay.type !== 'image' && overlay.type !== 'video') return null
  const animation = overlay.animation ?? 'none'
  return <>
    <label className="control-row"><span>Animation</span><select value={animation} onChange={(event) => onChange({ animation: event.target.value as MediaAnimationPreset } as Partial<Overlay>)}>
      {mediaAnimationPresets.map((preset) => <option key={preset} value={preset}>{preset[0]?.toUpperCase()}{preset.slice(1)}</option>)}
    </select></label>
    <AnimationTimingControls overlay={overlay} onChange={onChange} />
  </>
}

function fadeLabel(value: number): string {
  return value === 0 ? 'Off' : `${value}s`
}

function AudioSettingsControls({ overlay, onChange }: Pick<InspectorProps, 'onChange'> & {
  overlay: Extract<Overlay, { type: 'video' | 'audio' }>
}): React.JSX.Element {
  return <>
    <NumberControl label="Volume" value={overlay.volume} min={0} max={2} step={0.05} onChange={(volume) => onChange({ volume } as Partial<Overlay>)} />
    {(['fadeIn', 'fadeOut'] as const).map((field) => <label className="control-row" key={field}>
      <span>{field === 'fadeIn' ? 'Fade in' : 'Fade out'}</span>
      <select value={overlay[field] ?? 0} onChange={(event) => onChange({ [field]: Number(event.target.value) } as Partial<Overlay>)}>
        {audioFadeDurations.map((duration) => <option key={duration} value={duration}>{fadeLabel(duration)}</option>)}
      </select>
    </label>)}
    <label className="control-row" title="Automatically lowers gameplay audio while this sound plays.">
      <span>Lower game sound</span>
      <input type="checkbox" checked={overlay.duckGameAudio ?? false} onChange={(event) => onChange({ duckGameAudio: event.target.checked } as Partial<Overlay>)} />
    </label>
    {overlay.duckGameAudio && <label className="control-row"><span>Game sound</span>
      <select value={overlay.gameAudioLevel ?? 0.3} onChange={(event) => onChange({ gameAudioLevel: Number(event.target.value) } as Partial<Overlay>)}>
        {gameAudioLevels.map((level) => <option key={level} value={level}>{Math.round(level * 100)}% — {level === 0.5 ? 'Soft' : level === 0.3 ? 'Normal' : 'Strong'}</option>)}
      </select>
    </label>}
  </>
}

function VideoControls({ overlay, onChange }: Pick<InspectorProps, 'onChange'> & { overlay: Overlay }): React.JSX.Element | null {
  if (overlay.type !== 'video') return null
  return (
    <>
      <label className="control-row"><span>Include audio</span><input type="checkbox" checked={overlay.audioEnabled} disabled={!overlay.hasAudio} onChange={(e) => onChange({ audioEnabled: e.target.checked } as Partial<Overlay>)} /></label>
      {overlay.hasAudio && overlay.audioEnabled && <AudioSettingsControls overlay={overlay} onChange={onChange} />}
      <label className="control-row"><span>Loop clip</span><input type="checkbox" checked={overlay.loop} onChange={(e) => onChange({ loop: e.target.checked } as Partial<Overlay>)} /></label>
    </>
  )
}

function DurationControl({
  overlay, maxDuration, framesPerSecond, onChange
}: Pick<InspectorProps, 'maxDuration' | 'framesPerSecond' | 'onChange'> & { overlay: Overlay }): React.JSX.Element {
  if (overlay.type === 'audio' || overlay.type === 'video' || overlay.type === 'gif') {
    return <div className="control-row"><span>Length</span><output>{formatTime(overlay.duration, framesPerSecond)}</output></div>
  }
  return <NumberControl label="Visible for" value={overlay.duration} min={0.1} max={Math.max(0.1, maxDuration - overlay.start)} step={0.05} onChange={(duration) => onChange({ duration })} />
}

export function Inspector({ overlay, maxDuration, framesPerSecond, onBack, onChange, onRemove, onAnimation, onPreviewAnimation }: InspectorProps): React.JSX.Element {
  if (!overlay) return <section className="inspector"><p className="empty-note">Select text, a picture, or a clip to edit it.</p></section>
  return (
    <section className="inspector">
      <div className="panel-heading"><button onClick={onBack}>← Back</button><strong>{overlay.name}</strong></div>
      <NumberControl label={overlay.type === 'audio' ? 'Starts at' : 'Appears at'} value={overlay.start} min={0} max={maxDuration} step={0.05} onChange={(start) => onChange({ start })} />
      <DurationControl overlay={overlay} maxDuration={maxDuration} framesPerSecond={framesPerSecond} onChange={onChange} />
      <TextControls overlay={overlay} onChange={onChange} onAnimation={onAnimation} onPreviewAnimation={onPreviewAnimation} />
      <MediaAnimationControls overlay={overlay} onChange={onChange} />
      <VisualControls overlay={overlay} onChange={onChange} />
      {overlay.type === 'audio' && <AudioSettingsControls overlay={overlay} onChange={onChange} />}
      <VideoControls overlay={overlay} onChange={onChange} />
      <button className="wide-button danger" onClick={onRemove}>Remove from video</button>
    </section>
  )
}
