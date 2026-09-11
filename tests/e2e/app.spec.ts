import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  click,
  dismissHardwareWarning,
  dismissHardwareWarningIfNeeded,
  e2eEnvironment,
  ffmpeg,
  hover,
  main,
  scroll
} from './support'

function captureDiagnostics(window: import('@playwright/test').Page): string[] {
  const consoleMessages: string[] = []
  window.on('console', (message) => {
    consoleMessages.push(message.text())
    process.stdout.write(`[renderer:${message.type()}] ${message.text()}\n`)
  })
  window.on('pageerror', (error) => process.stdout.write(`[renderer:error] ${error.message}\n`))
  return consoleMessages
}

test('launches as a native Wayland editor', async () => {
  const app = await electron.launch({ args: [main], env: e2eEnvironment() })
  const window = await app.firstWindow()
  captureDiagnostics(window)
  expect(await app.evaluate(({ app }) => app.getName())).toBe('OneTrackCat')
  await expect(window).toHaveTitle('OneTrackCat')
  await expect(window.getByRole('heading', { name: 'Drop a video' })).toBeVisible()
  await expect(window.locator('.welcome-brand img')).toBeVisible()
  await expect(window.locator('.welcome-brand')).toContainText('OneTrackCat')
  await expect(window.getByText(/GPU (on|fallback)/)).toHaveCount(0)
  await app.close()
})

test('opens, edits, and exports real media', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'otc-e2e-'))
  const input = join(directory, 'input.mp4')
  const output = join(directory, 'output.mp4')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input
  ])

  const app = await electron.launch({
    args: [main, input],
    env: e2eEnvironment({ otc_E2E_OUTPUT: output })
  })
  const window = await app.firstWindow()
  const consoleMessages = captureDiagnostics(window)
  await expect(window.getByText('input.mp4', { exact: true })).toBeVisible({ timeout: 15_000 })
  await dismissHardwareWarningIfNeeded(window)
  const preview = window.locator('.camera-layer > video:not(.preview-transition-previous)')
  await expect.poll(() => preview.evaluate((element) => {
    const video = element as HTMLVideoElement
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      readyState: video.readyState,
      error: video.error?.message ?? null
    }
  }), { timeout: 15_000 }).toMatchObject({ width: 320, height: 180, error: null })
  await expect(preview).toBeVisible()
  await click(window.getByRole('button', { name: 'Play', exact: true }))
  await expect.poll(() => preview.evaluate((element) => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0.2)
  await click(window.getByRole('button', { name: 'Pause', exact: true }))
  expect(consoleMessages.some((message) => message.includes('MediaElementAudioSource outputs zeroes'))).toBe(false)
  await expect(window.getByText('Honest Work', { exact: true })).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'GIFs', exact: true })).toHaveCount(0)
  await expect(window.locator('.asset-search')).toHaveCount(0)
  await expect(window.locator('.asset-list')).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'Add library folder' })).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'Import collection' })).toHaveCount(0)
  await click(window.getByRole('button', { name: 'Text', exact: true }))
  await window.getByRole('textbox', { name: 'Text' }).fill('E2E WORKS')
  const exportButton = window.getByRole('button', { name: 'Export', exact: true })
  await click(exportButton)
  await expect(window.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
  await expect(exportButton).toBeEnabled({ timeout: 30_000 })
  await expect.poll(() => existsSync(output)).toBe(true)
  await app.close()
  rmSync(directory, { recursive: true, force: true })
})

test('scrolls and previews visual assets before adding one', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'otc-picture-'))
  const input = join(directory, 'input.mp4')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=black:size=320x180:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input
  ])
  const app = await electron.launch({
    args: [main, input],
    env: e2eEnvironment({ otc_E2E_COMPACT: '1' })
  })
  const window = await app.firstWindow()
  await expect(window.getByText('input.mp4', { exact: true })).toBeVisible()
  await dismissHardwareWarningIfNeeded(window)
  await click(window.getByRole('button', { name: 'Images', exact: true }))
  const imageList = window.locator('.asset-list')
  await expect.poll(() => imageList.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  const imageButtons = imageList.locator(':scope > button')
  expect(await imageButtons.evaluateAll((buttons) => buttons.every((button) => button.getBoundingClientRect().height >= 34))).toBe(true)
  await scroll(imageList, 500)
  await expect.poll(() => imageList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const honestWork = window.getByRole('button', { name: 'Honest Work', exact: true })
  await hover(honestWork)
  const imagePreview = window.getByLabel('Preview of Honest Work')
  await expect(imagePreview).toBeVisible()
  await expect.poll(() => imagePreview.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(window.locator('.timeline-overlay')).toHaveCount(0)
  await click(honestWork)
  await expect(window.getByRole('button', { name: '← Back' })).toBeVisible()
  await window.getByRole('spinbutton', { name: 'Opacity' }).fill('0.5')
  await click(window.getByRole('button', { name: 'Remove from video' }))
  await expect(window.getByRole('button', { name: 'Honest Work', exact: true })).toBeVisible()
  await expect(window.locator('.timeline-overlay')).toHaveCount(0)
  await click(window.getByRole('button', { name: '← Back' }))
  await click(window.getByRole('button', { name: 'Videos', exact: true }))
  await hover(window.getByRole('button', { name: 'Obama Mic Drop', exact: true }))
  const videoPreview = window.getByLabel('Preview of Obama Mic Drop')
  await expect(videoPreview).toBeVisible()
  await expect.poll(() => videoPreview.locator('video').evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThan(0)
  await click(window.getByRole('button', { name: '← Back' }))
  await click(window.getByRole('button', { name: 'Audio', exact: true }))
  await expect(window.getByRole('button', { name: 'Play Wilhelm Scream' })).toBeVisible()
  await click(window.getByRole('button', { name: 'Wilhelm Scream', exact: true }))
  await expect(window.getByText('Length', { exact: true })).toBeVisible()
  await expect(window.getByText('Visible for', { exact: true })).toHaveCount(0)
  await app.close()
  rmSync(directory, { recursive: true, force: true })
})

test('shows a plain warning when hardware acceleration is unavailable', async () => {
  const app = await electron.launch({
    args: [main],
    env: e2eEnvironment({ otc_E2E_GPU_OFF: '1' })
  })
  const window = await app.firstWindow()
  const warning = window.getByRole('alertdialog', { name: 'Hardware acceleration is unavailable' })
  await expect(warning).toBeVisible()
  await expect(window.getByText(/GPU (on|fallback)/)).toHaveCount(0)
  await dismissHardwareWarning(window)
  await expect(warning).toBeHidden()
  await app.close()
})

test('seeks and plays a synthetic twenty-minute video', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'otc-long-'))
  const input = join(directory, 'synthetic-long.mp4')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=black:size=320x180:rate=1:duration=1200',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-pix_fmt', 'yuv420p', input
  ])
  const app = await electron.launch({ args: [main, input], env: e2eEnvironment() })
  const window = await app.firstWindow()
  const preview = window.locator('.camera-layer > video:not(.preview-transition-previous)')
  await expect(window.getByText('synthetic-long.mp4', { exact: true })).toBeVisible({ timeout: 15_000 })
  await dismissHardwareWarningIfNeeded(window)
  await expect.poll(() => preview.evaluate((element) => (element as HTMLVideoElement).videoWidth), { timeout: 15_000 }).toBe(320)
  await expect(preview).toBeVisible()
  const timeline = window.locator('.timeline')
  const box = await timeline.boundingBox()
  if (!box) throw new Error('Timeline is not visible')
  await click(timeline, { position: { x: box.width / 2, y: box.height / 2 } })
  await click(window.getByRole('button', { name: 'Mark', exact: true }))
  await click(window.getByRole('button', { name: 'Play', exact: true }))
  await expect.poll(() => preview.evaluate((element) => (element as HTMLVideoElement).currentTime), { timeout: 15_000 }).toBeGreaterThan(599)
  await expect.poll(() => preview.evaluate((element) => (element as HTMLVideoElement).error?.code ?? 0)).toBe(0)
  await app.close()
  rmSync(directory, { recursive: true, force: true })
})
