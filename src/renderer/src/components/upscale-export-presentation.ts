import { flashSpatialSupportMessage } from '@shared/upscale'
import type { UpscaleModelDownloadProgress, UpscalePackStatus } from '@shared/types'

export type UpscaleSelection = 'off' | 'turbo' | 'base'

interface PresentationInput {
  needsUpscale: boolean
  needsSpatial: boolean
  spatialSupported: boolean
  needsInterpolation: boolean
  closeupsOnly?: boolean
  checkingPack: boolean
  downloadActive: boolean
  packStatus: UpscalePackStatus | null
  downloadError: string | null
  selection: UpscaleSelection
  downloadProgress: UpscaleModelDownloadProgress | null
}

function getStatusMessage(input: PresentationInput, unsupportedSpatial: boolean): string | null {
  if (!input.needsUpscale) return 'No upscaling needed.'
  if (unsupportedSpatial) return flashSpatialSupportMessage
  if (input.checkingPack) return 'Checking Upscaling availability…'
  if (input.downloadError) return input.downloadError
  if (input.packStatus?.available === false) {
    return input.packStatus.message || 'Upscaling is unavailable.'
  }
  return null
}

function getTargetLabel(needsSpatial: boolean, needsInterpolation: boolean): string {
  if (!needsSpatial) return '60 fps'
  return needsInterpolation ? '4K60' : '4K'
}

function getSelectionOptions(
  unsupportedSpatial: boolean,
  needsSpatial: boolean,
  needsInterpolation: boolean,
  targetLabel: string
): { value: UpscaleSelection; label: string }[] {
  if (unsupportedSpatial) return [{ value: 'off', label: 'Off' }]
  if (needsSpatial) {
    return [
      { value: 'off', label: 'Off' },
      { value: 'turbo', label: `${targetLabel} · Turbo` },
      { value: 'base', label: `${targetLabel} · Base` }
    ]
  }
  if (needsInterpolation) {
    return [{ value: 'off', label: 'Off' }, { value: 'turbo', label: '60 fps' }]
  }
  return [{ value: 'off', label: 'Not needed' }]
}

function getModeDescription(
  selection: UpscaleSelection,
  needsUpscale: boolean,
  needsSpatial: boolean,
  needsInterpolation: boolean,
  unsupportedSpatial: boolean
): string {
  if (unsupportedSpatial) return flashSpatialSupportMessage
  if (selection === 'turbo' || selection === 'base') {
    if (!needsSpatial) return 'Convert the whole video to 60 fps using AI frame interpolation.'
    return selection === 'turbo'
      ? 'FlashVSR+ Turbo mode. Faster processing.'
      : 'FlashVSR+ Base mode. More detail.'
  }
  if (!needsUpscale) return 'No upscaling needed.'
  if (needsSpatial && needsInterpolation) return 'Upscale the whole video to 4K60.'
  if (needsSpatial) return 'Upscale the whole video to 4K.'
  return 'Convert the whole video to 60 fps.'
}

function getProgressPercent(downloadProgress: UpscaleModelDownloadProgress | null): number {
  if (!downloadProgress) return 0
  return Math.min(100, Math.max(0,
    Number.isFinite(downloadProgress.percent) ? downloadProgress.percent : 0))
}

function getProgressStatus(downloadProgress: UpscaleModelDownloadProgress | null): string | null {
  if (!downloadProgress) return null
  if (downloadProgress.phase === 'preparing') return 'Preparing Upscaling model'
  if (downloadProgress.phase === 'verifying') return 'Verifying Upscaling model'
  return `Downloading ${downloadProgress.name}`
}

/** Pure display state; download ownership and cancellation stay in the dialog. */
export function upscaleExportPresentation({ needsUpscale, needsSpatial, needsInterpolation, closeupsOnly,
  spatialSupported, checkingPack, downloadActive, packStatus, downloadError, selection, downloadProgress
}: PresentationInput) {
  const unsupportedSpatial = needsSpatial && !spatialSupported
  const upscaleDisabled = !needsUpscale
    || unsupportedSpatial
    || downloadActive
    || (packStatus?.available === false && packStatus.downloadable !== true)
  const targetLabel = getTargetLabel(needsSpatial, needsInterpolation)

  return {
    upscaleDisabled,
    statusMessage: getStatusMessage({
      needsUpscale, needsSpatial, needsInterpolation, spatialSupported,
      checkingPack, downloadActive, packStatus, downloadError, selection, downloadProgress
    }, unsupportedSpatial),
    selectionOptions: getSelectionOptions(
      unsupportedSpatial, needsSpatial, needsInterpolation, targetLabel),
    modeDescription: closeupsOnly && !unsupportedSpatial
      ? `Upscale only close-ups at 4K${needsInterpolation ? '; convert the whole video to 60 fps' : ''}.` +
        (selection === 'base' ? ' Base: more detail.' : selection === 'turbo' ? ' Turbo: faster processing.' : '')
      : getModeDescription(selection, needsUpscale, needsSpatial, needsInterpolation, unsupportedSpatial),
    progressPercent: getProgressPercent(downloadProgress),
    progressStatus: getProgressStatus(downloadProgress)
  }
}
