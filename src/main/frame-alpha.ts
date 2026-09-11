/** Animate a uniform alpha multiplier once per frame, preserving each pixel's own alpha. */
export function frameAlphaFilter(name: string, opacity: number, expression: string): string {
  if (expression === '1') return `colorchannelmixer=aa=${opacity}`
  const value = `${opacity}*(${expression})`.replaceAll(',', '\\\\,')
  return `sendcmd=c='0 [expr] colorchannelmixer@${name} aa ${value}',colorchannelmixer@${name}=aa=${opacity}`
}
