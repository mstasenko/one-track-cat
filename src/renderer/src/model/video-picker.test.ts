import { afterEach, describe, expect, it } from 'vitest'
import { chooseVideo, finishVideoChoice, useVideoPickerStore } from './video-picker'

afterEach(() => {
  finishVideoChoice(null)
  useVideoPickerStore.setState({ open: false })
})

describe('video picker choice', () => {
  it('reuses one pending promise for concurrent callers', async () => {
    const first = chooseVideo()
    const second = chooseVideo()

    expect(second).toBe(first)
    expect(useVideoPickerStore.getState().open).toBe(true)
    finishVideoChoice('/videos/selected.mp4')

    await expect(first).resolves.toBe('/videos/selected.mp4')
    expect(useVideoPickerStore.getState().open).toBe(false)
  })

  it('resolves cancellation and allows a later choice', async () => {
    const cancelled = chooseVideo()
    finishVideoChoice(null)
    await expect(cancelled).resolves.toBeNull()

    const next = chooseVideo()
    expect(useVideoPickerStore.getState().open).toBe(true)
    finishVideoChoice('/videos/next.webm')
    await expect(next).resolves.toBe('/videos/next.webm')
  })

  it('finishing without a pending choice keeps the dialog closed', () => {
    finishVideoChoice(null)
    expect(useVideoPickerStore.getState().open).toBe(false)
  })
})
