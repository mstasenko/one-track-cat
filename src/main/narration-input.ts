import type { ExportRequest, SourceSegment } from '../types'
import { segmentOutputDuration, segmentPlaybackRate, timelineDuration } from '../segment-time'
import { narrationDurationSamples, narrationSampleRate } from '../narration'
import { audioTempoFilter, segmentAudioEnvelope, segmentDeClick } from './segment-audio'

interface AudioPart {
  segment: SourceSegment
  index: number
  duration: number
  start: number
  end: number
}

function selectedParts(request: ExportRequest, start: number, end: number): AudioPart[] {
  let time = 0
  return request.segments.flatMap((segment, index) => {
    const duration = segmentOutputDuration(segment)
    const localStart = Math.max(0, start - time)
    const localEnd = Math.min(duration, end - time)
    time += duration
    // Timeline sums can leave a positive rounding tail at a cut. It is not an
    // audio part unless it contains at least one encodable sample.
    return Math.round((localEnd - localStart) * narrationSampleRate) > 0
      ? [{ segment, index, duration, start: localStart, end: localEnd }] : []
  })
}

export function narrationInputPartSamples(request: ExportRequest, range: readonly [number, number]): number[] {
  return selectedParts(request, range[0], range[1]).map((part) => narrationDurationSamples(part.end - part.start))
}

function decodedStart(part: AudioPart, count: number): number {
  const edge = segmentDeClick(part.duration)
  // Retain at most 10 ms preroll when the range begins inside an existing
  // join envelope. Starting a new fade at the selection boundary would click
  // or remove speech that is audible in ordinary export.
  if (part.index > 0 && part.start < edge) return 0
  return part.index < count - 1 ? Math.min(part.start, part.duration - edge) : part.start
}

function audioPart(request: ExportRequest, part: AudioPart, order: number, args: string[]): string {
  const samples = narrationDurationSamples(part.end - part.start)
  const output = `narration${order}`
  const source = request.sources.find((item) => item.id === part.segment.sourceId)
  if (!source) throw new Error('A narration audio source is missing')
  if (part.segment.kind === 'freeze' || !source.metadata.hasAudio) {
    return `anullsrc=r=${narrationSampleRate}:cl=stereo,atrim=end_sample=${samples}[${output}]`
  }
  const start = decodedStart(part, request.segments.length)
  const rate = segmentPlaybackRate(part.segment)
  const input = args.filter((value) => value === '-i').length
  args.push('-ss', (part.segment.sourceStart + start * rate).toFixed(9),
    '-t', ((part.end - start) * rate).toFixed(9), '-vn', '-sn', '-dn', '-threads', '2', '-i', source.metadata.path)
  const fadeOut = part.index < request.segments.length - 1 && part.end > part.duration - segmentDeClick(part.duration)
  const envelope = segmentAudioEnvelope(part.duration, part.index > 0, fadeOut, start)
  return `[${input}:a:0]asetpts=PTS-STARTPTS,${audioTempoFilter(rate)},aresample=${narrationSampleRate},` +
    `aformat=sample_fmts=fltp:channel_layouts=stereo${envelope},` +
    `atrim=start=${(part.start - start).toFixed(9)},asetpts=PTS-STARTPTS,` +
    `apad=whole_len=${samples},atrim=end_sample=${samples}[${output}]`
}

/** Render the edited base audio only; no video decode, AI, or added meme layers. */
export function narrationInputArgs(request: ExportRequest, range: readonly [number, number], output: string): string[] {
  const [start, end] = range
  const duration = timelineDuration(request.segments)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration) {
    throw new Error('Narration range is outside the timeline')
  }
  const samples = narrationDurationSamples(end - start)
  const parts = selectedParts(request, start, end)
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n']
  const filters = parts.map((part, order) => audioPart(request, part, order, args))
  const labels = parts.map((_, order) => `[narration${order}]`).join('')
  filters.push(`${labels}concat=n=${parts.length}:v=0:a=1,apad=whole_len=${samples},` +
    `atrim=end_sample=${samples},asetpts=PTS-STARTPTS[narrationinput]`)
  return [...args, '-filter_complex_threads', '2', '-filter_complex', filters.join(';'), '-map', '[narrationinput]',
    '-vn', '-map_metadata', '-1', '-c:a', 'pcm_f32le', '-ar', String(narrationSampleRate), output]
}
