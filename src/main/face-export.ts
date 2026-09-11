import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExportRequest, FaceBlurEffect, HardwareLabel } from '../types'
import { ffmpegPath } from './binaries'
import { exportEncoders, hardwareLabelForRenderNode, softwareEncoder, type ExportEncoder } from './export-encoder'
import { requireFacePack } from './face-pack'
import { FaceAuthorizationError, runFacePipeline, type FaceCommand, type FacePipelineCommands, type FacePipelineOptions } from './face-process'
import { prepareFaceDetectionCache, type FaceDetectionCacheSession } from './face-detection-cache'
import { buildFaceWorkerCommand, nativeFaceWorkerCommand, restrictedIntelRenderNode } from './face-worker'
import { nutVideoRemuxCommand, privilegedFacePipelineCommand, privilegedVideoEncoderCommand, vaapiFfmpegPath } from './privileged-export'
import { jobs } from './jobs'

export function faceEffectRows(effects: FaceBlurEffect[]): string {
  const styles = { pixelate: 0, blur: 1, mask: 2 }
  return effects.map((effect) => [
    effect.start, effect.start + effect.duration, effect.sensitivity,
    effect.detail === 'small' ? 1 : 0, effect.holdSeconds, effect.strength, styles[effect.style]
  ].join('\t')).join('\n') + '\n'
}

export interface FaceDetectionContext {
  sourceRequest: ExportRequest
  frameOffset: number
  preparationStart?: number
}

function appendWorkerArgs(command: FaceCommand, args: string[]): FaceCommand {
  return args.length ? { ...command, args: [...command.args, ...args] } : command
}

const faceEncodingLabel = (hardware: HardwareLabel | undefined): string =>
  hardware ? `Encoding video using ${hardware}` : 'Encoding video'
const authorizationRetryMessage = 'GPU authorization unavailable or declined; using CPU…'

function pipelineOptions(
  session: FaceDetectionCacheSession,
  options: FacePipelineOptions
): FacePipelineOptions {
  return { ...options, onWorkerStderr: session.onWorkerStderr }
}

function decoderCommand(
  inputArgs: string[],
  filter: { graph: string; videoLabel: string; audioLabel: string },
  duration: number,
  audio: string
): FaceCommand {
  return { executable: ffmpegPath(), args: [
    ...inputArgs, '-y', '-filter_complex_threads', '4', '-filter_complex', filter.graph,
    '-map', `[${filter.videoLabel}]`, '-t', String(duration), '-an', '-pix_fmt', 'rgb24', '-threads', '2', '-f', 'rawvideo', 'pipe:1',
    '-map', `[${filter.audioLabel}]`, '-t', String(duration), '-vn', '-c:a', 'aac', '-b:a', '256k', audio
  ] }
}

function rawVideoEncoderCommand(
  encoder: ExportEncoder,
  width: number,
  height: number,
  fps: number,
  duration: number,
  video: string
): FaceCommand {
  return {
    executable: encoder.executable,
    args: [
      ...encoder.input, '-hide_banner', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`,
      '-framerate', String(fps), '-i', 'pipe:0', '-an', '-t', String(duration),
      ...(encoder.rawVideoFilter ? ['-vf', encoder.rawVideoFilter] : []), ...encoder.output,
      '-progress', 'pipe:1', '-nostats', video
    ],
    ...(encoder.rawVideoFilter ? { gpuWorker: true } : {})
  }
}

function pipelineCommands(
  request: ExportRequest,
  inputArgs: string[],
  filter: { graph: string; videoLabel: string; audioLabel: string },
  duration: number,
  audio: string,
  video: string,
  worker: FaceCommand,
  encoder: ExportEncoder
): FacePipelineCommands {
  const { width, height, fps } = request.canvas
  const commands: FacePipelineCommands = [
    decoderCommand(inputArgs, filter, duration, audio),
    worker,
    rawVideoEncoderCommand(encoder, width, height, fps, duration, video)
  ]
  return commands
}

function privilegedPipelineCommands(
  request: ExportRequest,
  inputArgs: string[],
  filter: { graph: string; videoLabel: string; audioLabel: string },
  duration: number,
  audio: string,
  video: string,
  worker: FaceCommand,
  renderNode: string,
  hardwareExecutable: string
): FacePipelineCommands {
  const { width, height, fps } = request.canvas
  const encoder = privilegedVideoEncoderCommand({ width, height, fps }, duration, renderNode, hardwareExecutable)
  if (worker.elevated && encoder.elevated) {
    return [
      decoderCommand(inputArgs, filter, duration, audio),
      privilegedFacePipelineCommand(worker, encoder),
      nutVideoRemuxCommand(video)
    ]
  }
  const commands: FacePipelineCommands = [
    decoderCommand(inputArgs, filter, duration, audio),
    worker,
    encoder,
    nutVideoRemuxCommand(video)
  ]
  return commands
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.message === 'Job cancelled'
}

function isHardwareEncoder(encoder: ExportEncoder): boolean {
  return encoder.rawVideoFilter !== undefined
}

export async function encodeWithFaces(
  request: ExportRequest,
  inputArgs: string[],
  filter: { graph: string; videoLabel: string; audioLabel: string },
  directory: string,
  output: string,
  duration: number,
  jobId: string,
  context?: FaceDetectionContext
): Promise<void> {
  const pack = await requireFacePack()
  const cacheRequest = context?.sourceRequest ?? request
  const cacheFrameOffset = context?.frameOffset ?? 0
  let cache = await prepareFaceDetectionCache(cacheRequest, cacheFrameOffset)
  try {
    const effects = join(directory, 'faces.tsv')
    const video = join(directory, 'masked.mp4')
    const audio = join(directory, 'audio.m4a')
    await writeFile(effects, faceEffectRows(request.faceBlurs ?? []))
    // Composite once, detect every final frame, then encode once. Audio is muxed back without re-encoding.
    // Face encoding reuses ordinary-export encoder settings so quality and thread bounds stay aligned.
    const preparationEnd = context && Number.isFinite(request.canvas.fps) && request.canvas.fps > 0
      ? context.frameOffset / request.canvas.fps
      : undefined
    const preparationProgress = context && preparationEnd !== undefined && preparationEnd > 0
      ? { preparationStart: context.preparationStart ?? 0, preparationEnd }
      : {}
    const workerForAttempt = async (forceCpu: boolean): Promise<FaceCommand> => {
      const worker = forceCpu || cache.hasCompleteDetections === true
        ? nativeFaceWorkerCommand(pack, request.canvas, effects, 'CPU')
        : await buildFaceWorkerCommand(pack, request.canvas, effects)
      return appendWorkerArgs(worker, cache.workerArgs)
    }
    const refreshCacheForRetry = async (): Promise<void> => {
      // A failed encoder does not invalidate completed detection rows. Freeze
      // them as the next attempt's input; this function retains cleanup ownership.
      await cache.commit()
      await cache.cleanup()
      cache = await prepareFaceDetectionCache(cacheRequest, cacheFrameOffset)
    }
    const runAttempt = async (encoder: ExportEncoder, forceCpu: boolean, message?: string): Promise<void> => {
      const worker = await workerForAttempt(forceCpu)
      await rm(video, { force: true })
      await runFacePipeline(
        pipelineCommands(request, inputArgs, filter, duration, audio, video, worker, encoder),
        jobId, duration, pipelineOptions(cache, {
          label: faceEncodingLabel(encoder.hardwareLabel), phase: 'encoding',
          authorizationMessage: authorizationRetryMessage,
          ...(message ? { message } : {}),
          ...(forceCpu ? { hardwareLabel: 'CPU' as const } : {}),
          encodingHardwareLabel: encoder.hardwareLabel, ...preparationProgress
        })
      )
    }
    let fallbackMessage = ''
    let forceCpuWorker = false
    let restrictedAttemptStarted = false
    const prepareFallback = async (error: unknown): Promise<boolean> => {
      if (isCancellation(error)) throw error
      const denied = error instanceof FaceAuthorizationError
      fallbackMessage = denied ? authorizationRetryMessage : 'GPU video encoding unavailable; using CPU…'
      await refreshCacheForRetry()
      return denied
    }
    let encoded = false
    const restrictedNode = await restrictedIntelRenderNode()
    if (restrictedNode) {
      try {
        const executable = await vaapiFfmpegPath()
        const worker = await workerForAttempt(false)
        const hardware = await hardwareLabelForRenderNode(restrictedNode)
        await rm(video, { force: true })
        restrictedAttemptStarted = true
        await runFacePipeline(
          privilegedPipelineCommands(request, inputArgs, filter, duration, audio, video, worker, restrictedNode, executable),
          jobId, duration, pipelineOptions(cache, {
            label: faceEncodingLabel(hardware), phase: 'encoding',
            authorizationMessage: authorizationRetryMessage,
            encodingHardwareLabel: hardware, ...preparationProgress
          })
        )
        encoded = true
      } catch (error) {
        forceCpuWorker = await prepareFallback(error) || restrictedAttemptStarted
      }
    }
    if (!encoded) {
      const candidates = restrictedNode ? [] : await exportEncoders()
      for (const encoder of candidates.filter(isHardwareEncoder)) {
        try {
          await runAttempt(encoder, forceCpuWorker)
          encoded = true
          fallbackMessage = ''
          break
        } catch (error) {
          forceCpuWorker = await prepareFallback(error) || forceCpuWorker
        }
      }
      if (!encoded) {
        const cpu = candidates.find((encoder) => !isHardwareEncoder(encoder)) ?? softwareEncoder()
        try {
          await runAttempt(cpu, forceCpuWorker, fallbackMessage || undefined)
        } catch (error) {
          // CPU encoding can still have a GPU detector. Retry that detector
          // once on CPU after authorization denial, not after user cancellation.
          if (!(error instanceof FaceAuthorizationError) || forceCpuWorker) throw error
          await prepareFallback(error)
          await runAttempt(cpu, true, fallbackMessage)
        }
      }
    }
    await jobs.run(ffmpegPath(), [
      '-hide_banner', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
      '-c', 'copy', '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output
    ], 'export', duration, jobId, fallbackMessage, { phase: 'finalizing', announce: false })
    await cache.commit()
  } finally {
    await cache.cleanup()
  }
}
