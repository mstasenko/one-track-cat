/** Animate a uniform alpha multiplier once per frame, preserving each pixel's own alpha. */
export function frameAlphaFilter(name: string, opacity: number, expression: string): string {
  // A unity mixer still copies the whole bitmap; caption-heavy exports need no copy.
  if (expression === '1') return opacity === 1 ? 'null' : `colorchannelmixer=aa=${opacity}`
  const value = `${opacity}*(${expression})`.replaceAll(',', '\\\\,')
  return `sendcmd=c='0 [expr] colorchannelmixer@${name} aa ${value}',colorchannelmixer@${name}=aa=${opacity}`
}
