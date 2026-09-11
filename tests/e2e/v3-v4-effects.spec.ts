import { expect, test, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { click, dismissHardwareWarningIfNeeded, e2eEnvironment, ffmpeg, hover, main, meanPixelDifference, mediaDuration, seekTimeline, syntheticVideo, videoFrame } from './support'

function sound(directory: string): string {
  const path = join(directory, 'boom.wav')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', path])
  return path
}


function toneEnergy(path: string, start: number, length: number, frequency: number): number {
  const bytes = execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(length), '-i', path,
    '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'
  ])
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  let sine = 0
  let cosine = 0
  for (let index = 0; index < samples.length; index += 1) {
    const phase = 2 * Math.PI * frequency * index / 48000
    sine += (samples[index] ?? 0) * Math.sin(phase)
    cosine += (samples[index] ?? 0) * Math.cos(phase)
  }
  return 2 * Math.hypot(sine, cosine) / Math.max(1, samples.length)
}

test('one click inserts, marks, exports, and removes a half-speed Replay', async () => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(tmpdir(), 'otc-v3-replay-'))
  const input = syntheticVideo(directory)
  const output = join(directory, 'replay.mp4')
  const app = await electron.launch({ args: [main, input], env: e2eEnvironment({ otc_E2E_OUTPUT: output, otc_E2E_COMPACT: '1' }) })
  try {
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await expect(page.locator('.effect-add > button')).toHaveText(['Speed', 'Replay', 'Zoom', 'Freeze', 'Transition', 'Blur faces'])
    await expect.poll(() => page.locator('.effect-add').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2)
    await expect(page.getByRole('button', { name: 'Speed', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Zoom', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeDisabled()
    await seekTimeline(page, 1 / 6); await click(page.getByRole('button', { name: 'Mark', exact: true }))
    await seekTimeline(page, 2 / 6); await click(page.getByRole('button', { name: 'Mark', exact: true }))
    await seekTimeline(page, 1.5 / 6)
    await click(page.getByRole('button', { name: 'Replay', exact: true }))
    await expect(page.locator('.replay-range')).toHaveCount(1)
    await expect(page.locator('.replay-range')).toContainText('Replay')
    await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Remove Replay', exact: true })).toHaveCount(0)
    await click(page.getByRole('button', { name: 'Export', exact: true }))
    await expect(page.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 60_000 })
    expect(existsSync(output)).toBe(true)
    expect(mediaDuration(output)).toBeCloseTo(8, 1)
    expect(meanPixelDifference(videoFrame(output, 1.5), videoFrame(output, 3))).toBeLessThan(8)
    await page.keyboard.press('Control+z')
    await expect(page.locator('.replay-range')).toHaveCount(0)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('text Pop previews from its start and exports through the local bitmap path', async () => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(tmpdir(), 'otc-v3-text-'))
  const input = syntheticVideo(directory, true)
  const output = join(directory, 'text.mp4')
  const app = await electron.launch({ args: [main, input], env: e2eEnvironment({ otc_E2E_OUTPUT: output }) })
  try {
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await click(page.getByRole('button', { name: 'Text', exact: true }))
    const animation = page.locator('.control-row').filter({ hasText: 'Animation' }).locator('select')
    await animation.selectOption('pop')
    await page.getByRole('spinbutton', { name: 'Animation duration', exact: true }).fill('0.8')
    await expect(page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('0.8')
    const timeline = page.locator('.timeline')
    const timelineBox = await timeline.boundingBox()
    if (!timelineBox) throw new Error('Timeline is not visible')
    await hover(timeline, { position: { x: timelineBox.width * 0.01, y: 20 } })
    await expect(page.locator('.timeline-hover-text-animation')).not.toHaveCSS('transform', 'none')
    await click(page.getByRole('button', { name: 'Preview text animation' }))
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
    await expect(page.locator('.preview-text')).toHaveCSS('font-weight', '700')
    await click(page.getByRole('button', { name: 'Export', exact: true }))
    await expect(page.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 60_000 })
    expect(existsSync(output)).toBe(true)
    expect(meanPixelDifference(videoFrame(output, 0.04), videoFrame(output, 0.5))).toBeGreaterThan(0.2)
    expect(meanPixelDifference(videoFrame(output, 0.04, '40:40:0:0'), videoFrame(output, 0.5, '40:40:0:0'))).toBeLessThan(0.2)
    await animation.selectOption('fade')
    await page.getByRole('spinbutton', { name: 'Visual fade in' }).fill('0.4')
    await page.getByRole('spinbutton', { name: 'Visual fade out' }).fill('0.6')
    await click(page.getByRole('button', { name: 'Export', exact: true }))
    await expect(page.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 60_000 })
    expect(meanPixelDifference(videoFrame(output, 0.02), videoFrame(output, 1))).toBeGreaterThan(0.2)
    expect(meanPixelDifference(videoFrame(output, 2.98), videoFrame(output, 1))).toBeGreaterThan(0.2)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('audio controls preserve 200 percent volume without native-volume errors', async () => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(tmpdir(), 'otc-v4-audio-'))
  const input = syntheticVideo(directory, true)
  const overlay = sound(directory)
  const output = join(directory, 'audio.mp4')
  const app = await electron.launch({ args: [main, input], env: e2eEnvironment({ otc_E2E_MEDIA: overlay, otc_E2E_OUTPUT: output }) })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await dismissHardwareWarningIfNeeded(page)
    await click(page.getByRole('button', { name: 'New', exact: true }))
    const controls = page.locator('.inspector')
    await controls.locator('.control-row').filter({ hasText: 'Volume' }).locator('input').fill('2')
    await controls.locator('.control-row').filter({ hasText: 'Fade in' }).locator('select').selectOption('0.25')
    await controls.locator('.control-row').filter({ hasText: 'Fade out' }).locator('select').selectOption('0.25')
    await click(controls.getByText('Lower game sound', { exact: true }).locator('..').locator('input'))
    await expect(controls.getByText('Game sound', { exact: true })).toBeVisible()
    await click(page.getByRole('button', { name: 'Play', exact: true }))
    await page.waitForTimeout(400)
    await expect.poll(() => page.locator('.preview-stage audio').evaluate((media) => (media as HTMLMediaElement).volume)).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
    await click(page.getByRole('button', { name: 'Export', exact: true }))
    await expect(page.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 60_000 })
    expect(existsSync(output)).toBe(true)
    expect(mediaDuration(output)).toBeCloseTo(6, 1)
    expect(toneEnergy(output, 0.45, 0.2, 880)).toBeGreaterThan(toneEnergy(output, 0.02, 0.03, 880) * 1.5)
    expect(toneEnergy(output, 0.5, 0.2, 440)).toBeLessThan(toneEnergy(output, 2.5, 0.2, 440) * 0.6)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('video audio settings follow Include audio and retain their values', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'otc-v4-video-audio-'))
  const input = syntheticVideo(directory, true)
  const app = await electron.launch({ args: [main, input], env: e2eEnvironment({ otc_E2E_MEDIA: input }) })
  try {
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await click(page.getByRole('button', { name: 'New', exact: true }))
    const inspector = page.locator('.inspector')
    const includeAudio = inspector.getByText('Include audio', { exact: true }).locator('..').locator('input')
    await expect(includeAudio).toBeVisible()
    await expect(inspector.getByText('Fade in', { exact: true })).toHaveCount(0)
    await click(includeAudio)
    const labels = await inspector.locator('.control-row > span:first-child').allTextContents()
    expect(labels.indexOf('Include audio')).toBeLessThan(labels.indexOf('Volume'))
    expect(labels.indexOf('Volume')).toBeLessThan(labels.indexOf('Fade in'))
    expect(labels.indexOf('Fade out')).toBeLessThan(labels.indexOf('Loop clip'))
    const fadeIn = inspector.locator('.control-row').filter({ hasText: 'Fade in' }).locator('select')
    await fadeIn.selectOption('0.5')
    await click(includeAudio)
    await expect(inspector.getByText('Fade in', { exact: true })).toHaveCount(0)
    await click(includeAudio)
    await expect(inspector.locator('.control-row').filter({ hasText: 'Fade in' }).locator('select')).toHaveValue('0.5')
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})
