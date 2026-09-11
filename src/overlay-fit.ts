import type { Overlay, ProjectCanvas } from './types'

export function overlayFit(overlay: Overlay, canvas: ProjectCanvas): 'cover' | 'contain' {
  // Full-frame videos follow the project's crop; smaller memes keep all their content.
  return overlay.type === 'video' && overlay.width >= 0.999 && overlay.height >= 0.999
    ? canvas.fit
    : 'contain'
}
