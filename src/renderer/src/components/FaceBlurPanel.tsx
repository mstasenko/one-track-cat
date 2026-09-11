import { useEffect, useMemo, useState } from 'react'
import type { EditSession, FaceBlurEffect, FaceBlurSettings } from '@shared/types'
import { deletionRange, timelineDuration } from '../model/timeline'
import { NumberControl } from './NumberControl'

export type FaceBlurDraft = FaceBlurSettings

interface FacePackStatus {
  available: boolean
  message: string
}

export interface FaceBlurPanelProps {
  session: EditSession
  effects: FaceBlurEffect[]
  selectedEffect?: FaceBlurEffect | null
  onBack: () => void
  onApply: (settings: FaceBlurSettings) => void
  onRemove: (id: string) => void
}

const defaultFaceBlurDraft: FaceBlurDraft = {
  sensitivity: 0.7,
  detail: 'small',
  holdSeconds: 0.3,
  strength: 0.7,
  style: 'pixelate'
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}

function percentage(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`
}

function faceBlurRange(selected: [number, number] | null, duration: number): [number, number] {
  return selected ?? [0, duration]
}

function applyDisabled(checkingPack: boolean, status: FacePackStatus | null, range: [number, number]): boolean {
  return checkingPack || status?.available !== true || range[1] - range[0] <= 0
}

function FacePackNotice({ status }: { status: FacePackStatus | null }): React.JSX.Element | null {
  if (status?.available !== false) return null
  return (
    <p className="face-pack-missing" role="alert">
      Face pack unavailable. Download and extract the face-pack next to the OneTrackCat AppImage, then reopen this panel.
      {status.message ? ` ${status.message}` : ''}
    </p>
  )
}

function RangeSummary({ session, effect }: { session: EditSession; effect: FaceBlurEffect | null }): React.JSX.Element {
  const selected = effect ? [effect.start, effect.start + effect.duration] as [number, number] : deletionRange(session)
  return (
    <p className="empty-note face-blur-scope">
      Apply to {selected ? 'selected range' : 'entire video'}.
    </p>
  )
}

function FaceBlurControl({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <label className="control-row">
      <span>{label} <output>{percentage(value)}</output></span>
      <input
        aria-label={label}
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={value}
        onChange={(event) => onChange(clamp01(Number(event.target.value)))}
      />
    </label>
  )
}

export function FaceBlurPanel(props: FaceBlurPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState(defaultFaceBlurDraft)
  const [packStatus, setPackStatus] = useState<FacePackStatus | null>(null)
  const [checkingPack, setCheckingPack] = useState(true)
  const totalDuration = useMemo(() => timelineDuration(props.session.segments), [props.session.segments])

  useEffect(() => {
    let current = true
    setCheckingPack(true)
    void window.otc.facePackStatus()
      .then((status) => {
        if (!current) return
        setPackStatus(status)
        setCheckingPack(false)
      })
      .catch(() => {
        if (!current) return
        setPackStatus({ available: false, message: 'OneTrackCat could not check the installed face-pack.' })
        setCheckingPack(false)
      })
    return () => { current = false }
  }, [])

  const selectedEffect = props.selectedEffect
  const selectedRange = selectedEffect
    ? [selectedEffect.start, selectedEffect.start + selectedEffect.duration] as [number, number]
    : deletionRange(props.session)
  const range = faceBlurRange(selectedRange, totalDuration)
  const cannotApply = applyDisabled(checkingPack, packStatus, range)
  useEffect(() => {
    if (!selectedEffect) return
    setDraft({
      sensitivity: selectedEffect.sensitivity,
      detail: selectedEffect.detail,
      holdSeconds: selectedEffect.holdSeconds,
      strength: selectedEffect.strength,
      style: selectedEffect.style
    })
  }, [selectedEffect])
  const changeDraft = <K extends keyof FaceBlurDraft>(key: K, value: FaceBlurDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }
  const apply = (): void => {
    if (cannotApply) return
    props.onApply(draft)
  }

  return (
    <section className="asset-panel effect-menu face-blur-menu">
      <div className="panel-heading">
        <button onClick={props.onBack}>← Back</button>
        <strong>Blur faces</strong>
      </div>
      <FacePackNotice status={packStatus} />
      <RangeSummary session={props.session} effect={selectedEffect ?? null} />
      <FaceBlurControl label="Sensitivity" value={draft.sensitivity} onChange={(value) => changeDraft('sensitivity', value)} />
      <label className="control-row">
        <span>Small faces (slower)</span>
        <input
          aria-label="Small faces (slower)"
          type="checkbox"
          checked={draft.detail === 'small'}
          onChange={(event) => changeDraft('detail', event.target.checked ? 'small' : 'standard')}
        />
      </label>
      <NumberControl label="Hold missed faces seconds" value={draft.holdSeconds} min={0} max={1} step={0.05} onChange={(value) => changeDraft('holdSeconds', value)} />
      <FaceBlurControl label="Strength" value={draft.strength} onChange={(value) => changeDraft('strength', value)} />
      <label className="control-row">
        <span>Style</span>
        <select
          aria-label="Style"
          value={draft.style}
          onChange={(event) => changeDraft('style', event.target.value as FaceBlurDraft['style'])}
        >
          <option value="pixelate">Pixelation</option>
          <option value="blur">Blur</option>
          <option value="mask">Solid mask</option>
        </select>
      </label>
      <button className="wide-button face-blur-apply" disabled={cannotApply} onClick={apply}>Apply face blur</button>
      {selectedEffect ? (
        <button aria-label="Remove face blur" onClick={() => props.onRemove(selectedEffect.id)}>Remove</button>
      ) : null}
    </section>
  )
}
