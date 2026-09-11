import { stat as statPath, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ExportRequest } from '../types'
import { timelineDuration } from '../segment-time'

export function estimatedExportBytes(request: ExportRequest): number {
  const duration = timelineDuration(request.segments)
  const conservativeBitsPerSecond = 50_000_000
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

export async function ensureFaceExportDiskSpace(request: ExportRequest, temporaryDirectory: string): Promise<void> {
  const estimated = estimatedExportBytes(request)
  const [outputFilesystem, temporaryFilesystem, outputPath, temporaryPath] = await Promise.all([
    statfs(dirname(request.outputPath)),
    statfs(temporaryDirectory),
    statPath(dirname(request.outputPath)),
    statPath(temporaryDirectory)
  ])
  const outputFree = outputFilesystem.bavail * outputFilesystem.bsize
  const temporaryFree = temporaryFilesystem.bavail * temporaryFilesystem.bsize
  const requiredOutput = outputPath.dev === temporaryPath.dev ? estimated * 2 : estimated
  if (outputFree < requiredOutput || temporaryFree < estimated) {
    const required = Math.max(requiredOutput, estimated)
    throw new Error(`Not enough free disk space for GPU/face processing. Approximately ${Math.ceil(required / 1024 / 1024)} MB is required.`)
  }
}
