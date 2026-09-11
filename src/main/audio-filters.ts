import { DUCK_ATTACK, DUCK_RELEASE, effectiveFadeDurations, isAudioEnabledOverlay } from '../audio-envelope'
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

export function overlayVolumeExpression(
  overlay: Extract<Overlay, { type: 'audio' | 'video' }>
): string {
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
  const expressions = inputs.flatMap(({ overlay }) => {
    if (!isAudioEnabledOverlay(overlay)) return []
    const expression = duckExpression(overlay, timelineDuration)
    return expression ? [expression] : []
  })
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
  if (duck) filters.push(`[basea]volume='${duck}':eval=frame[duckedbase]`)
  const audioLabels = [`[${baseLabel}]`]
  audibleInputs.forEach(({ overlay, index }, order) => {
    const delay = Math.round(overlay.start * 1000)
    const volume = overlayVolumeExpression(overlay)
    const evalOption = volume === decimal(overlay.volume) ? '' : ':eval=frame'
    filters.push(
      `[${index}:a:0]atrim=start=${decimal(overlay.sourceIn)}:end=${decimal(overlay.sourceIn + overlay.duration)},` +
      `asetpts=PTS-STARTPTS,volume='${volume}'${evalOption},adelay=${delay}|${delay}[aov${order}]`
    )
    audioLabels.push(`[aov${order}]`)
  })
  if (audioLabels.length > 1) {
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95[aout]`)
  } else {
    filters.push(`[${baseLabel}]alimiter=limit=0.95[aout]`)
  }
}
