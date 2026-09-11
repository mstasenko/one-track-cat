import { expect, test, _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  click,
  completeVideoPicker,
  dismissHardwareWarningIfNeeded,
  e2eEnvironment,
  main,
  mediaDuration,
  meanPixelDifference,
  seekTimeline,
  syntheticVideo,
  videoFrame
} from './support'

test('freezing at source EOF exports the final source frame', async () => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(tmpdir(), 'otc-eof-freeze-'))
  const input = syntheticVideo(directory)
  const output = join(directory, 'output.mp4')
  const app = await electron.launch({
    args: [main, input],
    env: e2eEnvironment({ otc_E2E_OUTPUT: output })
  })

  try {
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await expect(page.getByText('game.mp4', { exact: true })).toBeVisible()

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.timeline-time')).toContainText('00:06.00 / 00:06.00')

    await click(page.getByRole('button', { name: 'Freeze', exact: true }))
    await click(page.getByRole('button', { name: '1s', exact: true }))
    await expect(page.locator('.timeline-time')).toContainText('/ 00:07.00')

    await click(page.getByRole('button', { name: 'Export', exact: true }))
    await expect(page.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 60_000 })
    await expect.poll(() => existsSync(output), { timeout: 5_000 }).toBe(true)

    expect(mediaDuration(output)).toBeCloseTo(7, 1)
    const frozenFrame = videoFrame(output, 6.5)
    const inputFrame = videoFrame(input, 6 - 1 / 24)
    expect(frozenFrame.length).toBe(320 * 180 * 3)
    expect(inputFrame.length).toBe(320 * 180 * 3)
    expect(meanPixelDifference(frozenFrame, inputFrame)).toBeLessThan(10)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps playback running across an appended source EOF', async () => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(tmpdir(), 'otc-eof-playback-'))
  const input = syntheticVideo(directory)
  const app = await electron.launch({
    args: [main, input],
    env: e2eEnvironment({ otc_E2E_VIDEO: input })
  })

  try {
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await expect(page.getByText('game.mp4', { exact: true })).toBeVisible()

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.timeline-time')).toContainText('00:06.00 / 00:06.00')

    await click(page.getByRole('button', { name: 'Video', exact: true }))
    await click(page.getByRole('button', { name: 'Select video', exact: true }))
    await completeVideoPicker(page)
    await expect(page.locator('.timeline-time')).toContainText('/ 00:12.00')
    const back = page.getByRole('button', { name: '← Back', exact: true })
    if (await back.isVisible()) await click(back)

    await seekTimeline(page, 0)
    await expect(page.locator('.timeline-time')).toContainText('00:00.00 / 00:12.00')
    await click(page.getByRole('button', { name: 'Play', exact: true }))

    const readPlayhead = (): Promise<number> => page.locator('.timeline-time').evaluate((element) => {
      const [clock] = element.textContent.split(' / ')
      const parts = (clock ?? '00:00.00').split(':')
      const [seconds, frames] = (parts.at(-1) ?? '00.00').split('.')
      const minutes = Number(parts.at(-2) ?? 0)
      return minutes * 60 + Number(seconds ?? 0) + Number(frames ?? 0) / 24
    })
    await expect.poll(readPlayhead, { timeout: 15_000 }).toBeGreaterThan(6.5)
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await expect.poll(readPlayhead, { timeout: 15_000 }).toBeGreaterThanOrEqual(12)
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

    await click(page.getByRole('button', { name: 'Freeze', exact: true }))
    await click(page.getByRole('button', { name: '1s', exact: true }))
    await expect(page.locator('.timeline-time')).toContainText('00:12.00 / 00:13.00')
    // Simulate a paused compositor while the freeze frame remains visible.
    await page.evaluate(() => { window.requestAnimationFrame = () => 0 })
    await click(page.getByRole('button', { name: 'Play', exact: true }))
    await expect.poll(readPlayhead, { timeout: 5_000 }).toBeGreaterThanOrEqual(13)
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})
