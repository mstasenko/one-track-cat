import { DUCK_ATTACK, DUCK_RELEASE, NARRATION_EDGE, effectiveFadeDurations, isAudioEnabledOverlay, narrationReplacementRanges } from '../audio-envelope'
import type { AudioEnabledOverlay } from '../audio-envelope'
import type { Overlay } from '../types'

interface AudioPreparedInput {
  overlay: Overlay
  index: number
}

function isAudioInput(input: AudioPreparedInput): input is AudioPreparedInput & { overlay: AudioEnabledOverlay } {
  return isAudioEnabledOverlay(input.overlay)
}

function decimal(value: number): string {
  return Math.max(0, value).toFixed(6)
}

function smoothstep(value: string): string {
  const progress = `min(1,max(0,${value}))`
  return `(${progress}*${progress}*(3-2*${progress}))`
}

function narrationGain(duration: number, time: string): string {
  const edge = decimal(Math.min(NARRATION_EDGE, duration / 2))
  return `if(between(${time},0,${decimal(duration)}),${smoothstep(`min(${time},${decimal(duration)}-(${time}))/${edge}`)},0)`
}

export function overlayVolumeExpression(
  overlay: Extract<Overlay, { type: 'audio' | 'video' }>
): string {
  if (overlay.type === 'audio' && overlay.narration) return narrationGain(overlay.duration, 't')
  const { fadeIn, fadeOut } = effectiveFadeDurations(overlay.duration, overlay.fadeIn, overlay.fadeOut)
  if (fadeIn === 0 && fadeOut === 0) return decimal(overlay.volume)
  const entrance = fadeIn > 0 ? smoothstep(`t/${decimal(fadeIn)}`) : '1'
  const exit = fadeOut > 0 ? smoothstep(`(${decimal(overlay.duration)}-t)/${decimal(fadeOut)}`) : '1'
  return `${decimal(overlay.volume)}*min(${entrance},${exit})`
}

function duckExpression(
  overlay: Extract<Overlay, { type: 'audio' | 'video' }>,
  timelineDuration: number
): string | null {
  if (overlay.type === 'audio' && overlay.narration?.enabled) {
    return null // The combined replacement ranges below keep touching sections muted continuously.
  }
  if (!overlay.duckGameAudio || overlay.volume <= 0.0001) return null
  const level = overlay.gameAudioLevel ?? 0.3
  const start = Math.min(timelineDuration, Math.max(0, overlay.start))
  const end = Math.min(timelineDuration, Math.max(start, overlay.start + overlay.duration))
  const attackStart = Math.max(0, start - DUCK_ATTACK)
  const releaseEnd = Math.min(timelineDuration, end + DUCK_RELEASE)
  const active = `if(lte(t,${decimal(end)}),${decimal(level)},` +
    `${decimal(level)}+(1-${decimal(level)})*${smoothstep(`(t-${decimal(end)})/${decimal(DUCK_RELEASE)}`)})`
  const withAttack = attackStart < start
    ? `if(lt(t,${decimal(start)}),1-(1-${decimal(level)})*${smoothstep(`(t-${decimal(attackStart)})/${decimal(start - attackStart)}`)},${active})`
    : active
  return `if(between(t,${decimal(attackStart)},${decimal(releaseEnd)}),${withAttack},1)`
}

function combinedDuckExpression(
  inputs: AudioPreparedInput[],
  timelineDuration: number
): string | null {
  const expressions = narrationReplacementRanges(inputs.map(({ overlay }) => overlay)).map(([start, end]) =>
    `1-(${narrationGain(end - start, `(t-${decimal(start)})`)})`)
  expressions.push(...inputs.flatMap(({ overlay }) => {
    if (!isAudioEnabledOverlay(overlay)) return []
    const expression = duckExpression(overlay, timelineDuration)
    return expression ? [expression] : []
  }))
  return expressions.reduce<string | null>(
    (combined, expression) => combined ? `min(${combined},${expression})` : expression,
    null
  )
}

export function addAudioOverlayFilters(
  filters: string[],
  inputs: AudioPreparedInput[],
  timelineDuration: number
): void {
  const audibleInputs = inputs.filter(isAudioInput)
  const duck = combinedDuckExpression(audibleInputs, timelineDuration)
  const baseLabel = duck ? 'duckedbase' : 'basea'
  const replacement = audibleInputs.some(({ overlay }) => overlay.type === 'audio' && overlay.narration)
  if (duck) filters.push(replacement
    ? `[basea]aeval=exprs='val(0)*(${duck})|val(1)*(${duck})':c=stereo[duckedbase]`
    : `[basea]volume='${duck}':eval=frame[duckedbase]`)
  const audioLabels = [`[${baseLabel}]`]
  audibleInputs.forEach(({ overlay, index }, order) => {
    const delay = Math.round(overlay.start * 1000)
    const volume = overlayVolumeExpression(overlay)
    const evalOption = volume === decimal(overlay.volume) ? '' : ':eval=frame'
    const gain = overlay.type === 'audio' && overlay.narration
      ? `aformat=channel_layouts=stereo,aeval=exprs='val(0)*(${volume})|val(1)*(${volume})':c=stereo`
      : `volume='${volume}'${evalOption}`
    filters.push(
      `[${index}:a:0]atrim=start=${decimal(overlay.sourceIn)}:end=${decimal(overlay.sourceIn + overlay.duration)},` +
      `asetpts=PTS-STARTPTS,${gain},adelay=${delay}|${delay}[aov${order}]`
    )
    audioLabels.push(`[aov${order}]`)
  })
  if (audioLabels.length > 1) {
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,` +
      `${replacement ? 'aformat=channel_layouts=stereo,' : ''}alimiter=limit=0.95[aout]`)
  } else {
    filters.push(`[${baseLabel}]alimiter=limit=0.95[aout]`)
  }
}
