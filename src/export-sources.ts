import type { ExportSource, SourceSegment } from './types'

export function referencedExportSources(
  sources: readonly ExportSource[],
  segments: readonly SourceSegment[]
): ExportSource[] {
  const usedIds = new Set(segments.map((segment) => segment.sourceId))
  return sources
    .filter((source) => usedIds.has(source.id))
    .map(({ id, metadata }) => ({ id, metadata }))
}
