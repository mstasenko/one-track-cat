import { describe, expect, it } from 'vitest'
import { flashSpatialSupportMessage } from '@shared/upscale'
import { upscaleExportPresentation } from './upscale-export-presentation'
import type { UpscaleModelDownloadProgress } from '@shared/types'

const defaults = {
  needsUpscale: true, needsSpatial: true, needsInterpolation: true,
  spatialSupported: true,
  checkingPack: false, downloadActive: false, packStatus: { available: true, message: '' },
  downloadError: null, selection: 'off' as const, downloadProgress: null
}

describe('Upscale export presentation', () => {
  it.each([
    [true, true, ['Off', '4K60 · Turbo', '4K60 · Base'], 'Upscale the whole video to 4K60.'],
    [true, false, ['Off', '4K · Turbo', '4K · Base'], 'Upscale the whole video to 4K.'],
    [false, true, ['Off', '60 fps'], 'Convert the whole video to 60 fps.'],
    [false, false, ['Not needed'], 'No upscaling needed.']
  ])('derives options for spatial=%s interpolation=%s', (needsSpatial, needsInterpolation, labels, description) => {
    const view = upscaleExportPresentation({ ...defaults, needsSpatial, needsInterpolation,
      needsUpscale: needsSpatial || needsInterpolation })
    expect(view.selectionOptions.map((option) => option.label)).toEqual(labels)
    expect(view.modeDescription).toBe(description)
    expect(view.upscaleDisabled).toBe(!needsSpatial && !needsInterpolation)
  })

  it.each([
    ['turbo', true, 'FlashVSR+ Turbo mode. Faster processing.'],
    ['turbo', false, 'Convert the whole video to 60 fps using AI frame interpolation.'],
    ['base', true, 'FlashVSR+ Base mode. More detail.']
  ] as const)('describes %s spatial=%s', (selection, needsSpatial, expected) => {
    expect(upscaleExportPresentation({ ...defaults, selection, needsSpatial }).modeDescription).toBe(expected)
  })

  it('blocks unsupported spatial geometry without checking or downloading a pack', () => {
    const view = upscaleExportPresentation({ ...defaults, spatialSupported: false })
    expect(view.selectionOptions).toEqual([{ value: 'off', label: 'Off' }])
    expect(view.upscaleDisabled).toBe(true)
    expect(view.statusMessage).toBe(flashSpatialSupportMessage)
    expect(view.modeDescription).toBe(flashSpatialSupportMessage)
  })

  it('prioritizes checking, errors and unavailable status without changing eligibility', () => {
    expect(upscaleExportPresentation({ ...defaults, needsUpscale: false }).statusMessage).toBe('No upscaling needed.')
    expect(upscaleExportPresentation({ ...defaults, checkingPack: true, downloadError: 'error' }).statusMessage)
      .toBe('Checking Upscaling availability…')
    expect(upscaleExportPresentation({ ...defaults, downloadError: 'error' }).statusMessage).toBe('error')
    for (const downloadable of [true, false, undefined]) {
      const view = upscaleExportPresentation({ ...defaults, packStatus: { available: false, downloadable, message: '' } })
      expect(view.statusMessage).toBe('Upscaling is unavailable.')
      expect(view.upscaleDisabled).toBe(downloadable !== true)
    }
    expect(upscaleExportPresentation({ ...defaults, packStatus: { available: false, message: 'missing' } }).statusMessage).toBe('missing')
    expect(upscaleExportPresentation({ ...defaults, packStatus: null }).statusMessage).toBeNull()
    expect(upscaleExportPresentation({ ...defaults, downloadActive: true }).upscaleDisabled).toBe(true)
    expect(upscaleExportPresentation({ ...defaults, checkingPack: true }).upscaleDisabled).toBe(false)
  })

  it.each([
    ['downloading', 'Downloading model'], ['preparing', 'Preparing Upscaling model'],
    ['verifying', 'Verifying Upscaling model']
  ] as const)('labels the %s phase and clamps malformed display percentages', (phase, expected) => {
    for (const [percent, clamped] of [[NaN, 0], [-1, 0], [25, 25], [101, 100], [Infinity, 0]]) {
      const progress: UpscaleModelDownloadProgress = { phase, name: 'model', downloadedBytes: 0,
        totalBytes: 100, percent: percent ?? 0, bytesPerSecond: null, etaSeconds: null }
      const view = upscaleExportPresentation({ ...defaults, downloadProgress: progress })
      expect(view.progressPercent).toBe(clamped)
      expect(view.progressStatus).toBe(expected)
    }
    const empty = upscaleExportPresentation(defaults)
    expect(empty.progressPercent).toBe(0)
    expect(empty.progressStatus).toBeNull()
  })
})
