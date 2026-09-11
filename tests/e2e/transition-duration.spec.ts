import { expect, test, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { click, completeVideoPicker, dismissHardwareWarningIfNeeded, e2eEnvironment, ffprobe, main, seekTimeline, syntheticVideo, videoFrame } from './support'

interface ProbeResult {
  format: { duration: string }
  streams: { codec_type: string; width?: number; height?: number }[]
}

function probe(path: string): ProbeResult {
  return JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path
  ], { encoding: 'utf8' })) as ProbeResult
}

function meanBrightness(frame: Buffer): number {
  return frame.reduce((sum, value) => sum + value, 0) / Math.max(1, frame.length)
}

test('offers five-second inserted-video transitions and fits the following clip', async () => {
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(tmpdir(), 'otc-transition-duration-'))
  const input = syntheticVideo(directory)
  const output = join(directory, 'transitioned.mp4')
  const app = await electron.launch({
    args: [main, input],
    env: e2eEnvironment({ otc_E2E_VIDEO: input, otc_E2E_OUTPUT: output })
  })

  try {
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await expect(page.getByText('game.mp4', { exact: true })).toBeVisible()
    await seekTimeline(page, 0.5)
    await expect(page.locator('.timeline-time')).toContainText('00:03.00 / 00:06.00')

    await click(page.getByRole('button', { name: 'Video', exact: true }))
    const duration = page.getByLabel('Transition duration')
    await expect(duration.locator('option')).toHaveText([
      '0.35 seconds', '0.65 seconds', '1 second', '1.5 seconds',
      '2 seconds', '3 seconds', '4 seconds', '5 seconds'
    ])
    await page.getByLabel('Into inserted video').selectOption('fade')
    await page.getByLabel('Back to timeline').selectOption('fade')
    await duration.selectOption('5')
    await click(page.getByRole('button', { name: 'Select video', exact: true }))
    await completeVideoPicker(page)

    const segments = page.locator('.source-segment')
    await expect(segments).toHaveCount(3)
    await expect(segments.nth(1)).toHaveAttribute('data-transition', 'fade')
    await expect(segments.nth(1)).toHaveAttribute('title', /fade 1.5s/)
    await expect(segments.nth(2)).toHaveAttribute('data-transition', 'fade')
    const followingTitle = await segments.nth(2).getAttribute('title')
    const followingDuration = Number(followingTitle?.match(/fade ([0-9.]+)s/)?.[1])
    expect(followingDuration).toBeCloseTo(1.5, 2)
    await expect(page.locator('.timeline-time')).toContainText('00:06.00 / 00:09.00')

    await seekTimeline(page, 1.4 / 9)
    const currentVideo = page.locator('.preview-source-video:not(.preview-transition-previous)')
    const outgoingVideo = page.locator('.preview-transition-previous')
    await expect(currentVideo).toHaveCount(1)
    await expect(outgoingVideo).toHaveCount(1)
    await click(page.getByRole('button', { name: 'Play', exact: true }))
    await expect(currentVideo).toHaveAttribute('data-transition', 'fade', { timeout: 5_000 })
    const samples: { currentTime: number; paused: boolean; seeking: boolean; outgoingTime: number; outgoingPaused: boolean; outgoingSeeking: boolean }[] = []
    for (let index = 0; index < 6; index += 1) {
      await page.waitForTimeout(150)
      samples.push(await page.evaluate(() => {
        const current = document.querySelector<HTMLVideoElement>('.preview-source-video:not(.preview-transition-previous)')
        const outgoing = document.querySelector<HTMLVideoElement>('.preview-transition-previous')
        if (!current || !outgoing) throw new Error('Transition preview videos are missing')
        return {
          currentTime: current.currentTime,
          paused: current.paused,
          seeking: current.seeking,
          outgoingTime: outgoing.currentTime,
          outgoingPaused: outgoing.paused,
          outgoingSeeking: outgoing.seeking
        }
      }))
    }
    await click(page.getByRole('button', { name: 'Pause', exact: true }))
    expect(samples.every((sample) => !sample.paused && !sample.outgoingPaused)).toBe(true)
    expect(samples.some((sample) => !sample.seeking && !sample.outgoingSeeking)).toBe(true)
    expect(Math.max(...samples.map((sample) => sample.outgoingTime)) - Math.min(...samples.map((sample) => sample.outgoingTime))).toBeGreaterThan(0.3)
    expect(Math.min(...samples.map((sample) => sample.outgoingTime))).toBeGreaterThan(0.2)
    expect(Math.max(...samples.map((sample) => sample.currentTime)) - Math.min(...samples.map((sample) => sample.currentTime))).toBeGreaterThan(0.3)

    await click(page.getByRole('button', { name: 'Export', exact: true }))
    await expect(page.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 90_000 })
    await expect.poll(() => existsSync(output), { timeout: 5_000 }).toBe(true)

    const result = probe(output)
    expect(Number(result.format.duration)).toBeCloseTo(9, 1)
    expect(result.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({ width: 320, height: 180 })
    expect(result.streams.some((stream) => stream.codec_type === 'audio')).toBe(true)
    expect(videoFrame(output, 8.5).length).toBe(320 * 180 * 3)
    const boundaryFrames = [1.5, 1.5 + 1 / 24, 3 - 1 / 24, 3, 6, 6 + 1 / 24, 7.5 - 1 / 24, 7.5]
      .map((time) => videoFrame(output, time))
    expect(Math.min(...boundaryFrames.map(meanBrightness))).toBeGreaterThan(10)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})
