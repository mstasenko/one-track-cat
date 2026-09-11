interface TimedRange {
  start: number
  duration: number
}

export function timedRangesAfterInsertion<T extends TimedRange>(ranges: T[], point: number, duration: number): T[] {
  return ranges.map((range) => {
    if (range.start >= point) return { ...range, start: range.start + duration }
    if (range.start + range.duration > point) return { ...range, duration: range.duration + duration }
    return range
  })
}

export function timedRangesAfterRemoval<T extends TimedRange>(ranges: T[], start: number, end: number): T[] {
  const removed = end - start
  return ranges.flatMap((range) => {
    const rangeEnd = range.start + range.duration
    if (rangeEnd <= start) return [range]
    if (range.start >= end) return [{ ...range, start: range.start - removed }]
    const kept = Math.max(0, Math.min(rangeEnd, start) - range.start) + Math.max(0, rangeEnd - Math.max(end, range.start))
    return kept > 0.0001 ? [{ ...range, start: Math.min(range.start, start), duration: kept }] : []
  })
}
