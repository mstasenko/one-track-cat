import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { aiEnhancementPlan, aiSourceFrame, flashSpatialSupportMessage, isFlashSpatialSupported, type AiEnhancementPlan } from '../ai-enhancement'
import type { AiEnhancementMode, ExportRequest, ProjectCanvas } from '../types'
import type { AiPack } from './ai-pack'
import { ffmpegPath } from './binaries'
import { exportEncoders, softwareEncoder, type ExportEncoder } from './export-encoder'
import { prepareFaceDetectionCache, type FaceDetectionCacheSession } from './face-detection-cache'
import { decoderCommand, faceEffectRows, rawVideoEncoderCommand } from './face-export'
import { requireFacePack } from './face-pack'
import { FaceAuthorizationError, runFacePipeline, type FaceCommand, type FacePipelineCommands } from './face-process'
import { nativeFaceWorkerCommand, restrictedIntelRenderNode } from './face-worker'
import { jobs } from './jobs'
import { nutVideoRemuxCommand, privilegedFacePipelineCommand, privilegedVideoEncoderCommand, vaapiFfmpegPath } from './privileged-export'

/** Keep the canvas's aspect ratio, including portrait Shorts, without stretching or downscaling. */
export function aiExportCanvas(canvas: ProjectCanvas): ProjectCanvas {
  return aiEnhancementPlan(canvas).canvas
}

/** Resolved once by the whole-export preflight and reused by every AI worker attempt. */
export interface AiExportContext {
  plan: AiEnhancementPlan
  pack: AiPack
}

export function aiWorkerCommand(
  pack: AiPack,
  input: ProjectCanvas,
  output: ProjectCanvas,
  duration: number,
  cpu: boolean,
  mode?: AiEnhancementMode,
  scratch?: string,
  spatialRanges?: [number, number][]
): FaceCommand {
  const args = [
    ...(pack.models ? ['--models', pack.models] : []), '--rife', pack.rife,
    ...(mode ? ['--mode', mode, ...(scratch ? ['--scratch', scratch] : [])] : []),
    ...(spatialRanges ?? []).flatMap(([start, end]) => {
      const first = aiSourceFrame(Math.min(start, duration), input.fps)
      const stop = aiSourceFrame(Math.min(end, duration), input.fps)
      return stop > first ? ['--spatial-range', `${first}:${stop}`] : []
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
export async function encodeWithAi(
  request: ExportRequest,
  inputArgs: string[],
  filter: { graph: string; videoLabel: string; audioLabel: string },
  directory: string,
  output: string,
  duration: number,
  jobId: string,
  resolvedContext: AiExportContext
): Promise<void> {
  const { plan, pack } = resolvedContext
  if (!isFlashSpatialSupported(plan)) {
    throw new Error(flashSpatialSupportMessage)
  }
  const cpuOnly = process.env.otc_CPU_ONLY === '1'
  if (plan.spatial && cpuOnly) throw new Error('FlashVSR+ enhancement requires an Intel discrete GPU')
  const facePack = request.faceBlurs?.length ? await requireFacePack() : undefined
  const canvas = plan.canvas
  const effects = join(directory, 'faces.tsv')
  const audio = join(directory, 'audio.m4a')
  // The existing private job directory is on the destination disk. Keeping
  // this intermediate there also prevents separate jobs sharing a filename.
  const video = join(directory, 'ai-video.mp4')
  // Audio/container duration can outlast the video track by several frames.
  // Match the worker's ceiling, holding the last frame only as far as the
  // explicit decoder frame limit; padding never extends the selected duration.
  const frameCount = aiSourceFrame(duration, request.canvas.fps)
  // Match the worker's output ceiling; a duration limit can round away its last frame.
  const outputFrames = aiSourceFrame(duration, canvas.fps)
  const decoder = decoderCommand(inputArgs, {
    ...filter,
    graph: `${filter.graph};[${filter.videoLabel}]tpad=stop_mode=clone:stop=${frameCount}[aiinput]`,
    videoLabel: 'aiinput'
  }, duration, audio, frameCount)
  let cache: FaceDetectionCacheSession | undefined
  try {
    if (facePack) {
      cache = await prepareFaceDetectionCache(request, 0)
      await writeFile(effects, faceEffectRows(request.faceBlurs ?? []))
    }
    const workers = (cpu: boolean): { face?: FaceCommand; ai: FaceCommand } => {
      const face = facePack
        ? nativeFaceWorkerCommand(facePack, request.canvas, effects, cpu || cache?.hasCompleteDetections ? 'CPU' : 'AUTO')
        : undefined
      if (face) face.args.push(...(cache?.workerArgs ?? []))
      return {
        ...(face ? { face } : {}),
        ai: aiWorkerCommand(pack, request.canvas, canvas, duration, cpu, plan.spatial ? plan.mode : undefined, directory, plan.spatialRanges)
      }
    }
    const run = async (commands: FacePipelineCommands, message = ''): Promise<void> => {
      await rm(video, { force: true })
      await runFacePipeline(commands, jobId, duration, {
        label: 'AI enhancing video', phase: 'enhancing', message,
        authorizationMessage: 'GPU authorization unavailable; trying available hardware…',
        ...(cache ? { onWorkerStderr: cache.onWorkerStderr } : {})
      })
    }
    const prepareRetry = async (error: unknown): Promise<string> => {
      if (error instanceof Error && error.message === 'Job cancelled') throw error
      if (cache) {
        // Retain completed face detections even when the later AI/encoder stage fails.
        await cache.commit()
        await cache.cleanup()
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
        const { face, ai } = workers(false)
        let combined = privilegedFacePipelineCommand(ai, privilegedVideoEncoderCommand(canvas, duration, restricted, executable, 'rgb24', outputFrames))
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
      const { face, ai } = workers(cpu)
      const writer = rawVideoEncoderCommand(encoder, canvas.width, canvas.height, canvas.fps, duration, video, outputFrames)
      return face ? [decoder, face, ai, writer] : [decoder, ai, writer]
    }
  } finally {
    await cache?.cleanup()
    await rm(video, { force: true })
  }
}
