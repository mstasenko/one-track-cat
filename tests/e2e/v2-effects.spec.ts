import { expect, test, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { click, dismissHardwareWarningIfNeeded, e2eEnvironment, ffmpeg, ffprobe, hover, main, meanPixelDifference, seekTimeline, syntheticVideo, videoFrame } from './support'

async function displayedPlayhead(page: import('@playwright/test').Page): Promise<number> {
  const value = await page.locator('.timeline-time').textContent()
  const match = value?.match(/^(\d+):(\d+\.\d+)/)
  if (!match) throw new Error(`Unexpected timeline time: ${value}`)
  return Number(match[1]) * 60 + Number(match[2])
}

async function displayedFrame(video: import('@playwright/test').Locator): Promise<number> {
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).seeking), { timeout: 15_000 }).toBe(true)
  return video.evaluate((element) => Math.floor((element as HTMLVideoElement).currentTime * 24 + 0.0000001))
}

async function stepAndWait(
  page: import('@playwright/test').Page,
  video: import('@playwright/test').Locator,
  name: 'Previous frame' | 'Next frame'
): Promise<void> {
  const sourceTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime)
  await click(page.getByRole('button', { name }))
  await expect.poll(() => video.evaluate((element, previous) => {
    const media = element as HTMLVideoElement
    return !media.seeking && Math.abs(media.currentTime - previous) > 0.001
  }, sourceTime), { timeout: 15_000 }).toBe(true)
}

test('focus zoom and freeze stay compact and match the timeline hover preview', async () => {
  test.setTimeout(60_000)
  const directory = mkdtempSync(join(tmpdir(), 'otc-v2-effects-'))
  const input = syntheticVideo(directory)
  const app = await electron.launch({ args: [main, input], env: e2eEnvironment() })
  try {
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    const preview = page.locator('.camera-layer > video:not(.preview-transition-previous)')
    await expect.poll(() => preview.evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
    const stage = page.locator('.preview-stage')
    const originalHeight = await stage.evaluate((element) => element.getBoundingClientRect().height)

    await seekTimeline(page, 5 / 6)
    const slowRangeEnd = await displayedPlayhead(page)
    await click(page.getByRole('button', { name: 'Mark', exact: true }))
    await seekTimeline(page, 0)
    await click(page.getByRole('button', { name: 'Speed', exact: true }))
    await click(page.getByRole('button', { name: '½×', exact: true }))
    const slowFrame = await displayedFrame(preview)
    await stepAndWait(page, preview, 'Next frame')
    expect(await displayedFrame(preview)).not.toBe(slowFrame)
    await expect.poll(async () => {
      const text = await page.locator('.timeline-time').textContent()
      const match = text?.match(/\/ (\d+):(\d+\.\d+)/)
      return match ? Number(match[1]) * 60 + Number(match[2]) : 0
    }).toBeCloseTo(6 + slowRangeEnd, 1)
    await click(page.getByRole('button', { name: 'Undo' }))
    await click(page.getByRole('button', { name: 'Undo' }))
    await click(page.getByRole('button', { name: '← Back' }))
    await seekTimeline(page, 0)
    await expect.poll(async () => {
      const playhead = await displayedPlayhead(page)
      return preview.evaluate((element, expected) => Math.abs((element as HTMLVideoElement).currentTime - expected), playhead + 0.5 / 24)
    }, { timeout: 15_000 }).toBeLessThan(0.01)

    const firstFrame = await displayedFrame(preview)
    await stepAndWait(page, preview, 'Next frame')
    const nextFrame = await displayedFrame(preview)
    expect(nextFrame).not.toBe(firstFrame)
    await stepAndWait(page, preview, 'Previous frame')
    expect(await displayedFrame(preview)).not.toBe(nextFrame)

    await seekTimeline(page, 1 / 6); await click(page.getByRole('button', { name: 'Mark', exact: true }))
    await seekTimeline(page, 3 / 6); await click(page.getByRole('button', { name: 'Mark', exact: true }))
    await seekTimeline(page, 2 / 6)
    await click(page.getByRole('button', { name: 'Zoom', exact: true }))
    await expect(page.getByRole('button', { name: '← Back' })).toBeVisible()
    await expect(page.locator('.effect-options > button')).toHaveText(['1.5×', '2×', '3×', '4×', '5×', '6×', '7×', '8×', '9×', '10×'])
    expect(await stage.evaluate((element) => element.getBoundingClientRect().height)).toBe(originalHeight)
    await click(page.getByRole('button', { name: '10×', exact: true }))
    await expect(page.locator('.focus-prompt')).toContainText('Click what to focus on')
    const stageBox = await stage.boundingBox()
    if (!stageBox) throw new Error('Preview is not visible')
    await click(stage, { position: { x: stageBox.width * 0.75, y: stageBox.height * 0.5 } })
    await expect(page.locator('.focus-zoom-range')).toBeVisible()
    await expect.poll(() => page.locator('.camera-layer').evaluate((element) => getComputedStyle(element).transform)).not.toBe('none')
    const timeline = page.locator('.timeline')
    const timelineBox = await timeline.boundingBox()
    if (!timelineBox) throw new Error('Timeline is not visible')
    await hover(timeline, { position: { x: timelineBox.width / 3, y: 20 } })
    await expect(page.locator('.timeline-hover-camera')).not.toHaveCSS('transform', 'none')
    await hover(page.locator('.transport'))

    await seekTimeline(page, 4 / 6)
    await click(page.getByRole('button', { name: '← Back' }))
    await click(page.getByRole('button', { name: 'Freeze', exact: true }))
    await expect(page.locator('.effect-options > button')).toHaveText(['0.5s', '1s', '2s', '3s', '4s', '5s'])
    await click(page.getByRole('button', { name: '1s', exact: true }))
    await expect(page.locator('.freeze-segment')).toBeVisible()
    await expect(page.locator('.timeline-time')).toContainText('/ 00:07.00')
    await click(page.getByRole('button', { name: '← Back' }))
    await click(page.getByRole('button', { name: 'Speed', exact: true }))
    await expect(page.getByRole('button', { name: '1×', exact: true })).toBeEnabled()

    await page.setViewportSize({ width: 800, height: 600 })
    await expect(page.locator('.transport')).toHaveCSS('height', '40px')
    await expect(page.locator('.editor-column')).toHaveCSS('grid-template-rows', /.+ 98px/)
    const controls = page.locator('.transport').locator(':scope > *')
    await expect(controls).toHaveCount(12)
    const layout = await controls.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return { center: rect.top + rect.height / 2, right: rect.right }
    }).filter(({ right }) => right > 0))
    expect(Math.max(...layout.map(({ center }) => center)) - Math.min(...layout.map(({ center }) => center))).toBeLessThan(2)
    const transportRight = await page.locator('.transport').evaluate((element) => element.getBoundingClientRect().right)
    expect(layout.at(-1)?.right ?? Infinity).toBeLessThanOrEqual(transportRight + 0.1)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('exports the real focus zoom and frozen frame', async () => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(tmpdir(), 'otc-v2-export-'))
  const input = syntheticVideo(directory)
  const output = join(directory, 'output.mp4')
  const app = await electron.launch({ args: [main, input], env: e2eEnvironment({ otc_E2E_OUTPUT: output }) })
  try {
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await seekTimeline(page, 1 / 6); await click(page.getByRole('button', { name: 'Mark', exact: true }))
    await seekTimeline(page, 3 / 6); await click(page.getByRole('button', { name: 'Mark', exact: true }))
    await seekTimeline(page, 2 / 6); await click(page.getByRole('button', { name: 'Zoom', exact: true }))
    await click(page.getByRole('button', { name: '10×', exact: true }))
    const stage = page.locator('.preview-stage')
    const stageBox = await stage.boundingBox()
    if (!stageBox) throw new Error('Preview is not visible')
    await click(stage, { position: { x: stageBox.width * 0.75, y: stageBox.height * 0.5 } })
    await seekTimeline(page, 4 / 6); await click(page.getByRole('button', { name: '← Back' }))
    await click(page.getByRole('button', { name: 'Freeze', exact: true }))
    await click(page.getByRole('button', { name: '1s', exact: true }))

    await click(page.getByRole('button', { name: 'Export', exact: true }))
    await expect(page.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 60_000 })
    expect(existsSync(output)).toBe(true)
    const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_format', '-of', 'json', output], { encoding: 'utf8' })) as { format: { duration: string } }
    expect(Number(info.format.duration)).toBeCloseTo(7, 1)
    expect(meanPixelDifference(videoFrame(input, 2), videoFrame(output, 2))).toBeGreaterThan(10)
    const frozenStart = videoFrame(output, 4.15)
    expect(meanPixelDifference(frozenStart, videoFrame(output, 4.5))).toBeLessThan(2)
    expect(meanPixelDifference(frozenStart, videoFrame(output, 4.85))).toBeLessThan(2)
    const frozenAudio = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '4.15', '-t', '0.7', '-i', output, '-map', '0:a:0', '-f', 's16le', '-ac', '1', 'pipe:1'])
    expect(Math.max(...new Int16Array(frozenAudio.buffer, frozenAudio.byteOffset, frozenAudio.byteLength / 2).map(Math.abs))).toBeLessThan(200)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})
