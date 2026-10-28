import type { ExportRequest } from '../types'
import { isAudioEnabledOverlay } from '../audio-envelope'
import { addAudioOverlayFilters } from './audio-filters'

/** Audio-only narration changes need no video decoder/encoder, and no new frames. */
export function narrationCopyArgs(request: ExportRequest, output: string): string[] | null {
  const segment = request.segments[0]
  if (request.segments.length !== 1 || !segment || segment.kind === 'freeze' || segment.sourceStart !== 0 ||
    (segment.playbackRate ?? 1) !== 1 || segment.transition || request.upscale || request.faceBlurs?.length ||
    request.focusZooms?.length || request.videoTransitions?.length || request.overlays.some((item) => item.type !== 'audio') ||
    !request.overlays.some((item) => item.type === 'audio' && item.narration?.enabled)) return null
  const source = request.sources.find((item) => item.id === segment.sourceId)?.metadata
  if (!source || Math.abs(segment.sourceEnd - source.duration) > 0.000001 || source.width !== request.canvas.width ||
    source.height !== request.canvas.height || Math.abs(source.fps - request.canvas.fps) > 0.000001 ||
    !['h264', 'hevc', 'av1'].includes(source.videoCodec)) return null
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', source.path]
  const inputs = request.overlays.filter(isAudioEnabledOverlay).map((overlay, index) => {
    args.push('-i', overlay.path)
    return { overlay, index: index + 1 }
  })
  const filters = [source.hasAudio
    ? '[0:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[basea]'
    : `anullsrc=r=48000:cl=stereo,atrim=duration=${source.duration}[basea]`]
  addAudioOverlayFilters(filters, inputs, source.duration)
  return [...args, '-filter_complex_threads', '2', '-filter_complex', filters.join(';'),
    '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
    '-t', String(source.duration), '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output]
}
