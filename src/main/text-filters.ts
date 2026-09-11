import type { AnimationTiming, TextAnimationPreset, TextOverlay } from '../types'
import { frameAlphaFilter } from './frame-alpha'

interface AnimationExpressions {
  opacity: string
  scale: string
  x: string
  y: string
}

function decimal(value: number): string {
  return Math.max(0, value).toFixed(6)
}

function positiveDecimal(value: number): string {
  return Math.max(0.000001, value).toFixed(6)
}

function smooth(expression: string): string {
  const progress = `min(1,max(0,${expression}))`
  return `(${progress})*(${progress})*(3-2*(${progress}))`
}

function entranceExpressions(preset: 'pop' | 'bounce', duration: number, time: string, timing: AnimationTiming): AnimationExpressions {
  const entrance = timing.duration === undefined
    ? Math.min(preset === 'pop' ? 0.28 : 0.38, duration / 2)
    : Math.min(duration, timing.duration)
  const split = entrance * (preset === 'pop' ? 0.65 : 0.6)
  const first = smooth(`${time}/${positiveDecimal(split)}`)
  const settle = smooth(`(${time}-${decimal(split)})/${positiveDecimal(entrance - split)}`)
  if (preset === 'pop') {
    return {
      opacity: `if(lt(${time},${decimal(split)}),${first},1)`,
      scale: `if(lt(${time},${decimal(split)}),0.65+0.47*${first},if(lt(${time},${decimal(entrance)}),1.12-0.12*${settle},1))`,
      x: '0', y: '0'
    }
  }
  return {
    opacity: `if(lt(${time},${decimal(split)}),${first},1)`,
    scale: `if(lt(${time},${decimal(split)}),0.92+0.11*${first},if(lt(${time},${decimal(entrance)}),1.03-0.03*${settle},1))`,
    x: '0',
    y: `if(lt(${time},${decimal(split)}),0.2-0.26*${first},if(lt(${time},${decimal(entrance)}),-0.06+0.06*${settle},0))`
  }
}

function fadeExpressions(duration: number, time: string, timing: AnimationTiming): AnimationExpressions {
  const defaultRamp = Math.min(0.22, duration / 2)
  const fadeIn = Math.min(duration, timing.fadeIn ?? defaultRamp)
  const fadeOut = Math.min(duration, timing.fadeOut ?? defaultRamp)
  const entrance = fadeIn === 0 ? '1' : smooth(`${time}/${positiveDecimal(fadeIn)}`)
  const exit = fadeOut === 0 ? '1' : smooth(`(${decimal(duration)}-${time})/${positiveDecimal(fadeOut)}`)
  return { opacity: `min(${entrance},${exit})`, scale: '1', x: '0', y: '0' }
}

function shakeExpressions(duration: number, time: string, timing: AnimationTiming): AnimationExpressions {
  const window = timing.duration === undefined ? Math.min(0.55, duration) : Math.min(duration, timing.duration)
  const progress = `min(1,max(0,${time}/${positiveDecimal(window)}))`
  const amplitude = `pow(1-${progress},2)`
  return {
    opacity: '1', scale: '1',
    x: `if(lt(${time},${decimal(window)}),0.025*${amplitude}*sin(9*PI*${progress}),0)`,
    y: `if(lt(${time},${decimal(window)}),0.012*${amplitude}*sin(13*PI*${progress}),0)`
  }
}

function presetExpressions(preset: TextAnimationPreset, duration: number, time: string, timing: AnimationTiming): AnimationExpressions {
  if (preset !== 'fade' && timing.duration !== undefined && timing.duration <= 0) return { opacity: '1', scale: '1', x: '0', y: '0' }
  switch (preset) {
    case 'none': return { opacity: '1', scale: '1', x: '0', y: '0' }
    case 'fade': return fadeExpressions(duration, time, timing)
    case 'pop': return entranceExpressions('pop', duration, time, timing)
    case 'bounce': return entranceExpressions('bounce', duration, time, timing)
    case 'shake': return shakeExpressions(duration, time, timing)
  }
}

export function textAnimationFilterExpressions(preset: TextAnimationPreset | undefined, duration: number, time = 't', timing: AnimationTiming = {}): AnimationExpressions {
  if (preset === undefined) return { opacity: '1', scale: '1', x: '0', y: '0' }
  return presetExpressions(preset, duration, time, timing)
}

function addStaticTextFilters(
  filters: string[], overlay: TextOverlay, inputIndex: number, order: number, inputLabel: string
): string {
  const outputLabel = `vout${order}`
  const x = overlay.renderedTextBitmap?.x ?? 0
  const y = overlay.renderedTextBitmap?.y ?? 0
  filters.push(
    `[${inputIndex}:v:0]trim=duration=${decimal(overlay.duration)},setpts=PTS-STARTPTS+${decimal(overlay.start)}/TB,format=rgba,colorchannelmixer=aa=${overlay.opacity}[ov${order}]`,
    `[${inputLabel}][ov${order}]overlay=x=${x}:y=${y}:eof_action=pass:repeatlast=1:enable='between(t,${decimal(overlay.start)},${decimal(overlay.start + overlay.duration)})'[${outputLabel}]`
  )
  return outputLabel
}

function addAnimatedTextFilters(
  filters: string[], overlay: TextOverlay & { renderedTextBitmap: NonNullable<TextOverlay['renderedTextBitmap']> },
  inputIndex: number, order: number, inputLabel: string, canvas: { width: number; height: number }
): string {
  const outputLabel = `vout${order}`
  const bitmap = overlay.renderedTextBitmap
  const timing = { duration: overlay.animationDuration, fadeIn: overlay.animationFadeIn, fadeOut: overlay.animationFadeOut }
  const expression = textAnimationFilterExpressions(overlay.animation, overlay.duration, 't', timing)
  const alphaExpression = textAnimationFilterExpressions(overlay.animation, overlay.duration, 'T', timing)
  const outputExpression = textAnimationFilterExpressions(overlay.animation, overlay.duration, `(t-${decimal(overlay.start)})`, timing)
  const width = `max(2,2*round(iw*(${expression.scale})/2))`
  const height = `max(2,2*round(ih*(${expression.scale})/2))`
  const alpha = frameAlphaFilter(`textalpha${order}`, overlay.opacity, alphaExpression.opacity)
  const x = `${bitmap.anchorX}-overlay_w/2+(${outputExpression.x})*${canvas.width * overlay.width}`
  const y = `${bitmap.anchorY}-overlay_h/2+(${outputExpression.y})*${canvas.height * overlay.height}`
  filters.push(
    `[${inputIndex}:v:0]trim=duration=${decimal(overlay.duration)},setpts=PTS-STARTPTS,scale=w='${width}':h='${height}':eval=frame,format=rgba,` +
      `${alpha},setpts=PTS-STARTPTS+${decimal(overlay.start)}/TB[ov${order}]`,
    `[${inputLabel}][ov${order}]overlay=x='${x}':y='${y}':eval=frame:eof_action=pass:repeatlast=1:` +
      `enable='between(t,${decimal(overlay.start)},${decimal(overlay.start + overlay.duration)})'[${outputLabel}]`
  )
  return outputLabel
}

export function addTextOverlayFilters(
  filters: string[],
  overlay: TextOverlay,
  inputIndex: number,
  order: number,
  inputLabel: string,
  canvas: { width: number; height: number }
): string {
  const bitmap = overlay.renderedTextBitmap
  if (!bitmap || !overlay.animation || overlay.animation === 'none') {
    return addStaticTextFilters(filters, overlay, inputIndex, order, inputLabel)
  }
  return addAnimatedTextFilters(filters, { ...overlay, renderedTextBitmap: bitmap }, inputIndex, order, inputLabel, canvas)
}
