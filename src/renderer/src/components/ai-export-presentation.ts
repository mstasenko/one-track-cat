import { flashSpatialSupportMessage } from '@shared/ai-enhancement'
import type { AiModelDownloadProgress, AiPackStatus } from '@shared/types'

export type AiSelection = 'off' | 'turbo' | 'base'

interface PresentationInput {
  needsEnhancement: boolean
  needsSpatial: boolean
  spatialSupported: boolean
  needsInterpolation: boolean
  closeupsOnly?: boolean
  checkingPack: boolean
  downloadActive: boolean
  packStatus: AiPackStatus | null
  downloadError: string | null
  selection: AiSelection
  downloadProgress: AiModelDownloadProgress | null
}

function getStatusMessage(input: PresentationInput, unsupportedSpatial: boolean): string | null {
  if (!input.needsEnhancement) return 'Already 4K60 or better.'
  if (unsupportedSpatial) return flashSpatialSupportMessage
  if (input.checkingPack) return 'Checking AI enhancement availability…'
  if (input.downloadError) return input.downloadError
  if (input.packStatus?.available === false) {
    return input.packStatus.message || 'AI enhancement is unavailable.'
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
): { value: AiSelection; label: string }[] {
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
  return [{ value: 'off', label: 'Already 4K60 or better' }]
}

function getModeDescription(
  selection: AiSelection,
  needsEnhancement: boolean,
  needsSpatial: boolean,
  needsInterpolation: boolean,
  unsupportedSpatial: boolean
): string {
  if (unsupportedSpatial) return flashSpatialSupportMessage
  if (selection === 'turbo' || selection === 'base') {
    if (!needsSpatial) return 'Convert to 60 fps. RIFE interpolation is used at 50 fps or below.'
    return selection === 'turbo'
      ? 'FlashVSR+ Turbo mode. Faster processing.'
      : 'FlashVSR+ Base mode. More detail.'
  }
  if (!needsEnhancement) return 'Already 4K60 or better.'
  if (needsSpatial && needsInterpolation) return 'Enhance the whole video to 4K60.'
  if (needsSpatial) return 'Upscale the whole video to 4K.'
  return 'Convert the whole video to 60 fps.'
}

function getProgressPercent(downloadProgress: AiModelDownloadProgress | null): number {
  if (!downloadProgress) return 0
  return Math.min(100, Math.max(0,
    Number.isFinite(downloadProgress.percent) ? downloadProgress.percent : 0))
}

function getProgressStatus(downloadProgress: AiModelDownloadProgress | null): string | null {
  if (!downloadProgress) return null
  if (downloadProgress.phase === 'preparing') return 'Preparing AI enhancement model'
  if (downloadProgress.phase === 'verifying') return 'Verifying AI enhancement model'
  return `Downloading ${downloadProgress.name}`
}

/** Pure display state; download ownership and cancellation stay in the dialog. */
export function aiExportPresentation({ needsEnhancement, needsSpatial, needsInterpolation, closeupsOnly,
  spatialSupported, checkingPack, downloadActive, packStatus, downloadError, selection, downloadProgress
}: PresentationInput) {
  const unsupportedSpatial = needsSpatial && !spatialSupported
  const enhancementDisabled = !needsEnhancement
    || unsupportedSpatial
    || downloadActive
    || (packStatus?.available === false && packStatus.downloadable !== true)
  const targetLabel = getTargetLabel(needsSpatial, needsInterpolation)

  return {
    enhancementDisabled,
    statusMessage: getStatusMessage({
      needsEnhancement, needsSpatial, needsInterpolation, spatialSupported,
      checkingPack, downloadActive, packStatus, downloadError, selection, downloadProgress
    }, unsupportedSpatial),
    selectionOptions: getSelectionOptions(
      unsupportedSpatial, needsSpatial, needsInterpolation, targetLabel),
    modeDescription: closeupsOnly && !unsupportedSpatial
      ? `Enhance only close-ups at 4K${needsInterpolation ? '; convert the whole video to 60 fps' : ''}.` +
        (selection === 'base' ? ' Base: more detail.' : selection === 'turbo' ? ' Turbo: faster processing.' : '')
      : getModeDescription(selection, needsEnhancement, needsSpatial, needsInterpolation, unsupportedSpatial),
    progressPercent: getProgressPercent(downloadProgress),
    progressStatus: getProgressStatus(downloadProgress)
  }
}
