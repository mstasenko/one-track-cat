import { describe, expect, it } from 'vitest'
import { referencedExportSources } from './export-sources'
import type { ExportSource, SourceSegment } from './types'

describe('export source selection', () => {
  it('includes only sources referenced by current timeline segments', () => {
    const metadata = {
      path: '/used.mp4', name: 'used.mp4', size: 10, modifiedAt: 1, duration: 3,
      width: 1280, height: 720, fps: 30, videoCodec: 'h264',
      hasAudio: true
    }
    const sources: ExportSource[] = [
      { id: 'used', metadata },
      { id: 'deleted', metadata: { ...metadata, path: '/deleted.mp4', name: 'deleted.mp4' } }
    ]
    const segments: SourceSegment[] = [{ id: 'segment', sourceId: 'used', sourceStart: 0, sourceEnd: 3 }]
    expect(referencedExportSources(sources, segments).map((source) => source.id)).toEqual(['used'])
  })
})
