import { useEffect, useState } from 'react'
import type { AudioOverlay, EditSession } from '@shared/types'
import type { NarrationReview, NarrationProgress, NarrationMixSettings, NarrationGeneratedAudio, NarrationRecognitionSettings } from '@shared/narration-api'
import { narrationDefaultRecognitionSettings, narrationRecognitionAudioSources, narrationSpeechDetectionModes, narrationVoiceStyles,
  type NarrationRecognitionAudio, type NarrationSpeechDetectionMode, type NarrationVoiceStyle } from '@shared/narration-api'
import { sliceNarrationReview } from '@shared/narration-slice'
import { narrationDefaultSlowdown, narrationMaxSlowdown } from '@shared/narration'
import { deletionRange, formatTime, timelineDuration } from '../model/timeline'
import { prepareExportRequest } from '../model/export-request'
import { useEditorStore } from '../model/store'
import { installNarrationResult } from '../model/narration-history'
import { ExportProgress } from './ExportProgress'
import { NarrationTranscript } from './NarrationTranscript'
import { NumberControl } from './NumberControl'

function readyToGenerate(draft: NarrationReview | null, busy: boolean): boolean {
  return !busy && !!draft && draft.stage === 'cleaned' && !draft.overruns?.length && draft.phrases.length > 0 &&
    draft.phrases.every((phrase) => !phrase.needsTimingReview && !!phrase.text.trim())
}

function restoredRecognition(review: NarrationReview): Required<NarrationRecognitionSettings> {
  const candidate = (review as NarrationReview & { recognition?: unknown }).recognition
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { ...narrationDefaultRecognitionSettings }
  const value = candidate as { speechDetection?: unknown; audio?: unknown }
  const mode = value.speechDetection
  const audio = value.audio
  return typeof mode === 'string' && narrationSpeechDetectionModes.includes(mode as NarrationSpeechDetectionMode) &&
    (audio === undefined || typeof audio === 'string' && narrationRecognitionAudioSources.includes(audio as NarrationRecognitionAudio))
    ? { speechDetection: mode as NarrationSpeechDetectionMode,
      audio: audio === undefined ? narrationDefaultRecognitionSettings.audio : audio as NarrationRecognitionAudio }
    : { ...narrationDefaultRecognitionSettings }
}

function sameRange(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left.every((value, index) => Math.abs(value - (right[index] ?? 0)) < 0.0001)
}

function narrationFailure(operation: string, reason: unknown): void {
  useEditorStore.getState().showError(`OneTrackCat could not ${operation}. ${String(reason).slice(0, 800)}`)
}

function narrationWasCancelled(reason: unknown): boolean {
  return /\b(?:cancelled|canceled|aborted|aborterror)\b/iu.test(String(reason))
}

function narrationSelection(session: EditSession, selectedOverlay?: AudioOverlay): {
  overlay: AudioOverlay | undefined; range: [number, number]; transcriptRange: [number, number]
} {
  const markedRange: [number, number] = deletionRange(session) ?? [0, timelineDuration(session.segments)]
  // New visual-effect marks do not discard recognition inside an existing owner.
  // Edit/Generate retain that whole transcript; Recognize can still replace only the marks.
  const overlay = selectedOverlay ?? session.overlays.find((item): item is AudioOverlay =>
    item.type === 'audio' && !!item.narration &&
    item.start <= markedRange[0] + 0.0001 && item.start + item.duration >= markedRange[1] - 0.0001)
  const range: [number, number] = overlay
    ? [overlay.start, overlay.start + overlay.duration] : markedRange
  const transcriptRange = markedRange[0] >= range[0] - 0.0001 && markedRange[1] <= range[1] + 0.0001 ? markedRange : range
  return { overlay, range, transcriptRange }
}

/** Marks partition transcript blocks by their start, never split words or the cached voice. */
function markedTranscript(draft: NarrationReview | null, range: readonly [number, number],
  overruns: NarrationReview['overruns']): NarrationReview | null {
  // Timing retries retain the complete review, including issues outside the marks.
  if (!draft || overruns?.length || draft.phrases.some((phrase) => phrase.needsTimingReview)) return draft
  const sample = 1 / 48_000
  return { ...draft, phrases: draft.phrases.filter((phrase) => {
    const start = Math.round((draft.range[0] + phrase.start) / sample)
    return start >= Math.round(range[0] / sample) && start < Math.round(range[1] / sample)
  }) }
}

function reviewWithEdits(saved: NarrationReview | null, narration: AudioOverlay['narration'],
  range: readonly [number, number], sourceIn = 0): NarrationReview | null {
  if (!saved || (narration && saved.id !== narration.draftId)) return null
  // Without an owning effect, Generate approves the whole saved draft. A new
  // marked range must not reuse a partial transcript left in the Add panel.
  if (!narration && !sameRange(saved.range, range)) return null
  try {
    const editedRange = narration?.transcriptRange
    const base = editedRange ? sliceNarrationReview(saved, [0, editedRange[1] - editedRange[0]], editedRange[0]) : saved
    const phrases = base.phrases.map((phrase, index) => ({ ...phrase,
      text: narration?.originals?.[index] ?? phrase.text,
      revisedText: narration?.revisions?.[index] ?? phrase.revisedText,
      generatedTempo: narration?.revisions?.[index] !== undefined && narration.revisions[index] !== phrase.revisedText
        ? undefined : phrase.generatedTempo }))
    const review = { ...base, phrases, overruns: base.overruns?.filter((issue) =>
      phrases.some((phrase) => phrase.id === issue.id && phrase.revisedText === issue.text)) }
    const offset = sourceIn - (editedRange?.[0] ?? 0)
    if (offset === 0 && sameRange(base.range, range)) return review
    return sliceNarrationReview(review, range, offset)
  } catch { return null }
}

export function NarrationPanel({ session, overlay: selectedOverlay, onBack, onPause }: {
  session: EditSession; overlay?: AudioOverlay; onBack: () => void; onPause?: () => void
}): React.JSX.Element {
  const api = window.otc.narration
  const { overlay, range, transcriptRange } = narrationSelection(session, selectedOverlay)
  const narration = overlay?.narration
  const [status, setStatus] = useState({ available: false, message: 'Checking voice pack…' })
  const [fallbackVoiceStyle, setVoiceStyle] = useState<NarrationVoiceStyle>('original')
  const voiceStyle = narration?.voiceStyle ?? fallbackVoiceStyle
  const [fallbackOptions, setOptions] = useState({ levelVoice: true, backgroundVolume: 1, slowdown: narrationDefaultSlowdown, subtitles: false })
  // Older effects without this field were generated without leveling.
  const levelVoice = narration ? narration.levelVoice ?? false : fallbackOptions.levelVoice
  const backgroundVolume = narration?.backgroundVolume ?? fallbackOptions.backgroundVolume
  const slowdown = narration?.slowdown ?? fallbackOptions.slowdown
  const subtitles = narration?.subtitles ?? fallbackOptions.subtitles
  const [translateToEnglish, setTranslateToEnglish] = useState(false)
  const [recognition, setRecognition] = useState({ ...narrationDefaultRecognitionSettings })
  const [storedDraft, setDraft] = useState<NarrationReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [jobId, setJobId] = useState(0)
  const [progress, setProgress] = useState<NarrationProgress>({ stage: 'Preparing narration', fraction: 0 })
  const draftId = narration?.draftId
  const draft = reviewWithEdits(storedDraft, narration, range, overlay?.sourceIn)
  const hasTimingReview = !!draft?.phrases.some((phrase) => phrase.needsTimingReview)
  const transcript = markedTranscript(draft, transcriptRange, storedDraft?.overruns)
  const canGenerate = readyToGenerate(draft, busy || narration?.invalidated === true) && !!transcript?.phrases.length
  const canUseAi = draft?.approved && !narration?.invalidated
  useEffect(() => {
    let current = true
    void api?.status().then((value) => { if (current) setStatus(value) }).catch((reason: unknown) => {
      if (current) {
        setStatus({ available: false, message: 'Voice pack status unavailable.' })
        narrationFailure('check narration availability', reason)
      }
    })
    return () => { current = false }
  }, [api])
  useEffect(() => {
    let current = true
    if (draftId) void api?.load(draftId).then((value) => {
      if (current) {
        setDraft(value)
        // Add → Inspector remounts this panel; restore its pending timing review.
        if (value.overruns?.length) setEditorOpen(true)
        setVoiceStyle((previous) => value.voiceStyle ?? previous)
        setTranslateToEnglish(value.translateToEnglish === true)
        setRecognition(restoredRecognition(value))
      }
    }).catch((reason: unknown) => { if (current) narrationFailure('load this narration review', reason) })
    return () => { current = false }
  }, [api, draftId])
  useEffect(() => api?.progress(setProgress), [api])
  useEffect(() => {
    if (draftId && hasTimingReview) {
      useEditorStore.getState().showError('Speech timing could not be corrected. Select a shorter section, then click Recognize.')
    }
  }, [draftId, hasTimingReview])

  const updateOptions = (changes: NarrationMixSettings): void => {
    setOptions((previous) => ({ ...previous, ...changes }))
    if (overlay?.narration) {
      const store = useEditorStore.getState()
      store.beginOverlayGesture()
      store.updateOverlayGesture(overlay.id, { narration: { ...overlay.narration, ...changes } })
    }
  }
  const commitOptions = (): void => { useEditorStore.getState().commitOverlayGesture() }

  const run = async (operation: string, action: () => Promise<void>): Promise<void> => {
    useEditorStore.getState().commitOverlayGesture()
    onPause?.()
    setBusy(true)
    setJobId((previous) => previous + 1)
    setProgress({ stage: 'Preparing narration', fraction: 0 })
    try { await action() } catch (reason) {
      if (!narrationWasCancelled(reason)) narrationFailure(operation, reason)
    }
    finally { setBusy(false) }
  }
  const analyze = (): void => { void run('analyze narration', async () => {
    if (!api) throw new Error('Narration is unavailable')
    const request = await prepareExportRequest(session, '')
    const selection = selectedOverlay ? range : deletionRange(session) ?? range
    const review = await api.analyze(request, [selection[0], selection[1]], 'auto', translateToEnglish, recognition)
    installReview(review)
  }) }
  const installReview = (review: NarrationReview): void => {
    install({ id: crypto.randomUUID(), type: 'audio', name: 'Re-voice', path: review.originalPath, start: review.range[0],
      duration: review.range[1] - review.range[0], sourceIn: 0, zIndex: 0, volume: 1,
      narration: { draftId: review.id, enabled: false, voiceStyle, levelVoice, backgroundVolume, slowdown, subtitles } }, undefined, true)
    setDraft(review)
  }
  const generate = (): void => { void run('generate narration', async () => {
    if (!api || !draft) return
    const request = await prepareExportRequest(session, '')
    const reviewed = JSON.stringify({ segments: draft.phrases.map((phrase) => ({ id: phrase.id, text: phrase.revisedText, originalText: phrase.text })) })
    const result = await api.generate(request, draft.id, reviewed, voiceStyle, { levelVoice, backgroundVolume, slowdown, subtitles }, overlay?.id)
    if ('review' in result) {
      installReview(result.review)
      setEditorOpen(true)
      return
    }
    install({ ...result, narration: { ...result.narration, draftId: result.narration?.draftId ?? draft.id,
      enabled: true, levelVoice, backgroundVolume, slowdown, subtitles } }, draft.originalPath)
    setEditorOpen(false)
  }) }
  const install = (result: NarrationGeneratedAudio, originalPath?: string, replaceOverlaps = false): void => {
    const replacedId = !replaceOverlaps || sameRange(range, [result.start, result.start + result.duration]) ? overlay?.id : undefined
    useEditorStore.setState((state) => installNarrationResult(state, session, result, replacedId, originalPath, replaceOverlaps))
  }
  const closeTranscript = (): void => {
    useEditorStore.getState().commitOverlayGesture()
    setEditorOpen(false)
  }
  const editPhrase = (id: string, value: string): void => {
    if (!draft) return
    const phrases = draft.phrases.map((phrase) => phrase.id === id ? { ...phrase, revisedText: value } : phrase)
    if (!overlay?.narration) setDraft((previous) => previous && { ...previous, phrases })
    if (overlay?.narration) {
      const store = useEditorStore.getState()
      store.beginOverlayGesture()
      store.updateOverlayGesture(overlay.id, { narration: { ...overlay.narration, revisions: phrases.map((phrase) => phrase.revisedText),
        originals: phrases.map((phrase) => phrase.text),
        transcriptRange: [overlay.sourceIn, overlay.sourceIn + overlay.duration] } })
    }
  }
  return <section className="asset-panel effect-menu narration-panel" data-narration-busy={busy || editorOpen ? 'true' : undefined}>
    <div className="panel-heading"><button disabled={busy} onClick={onBack}>← Back</button><strong>Re-voice</strong></div>
    <p className="empty-note">{formatTime(transcriptRange[0])} – {formatTime(transcriptRange[1])}</p>
    {!status.available && <p className="empty-note">{status.message}</p>}
    <label className="control-row"><span>Translate to English</span><input type="checkbox" aria-label="Translate to English"
      checked={translateToEnglish} disabled={!status.available || busy} onChange={(event) => { setTranslateToEnglish(event.target.checked) }} /></label>
    <label className="control-row"><span>Speech detection</span><select aria-label="Speech detection" disabled={!status.available || busy}
      value={recognition.speechDetection} onChange={(event) => { setRecognition((previous) => ({ ...previous, speechDetection: event.target.value as NarrationSpeechDetectionMode })) }}>
      {narrationSpeechDetectionModes.map((mode) => <option key={mode} value={mode}>{mode.charAt(0).toUpperCase() + mode.slice(1)}</option>)}
    </select></label>
    <label className="control-row"><span>Recognition audio</span><select aria-label="Recognition audio" disabled={!status.available || busy}
      value={recognition.audio} onChange={(event) => {
        setRecognition((previous) => ({ ...previous, audio: event.target.value as NarrationRecognitionAudio }))
      }}>
      <option value="original">Original</option><option value="speech">Cleaned speech</option>
    </select></label>
    <button className="wide-button" disabled={!status.available || busy} onClick={analyze}>Recognize</button>
    <button className="wide-button" disabled={!draft || busy} onClick={() => { onPause?.(); setEditorOpen(true) }}>Edit transcript</button>
    {!!draft?.overruns?.length && <p role="alert">Shorten the highlighted lines in Edit transcript before generating again.</p>}
    {draft && draft.stage !== 'cleaned' && <p role="alert">Recognize again before generating.</p>}
    {transcript && !busy && editorOpen && <NarrationTranscript open draft={transcript} playhead={session.playhead}
        onRetry={storedDraft?.overruns?.some((issue) => transcript.phrases.some((phrase) => phrase.id === issue.id)) ? generate : undefined} retryDisabled={!canGenerate}
        retryFrom={transcript.phrases.findIndex((phrase) => storedDraft?.overruns?.some((issue) => issue.id === phrase.id))}
        onEdit={editPhrase} onClose={closeTranscript} />}
    <label className="control-row"><span>Voice style</span><select aria-label="Voice style" disabled={!canGenerate} value={voiceStyle} onChange={(event) => {
      const style = event.target.value as NarrationVoiceStyle
      setVoiceStyle(style)
      if (overlay?.narration) useEditorStore.getState().updateOverlay(overlay.id, { narration: { ...overlay.narration, voiceStyle: style } })
    }}>{narrationVoiceStyles.map((style) => <option key={style} value={style}>{style.charAt(0).toUpperCase() + style.slice(1)}</option>)}</select></label>
    <div onBlur={commitOptions}><NumberControl label="Background" value={Math.round(backgroundVolume * 100)}
      min={0} max={100} step={5} disabled={!canGenerate} onChange={(value) => updateOptions({ backgroundVolume: value / 100 })} /></div>
    <label className="control-row"><span>Even voice volume</span><input type="checkbox" aria-label="Even voice volume"
      checked={levelVoice} disabled={!canGenerate} onChange={(event) => { updateOptions({ levelVoice: event.target.checked }); commitOptions() }} /></label>
    <div onBlur={commitOptions}><NumberControl label="Slowdown (%)" value={Math.round(slowdown * 100)}
      min={0} max={narrationMaxSlowdown * 100} step={5} disabled={!canGenerate}
      onChange={(value) => updateOptions({ slowdown: value / 100 })} /></div>
    <label className="control-row"><span>Subtitles</span><input type="checkbox" aria-label="Subtitles"
      checked={subtitles} disabled={!canGenerate} onChange={(event) => { updateOptions({ subtitles: event.target.checked }); commitOptions() }} /></label>
    <button className="wide-button" disabled={!canGenerate}
      onClick={generate}>Generate</button>
    {overlay?.narration && <>
      {overlay.narration.invalidated && <p role="alert">Video speed changed. Recognize again to keep narration synchronized.</p>}
      <label className="control-row"><span>Preview audio</span><select value={overlay.narration.enabled ? 'ai' : 'original'} onChange={(event) => {
        if (overlay.narration && (event.target.value === 'original' || canUseAi)) {
          useEditorStore.getState().updateOverlay(overlay.id, { narration: { ...overlay.narration, enabled: event.target.value === 'ai' } })
        }
      }}><option value="original">Original</option><option value="ai" disabled={!canUseAi}>AI narration</option></select></label>
    </>}
    <ExportProgress exporting={busy} title="Re-voice" job={{ id: `narration-${jobId}`, kind: 'export', state: 'running',
      progress: progress.fraction, message: progress.stage, phase: 'preparing', etaSeconds: progress.etaSeconds }}
      onCancel={() => { void api?.cancel() }} />
  </section>
}
