import { stat as statPath, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ExportRequest } from '../types'
import { timelineDuration } from '../segment-time'
import { upscalePlan, upscaleSourceFrame } from '../upscale'

export function estimatedExportBytes(request: ExportRequest): number {
  const duration = timelineDuration(request.segments)
  const conservativeBitsPerSecond = request.upscale ? 100_000_000 : 50_000_000
  const fixedReserve = 256 * 1024 ** 2
  return Math.ceil(fixedReserve + duration * conservativeBitsPerSecond / 8 * 1.5)
}

export async function ensureDiskSpace(request: ExportRequest): Promise<void> {
  const available = await statfs(dirname(request.outputPath))
  const free = available.bavail * available.bsize
  const estimated = estimatedExportBytes(request)
  if (free < estimated) {
    throw new Error(`Not enough free disk space. Approximately ${Math.ceil(estimated / 1024 / 1024)} MB is required.`)
  }
}

/** Mirror FlashHistoryOwner's fixed UHD K/V capacity and free-space reserve.
 * Histories are reused between ranges; only ranges longer than one 13-frame
 * model call allocate them. RIFE-only exports need no Flash scratch space.
 */
export function estimatedFlashScratchBytes(request: ExportRequest): number {
  if (!request.upscale) return 0
  const plan = upscalePlan(request.canvas, request.upscale.mode, request.focusZooms, request)
  if (!plan.spatial) return 0
  const duration = timelineDuration(request.segments)
  const ranges = plan.spatialRanges ?? [[0, duration]]
  const needsHistory = ranges.some(([start, end]) =>
    upscaleSourceFrame(Math.min(end, duration), request.canvas.fps) -
    upscaleSourceFrame(Math.min(start, duration), request.canvas.fps) > 13)
  if (!needsHistory) return 0
  // 30 layers: Turbo retains 3 groups in 5 layers and 1 in the other 25;
  // Base retains 3 in all layers. Each group has 510 windows of BF16 K/V.
  const groups = plan.mode === 'base' ? 90 : 40
  return groups * 510 * 128 * 1536 * 2 * 2 + 16 * 1024 ** 3
}

export async function ensureFaceExportDiskSpace(request: ExportRequest, temporaryDirectory: string): Promise<void> {
  const estimated = estimatedExportBytes(request)
  const [outputFilesystem, temporaryFilesystem, outputPath, temporaryPath] = await Promise.all([
    statfs(dirname(request.outputPath)),
    statfs(temporaryDirectory),
    statPath(dirname(request.outputPath)),
    statPath(temporaryDirectory)
  ])
  const scratch = estimatedFlashScratchBytes(request)
  const outputFree = outputFilesystem.bavail * outputFilesystem.bsize
  const temporaryFree = temporaryFilesystem.bavail * temporaryFilesystem.bsize
  const requiredTemporary = estimated + scratch
  const requiredOutput = outputPath.dev === temporaryPath.dev ? estimated * 2 + scratch : estimated
  if (outputFree < requiredOutput || temporaryFree < requiredTemporary) {
    if (scratch > 0) {
      const outputTooSmall = outputFree < requiredOutput
      const directory = outputTooSmall ? dirname(request.outputPath) : temporaryDirectory
      const required = outputTooSmall ? requiredOutput : requiredTemporary
      const free = outputTooSmall ? outputFree : temporaryFree
      throw new Error(`Not enough free disk space for Upscale in ${directory}. Approximately ${(required / 1024 ** 3).toFixed(1)} GB is required, with ${(free / 1024 ** 3).toFixed(1)} GB available. Free space or export to another drive.`)
    }
    const required = Math.max(requiredOutput, estimated)
    throw new Error(`Not enough free disk space for GPU/face processing. Approximately ${Math.ceil(required / 1024 / 1024)} MB is required.`)
  }
}
