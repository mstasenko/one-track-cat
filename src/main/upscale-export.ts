import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { upscalePlan, upscaleSourceFrame, flashSpatialSupportMessage, isFlashSpatialSupported, type UpscalePlan } from '../upscale'
import type { UpscaleMode, ExportRequest, ProjectCanvas } from '../types'
import type { UpscalePack } from './upscale-pack'
import { ffmpegPath } from './binaries'
import { exportEncoders, softwareEncoder, type ExportEncoder } from './export-encoder'
import { prepareFaceDetectionCache, type FaceDetectionCacheSession } from './face-detection-cache'
import { decoderCommand, faceEffectRows, rawVideoEncoderCommand } from './face-export'
import { prepareFfmpegArguments } from './ffmpeg-arguments'
import { requireFacePack } from './face-pack'
import { ensureFaceModels } from './face-models'
import { FaceAuthorizationError, runFacePipeline, type FaceCommand, type FacePipelineCommands } from './face-process'
import { nativeFaceWorkerCommand } from './face-worker'
import { restrictedIntelRenderNode } from './intel-device'
import { jobs } from './jobs'
import { nutVideoRemuxCommand, privilegedFacePipelineCommand, privilegedVideoEncoderCommand, vaapiFfmpegPath } from './privileged-export'

async function removeScratchFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}

/** Keep the canvas's aspect ratio, including portrait Shorts, without stretching or downscaling. */
export function upscaleExportCanvas(canvas: ProjectCanvas): ProjectCanvas {
  return upscalePlan(canvas).canvas
}

/** Resolved once by the whole-export preflight and reused by every AI worker attempt. */
export interface UpscaleExportContext {
  plan: UpscalePlan
  pack: UpscalePack
}

export function upscaleWorkerCommand(
  pack: UpscalePack,
  input: ProjectCanvas,
  output: ProjectCanvas,
  duration: number,
  cpu: boolean,
  mode?: UpscaleMode,
  scratch?: string,
  spatialRanges?: [number, number][],
  interpolationRanges?: [number, number][]
): FaceCommand {
  const args = [
    ...(pack.models ? ['--models', pack.models] : []), '--rife', pack.rife,
    ...(mode ? ['--mode', mode, ...(scratch ? ['--scratch', scratch] : [])] : []),
    ...(spatialRanges ?? []).flatMap(([start, end]) => {
      const first = upscaleSourceFrame(Math.min(start, duration), input.fps)
      const stop = upscaleSourceFrame(Math.min(end, duration), input.fps)
      return stop > first ? ['--spatial-range', `${first}:${stop}`] : []
    }),
    ...(interpolationRanges ?? []).flatMap(([start, end]) => {
      const first = upscaleSourceFrame(Math.min(start, duration), input.fps)
      const stop = upscaleSourceFrame(Math.min(end, duration), input.fps)
      return stop > first ? ['--interpolation-range', `${first}:${stop}`] : []
    }),
    '--width', String(input.width), '--height', String(input.height), '--fps', String(input.fps),
    '--output-width', String(output.width), '--output-height', String(output.height), '--output-fps', String(output.fps),
    '--duration', String(duration), '--device', cpu ? 'CPU' : 'AUTO'
  ]
  return {
    executable: pack.executable,
    args,
    gpuWorker: !cpu
  }
}

/** The optional worker streams a few frames at a time; no decoded-frame or AI preview cache. */
export async function encodeWithUpscale(
  request: ExportRequest,
  inputArgs: string[],
  filter: { graph: string; videoLabel: string; audioLabel: string },
  directory: string,
  output: string,
  duration: number,
  jobId: string,
  resolvedContext: UpscaleExportContext
): Promise<void> {
  const { plan, pack } = resolvedContext
  if (!isFlashSpatialSupported(plan)) {
    throw new Error(flashSpatialSupportMessage)
  }
  const cpuOnly = process.env.otc_CPU_ONLY === '1'
  if (plan.spatial && cpuOnly) throw new Error('FlashVSR+ enhancement requires an Intel discrete GPU')
  const facePack = request.faceBlurs?.length ? await requireFacePack() : undefined
  if (facePack) await ensureFaceModels(facePack, jobId)
  const canvas = plan.canvas
  const effects = join(directory, 'faces.tsv')
  const audio = join(directory, 'audio.m4a')
  // The existing private job directory is on the destination disk. Keeping
  // this intermediate there also prevents separate jobs sharing a filename.
  const video = join(directory, 'upscale-video.mp4')
  // Audio/container duration can outlast the video track by several frames.
  // Match the worker's ceiling, holding the last frame only as far as the
  // explicit decoder frame limit; padding never extends the selected duration.
  const frameCount = upscaleSourceFrame(duration, request.canvas.fps)
  // Match the worker's output ceiling; a duration limit can round away its last frame.
  const outputFrames = upscaleSourceFrame(duration, canvas.fps)
  let cache: FaceDetectionCacheSession | undefined
  try {
    const decoder = decoderCommand(inputArgs, {
      ...filter,
      graph: `${filter.graph};[${filter.videoLabel}]tpad=stop_mode=clone:stop=${frameCount}[upscaleinput]`,
      videoLabel: 'upscaleinput'
    }, duration, audio, frameCount)
    decoder.args = await prepareFfmpegArguments(decoder.args, directory)
    if (facePack) {
      cache = await prepareFaceDetectionCache(request, 0)
      await writeFile(effects, faceEffectRows(request.faceBlurs ?? []))
    }
    const workers = (cpu: boolean): { face?: FaceCommand; upscale: FaceCommand } => {
      const face = facePack
        ? nativeFaceWorkerCommand(facePack, request.canvas, effects, cpu || cache?.hasCompleteDetections ? 'CPU' : 'AUTO')
        : undefined
      if (face) face.args.push(...(cache?.workerArgs ?? []))
      return {
        ...(face ? { face } : {}),
        upscale: upscaleWorkerCommand(pack, request.canvas, canvas, duration, cpu, plan.spatial ? plan.mode : undefined, directory, plan.spatialRanges, plan.interpolationRanges)
      }
    }
    const run = async (commands: FacePipelineCommands, message = ''): Promise<void> => {
      await removeScratchFile(video)
      await runFacePipeline(commands, jobId, duration, {
        label: 'Upscaling video', phase: 'upscaling', message,
        authorizationMessage: 'GPU authorization unavailable; trying available hardware…',
        ...(cache ? { onWorkerStderr: cache.onWorkerStderr } : {})
      })
    }
    const prepareRetry = async (error: unknown): Promise<string> => {
      if (error instanceof Error && error.message === 'Job cancelled') throw error
      if (cache) {
        // Retain completed face detections even when the later AI/encoder stage fails.
        await cache.commit().catch(() => undefined)
        await cache.cleanup().catch(() => undefined)
        cache = await prepareFaceDetectionCache(request, 0)
      }
      return error instanceof FaceAuthorizationError
        ? 'GPU authorization unavailable; trying available hardware…'
        : 'GPU enhancement or encoding unavailable; trying fallback…'
    }
    let encoded = false
    let fallbackMessage = ''
    const restricted = cpuOnly ? undefined : await restrictedIntelRenderNode()
    if (restricted) {
      try {
        const executable = await vaapiFfmpegPath()
        const { face, upscale } = workers(false)
        let combined = privilegedFacePipelineCommand(upscale, privilegedVideoEncoderCommand(canvas, duration, restricted, executable, 'rgb24', outputFrames))
        if (face) combined = privilegedFacePipelineCommand(face, combined)
        // A single prompt covers all privileged workers. Only the normal user writes files.
        await run([decoder, combined, nutVideoRemuxCommand(video)])
        encoded = true
      } catch (error) {
        fallbackMessage = await prepareRetry(error)
        if (plan.spatial) {
          // An unprivileged retry cannot recover this GPU-only operation and
          // would replace the real failure with a permission/discovery error.
          throw error instanceof FaceAuthorizationError
            ? new Error('FlashVSR+ enhancement requires GPU access; authorization was unavailable')
            : error
        }
      }
    }
    if (!encoded) {
      const candidates = cpuOnly ? [softwareEncoder()] : await exportEncoders()
      for (const [index, encoder] of candidates.entries()) {
        // Replacing an encoder does not mean AI inference failed. Ordinary AUTO
        // workers cannot re-prompt; keep the final explicit CPU retry below.
        const cpu = cpuOnly
        try {
          await run(ordinaryCommands(encoder, cpu), cpu && fallbackMessage ? 'GPU processing unavailable; using CPU…' : fallbackMessage)
          encoded = true
          break
        } catch (error) {
          fallbackMessage = await prepareRetry(error)
          if (index === candidates.length - 1) {
            if (cpu || plan.spatial) throw error
            await run(ordinaryCommands(encoder, true), 'GPU processing unavailable; using CPU…')
            encoded = true
          }
        }
      }
    }
    if (!encoded) throw new Error('No video encoder is available')
    await jobs.run(ffmpegPath(), [
      '-hide_banner', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
      '-c', 'copy', '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output
    ], 'export', duration, jobId, '', { phase: 'finalizing', announce: false })
    await cache?.commit()

    function ordinaryCommands(encoder: ExportEncoder, cpu: boolean): FacePipelineCommands {
      const { face, upscale } = workers(cpu)
      const writer = rawVideoEncoderCommand(encoder, canvas.width, canvas.height, canvas.fps, duration, video, outputFrames)
      return face ? [decoder, face, upscale, writer] : [decoder, upscale, writer]
    }
  } finally {
    if (cache) await cache.cleanup().catch(() => undefined)
    await Promise.all([video, audio, ...(facePack ? [effects] : [])].map(removeScratchFile))
  }
}
