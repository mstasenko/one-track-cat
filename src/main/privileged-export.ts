import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ExportRequest, ProjectCanvas } from '../types'
import { ffmpegPath, hardwareFfmpegCandidates } from './binaries'
import { hardwareLabelForRenderNode, vaapiCodecOutput, vaapiCodecs, vaapiProbeArgs } from './export-encoder'
import { runFacePipeline, type FaceCommand } from './face-process'
import { jobs } from './jobs'

const execFileAsync = promisify(execFile)

interface ExportFilter {
  graph: string
  videoLabel: string
  audioLabel: string
}

const pkexecPath = '/usr/bin/pkexec'
const bashPath = '/bin/bash'
const combinedPipelineScript = 'count=$1; shift; detector=("${@:1:count}"); shift "$count"; "${detector[@]}" | "$@"'
const encoderProbeScript = [
  'candidate_count=$1',
  'shift',
  'for ((candidate=0; candidate<candidate_count; candidate++)); do',
  '  probe_count=$1',
  '  shift',
  '  probe=("${@:1:probe_count}")',
  '  shift "$probe_count"',
  '  stream_count=$1',
  '  shift',
  '  stream=("${@:1:stream_count}")',
  '  shift "$stream_count"',
  '  if "${probe[@]}" </dev/null >/dev/null 2>/dev/null; then',
  '    exec "${stream[@]}"',
  '  fi',
  'done',
  'exit 1'
].join('\n')

function hasVaapiEncoder(output: string): boolean {
  const pattern = new RegExp(`^\\s*V\\S*\\s+(?:${vaapiCodecs.join('|')})(?:\\s|$)`)
  return output.split(/\r?\n/).some((line) => pattern.test(line))
}

export async function vaapiFfmpegPath(): Promise<string> {
  for (const executable of hardwareFfmpegCandidates()) {
    try {
      const result = await execFileAsync(executable, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
      if (hasVaapiEncoder(result.stdout)) return executable
    } catch {
      // Try the next trusted FFmpeg candidate.
    }
  }
  throw new Error('No FFmpeg executable with VAAPI video encoding support is available')
}

/**
 * Privileged encoding writes only to stdout. The following unprivileged
 * process owns every output file written to disk.
 */
export function privilegedVideoEncoderCommand(
  canvas: Pick<ProjectCanvas, 'width' | 'height' | 'fps'>,
  duration: number,
  renderNode: string,
  hardwareExecutable: string
): FaceCommand {
  const candidateArgs = vaapiCodecs.flatMap((codec) => {
    const probe = [hardwareExecutable, ...vaapiProbeArgs(renderNode, codec)]
    const stream = [
      hardwareExecutable, '-hide_banner', '-loglevel', 'error', '-filter_threads', '4', '-threads', '4',
      '-vaapi_device', renderNode,
      '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${canvas.width}x${canvas.height}`, '-framerate', String(canvas.fps),
      '-i', 'pipe:0', '-an', '-vf', 'format=nv12,hwupload', ...vaapiCodecOutput(codec),
      '-t', String(duration), '-f', 'nut', 'pipe:1'
    ]
    return [String(probe.length), ...probe, String(stream.length), ...stream]
  })
  return {
    executable: pkexecPath,
    args: ['--disable-internal-agent', bashPath, '-o', 'pipefail', '-c', encoderProbeScript, '--', String(vaapiCodecs.length), ...candidateArgs],
    elevated: true
  }
}

function unwrappedPrivilegedCommand(command: FaceCommand): { executable: string; args: string[] } {
  if (command.executable !== pkexecPath || command.args[0] !== '--disable-internal-agent') {
    return { executable: command.executable, args: command.args }
  }
  const executable = command.args[1]
  if (!executable) throw new Error('Privileged pipeline command has no inner executable')
  return { executable, args: command.args.slice(2) }
}

/** Combines detector and encoder under one authorization prompt without shell interpolation. */
export function privilegedFacePipelineCommand(detector: FaceCommand, encoder: FaceCommand): FaceCommand {
  const innerDetector = unwrappedPrivilegedCommand(detector)
  const innerEncoder = unwrappedPrivilegedCommand(encoder)
  const detectorArgs = [innerDetector.executable, ...innerDetector.args]
  const encoderArgs = [innerEncoder.executable, ...innerEncoder.args]
  return {
    executable: pkexecPath,
    args: [
      '--disable-internal-agent', bashPath, '-o', 'pipefail', '-c', combinedPipelineScript, '--',
      String(detectorArgs.length), ...detectorArgs, ...encoderArgs
    ],
    elevated: true
  }
}

/** The remux writer deliberately runs as the calling user, never under pkexec. */
export function nutVideoRemuxCommand(output: string, executable = ffmpegPath()): FaceCommand {
  return { executable, args: [
    '-hide_banner', '-y', '-f', 'nut', '-i', 'pipe:0', '-c:v', 'copy', '-an', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', output
  ] }
}

function privilegedPipelineCommands(
  request: ExportRequest,
  inputArgs: string[],
  filter: ExportFilter,
  directory: string,
  duration: number,
  renderNode: string,
  hardwareExecutable: string
): [FaceCommand, FaceCommand, FaceCommand] {
  const { width, height, fps } = request.canvas
  const normalExecutable = ffmpegPath()
  const audio = join(directory, 'gpu-audio.m4a')
  const video = join(directory, 'gpu-video.mp4')
  return [
    { executable: normalExecutable, args: [
      ...inputArgs, '-y', '-filter_complex_threads', '4', '-filter_complex', filter.graph,
      '-map', `[${filter.videoLabel}]`, '-t', String(duration), '-an', '-pix_fmt', 'rgb24', '-threads', '2', '-f', 'rawvideo', 'pipe:1',
      '-map', `[${filter.audioLabel}]`, '-t', String(duration), '-vn', '-c:a', 'aac', '-b:a', '256k', audio
    ] },
    privilegedVideoEncoderCommand({ width, height, fps }, duration, renderNode, hardwareExecutable),
    nutVideoRemuxCommand(video, normalExecutable)
  ]
}

export async function encodeWithPrivilegedGpu(
  request: ExportRequest,
  inputArgs: string[],
  filter: ExportFilter,
  directory: string,
  output: string,
  duration: number,
  jobId: string,
  renderNode: string
): Promise<void> {
  const executable = await vaapiFfmpegPath()
  const audio = join(directory, 'gpu-audio.m4a')
  const video = join(directory, 'gpu-video.mp4')
  const hardwareLabel = await hardwareLabelForRenderNode(renderNode)
  await runFacePipeline(
    privilegedPipelineCommands(request, inputArgs, filter, directory, duration, renderNode, executable),
    jobId,
    duration,
    {
      label: hardwareLabel ? `Encoding video using ${hardwareLabel}` : 'Encoding video', phase: 'encoding',
      authorizationMessage: 'GPU video encoding authorization was denied, cancelled, or unavailable',
      ...(hardwareLabel === undefined ? {} : { hardwareLabel })
    }
  )
  await jobs.run(ffmpegPath(), [
    '-hide_banner', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
    '-c', 'copy', '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output
  ], 'export', duration, jobId, '', { phase: 'finalizing', announce: false })
}
