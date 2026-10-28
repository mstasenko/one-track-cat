/** Shared by ordinary export and narration's audio-only selected-range render. */
export function audioTempoFilter(rate: number): string {
  if (rate === 1) return 'anull'
  const factors = rate === 0.25 ? [0.5, 0.5] : rate === 4 ? [2, 2] : [rate]
  return factors.map((factor) => `atempo=${factor}`).join(',')
}

export function segmentDeClick(duration: number): number {
  return Math.min(0.01, duration / 2)
}

export function segmentAudioEnvelope(duration: number, fadeIn: boolean, fadeOut: boolean, offset = 0): string {
  const edge = segmentDeClick(duration)
  if (edge <= 0) return ''
  const entrance = fadeIn && offset === 0 ? `,afade=t=in:st=0:d=${edge.toFixed(6)}` : ''
  const exit = fadeOut ? `,afade=t=out:st=${Math.max(0, duration - edge - offset).toFixed(6)}:d=${edge.toFixed(6)}` : ''
  return entrance + exit
}
