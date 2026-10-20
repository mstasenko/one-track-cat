import { describe, expect, it } from 'vitest'
import { flashSpatialSupportMessage } from '@shared/ai-enhancement'
import { aiExportPresentation } from './ai-export-presentation'
import type { AiModelDownloadProgress } from '@shared/types'

const defaults = {
  needsEnhancement: true, needsSpatial: true, needsInterpolation: true,
  spatialSupported: true,
  checkingPack: false, downloadActive: false, packStatus: { available: true, message: '' },
  downloadError: null, selection: 'off' as const, downloadProgress: null
}

describe('AI export presentation', () => {
  it.each([
    [true, true, ['Off', '4K60 · Turbo', '4K60 · Base'], 'Enhance the whole video to 4K60.'],
    [true, false, ['Off', '4K · Turbo', '4K · Base'], 'Upscale the whole video to 4K.'],
    [false, true, ['Off', '60 fps'], 'Convert the whole video to 60 fps.'],
    [false, false, ['Already 4K60 or better'], 'Already 4K60 or better.']
  ])('derives options for spatial=%s interpolation=%s', (needsSpatial, needsInterpolation, labels, description) => {
    const view = aiExportPresentation({ ...defaults, needsSpatial, needsInterpolation,
      needsEnhancement: needsSpatial || needsInterpolation })
    expect(view.selectionOptions.map((option) => option.label)).toEqual(labels)
    expect(view.modeDescription).toBe(description)
    expect(view.enhancementDisabled).toBe(!needsSpatial && !needsInterpolation)
  })

  it.each([
    ['turbo', true, 'FlashVSR+ Turbo mode. Faster processing.'],
    ['turbo', false, 'Convert to 60 fps. RIFE interpolation is used at 50 fps or below.'],
    ['base', true, 'FlashVSR+ Base mode. More detail.']
  ] as const)('describes %s spatial=%s', (selection, needsSpatial, expected) => {
    expect(aiExportPresentation({ ...defaults, selection, needsSpatial }).modeDescription).toBe(expected)
  })

  it('blocks unsupported spatial geometry without checking or downloading a pack', () => {
    const view = aiExportPresentation({ ...defaults, spatialSupported: false })
    expect(view.selectionOptions).toEqual([{ value: 'off', label: 'Off' }])
    expect(view.enhancementDisabled).toBe(true)
    expect(view.statusMessage).toBe(flashSpatialSupportMessage)
    expect(view.modeDescription).toBe(flashSpatialSupportMessage)
  })

  it('prioritizes checking, errors and unavailable status without changing eligibility', () => {
    expect(aiExportPresentation({ ...defaults, needsEnhancement: false }).statusMessage).toBe('Already 4K60 or better.')
    expect(aiExportPresentation({ ...defaults, checkingPack: true, downloadError: 'error' }).statusMessage)
      .toBe('Checking AI enhancement availability…')
    expect(aiExportPresentation({ ...defaults, downloadError: 'error' }).statusMessage).toBe('error')
    for (const downloadable of [true, false, undefined]) {
      const view = aiExportPresentation({ ...defaults, packStatus: { available: false, downloadable, message: '' } })
      expect(view.statusMessage).toBe('AI enhancement is unavailable.')
      expect(view.enhancementDisabled).toBe(downloadable !== true)
    }
    expect(aiExportPresentation({ ...defaults, packStatus: { available: false, message: 'missing' } }).statusMessage).toBe('missing')
    expect(aiExportPresentation({ ...defaults, packStatus: null }).statusMessage).toBeNull()
    expect(aiExportPresentation({ ...defaults, downloadActive: true }).enhancementDisabled).toBe(true)
    expect(aiExportPresentation({ ...defaults, checkingPack: true }).enhancementDisabled).toBe(false)
  })

  it.each([
    ['downloading', 'Downloading model'], ['preparing', 'Preparing AI enhancement model'],
    ['verifying', 'Verifying AI enhancement model']
  ] as const)('labels the %s phase and clamps malformed display percentages', (phase, expected) => {
    for (const [percent, clamped] of [[NaN, 0], [-1, 0], [25, 25], [101, 100], [Infinity, 0]]) {
      const progress: AiModelDownloadProgress = { phase, name: 'model', downloadedBytes: 0,
        totalBytes: 100, percent: percent ?? 0, bytesPerSecond: null, etaSeconds: null }
      const view = aiExportPresentation({ ...defaults, downloadProgress: progress })
      expect(view.progressPercent).toBe(clamped)
      expect(view.progressStatus).toBe(expected)
    }
    const empty = aiExportPresentation(defaults)
    expect(empty.progressPercent).toBe(0)
    expect(empty.progressStatus).toBeNull()
  })
})
