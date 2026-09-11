import type { Overlay } from '@shared/types'
import { textAnimationAtTime } from '../model/text-animation'

export function overlayAnimationStyle(
  overlay: Exclude<Overlay, { type: 'audio' }>,
  outputTime: number
): React.CSSProperties {
  if (overlay.type === 'gif') return {}
  const timing = {
    fadeIn: overlay.animationFadeIn,
    fadeOut: overlay.animationFadeOut,
    duration: overlay.animationDuration
  }
  const frame = textAnimationAtTime(overlay.animation, outputTime - overlay.start, overlay.duration, timing)
  return {
    opacity: frame.opacity,
    transform: `translate(${frame.translateX * 100}%, ${frame.translateY * 100}%) scale(${frame.scale})`
  }
}
