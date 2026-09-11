import { expect, test, _electron as electron } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  click,
  completeVideoPicker,
  dismissHardwareWarningIfNeeded,
  e2eEnvironment,
  ffmpeg,
  hover,
  main,
  seekTimeline
} from './support'

interface VideoFixture {
  directory: string
  first: string
  second: string
}

function writeTinyVideo(path: string, color: string): void {
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:size=64x36:rate=12:duration=1.2`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', path
  ])
}

function createFixture(): VideoFixture {
  const directory = mkdtempSync(join(tmpdir(), 'otc-video-picker-'))
  mkdirSync(join(directory, 'nested'))
  const first = join(directory, 'first.mp4')
  const second = join(directory, 'second.mp4')
  writeTinyVideo(first, 'blue')
  writeTinyVideo(second, 'red')
  writeTinyVideo(join(directory, 'nested', 'nested.mp4'), 'green')
  return { directory, first, second }
}

async function launch(input: string, fallback: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [main, input],
    env: e2eEnvironment({ otc_E2E_VIDEO: fallback })
  })
  await dismissHardwareWarningIfNeeded(await app.firstWindow())
  return app
}

async function close(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined)
}

test('lists videos, previews one muted file, and keeps an open project safe', async () => {
  test.setTimeout(60_000)
  const fixture = createFixture()
  const app = await launch(fixture.first, fixture.second)

  try {
    const page = await app.firstWindow()
    await expect(page.locator('.source-segment').first()).toHaveAttribute('title', 'first.mp4')
    await seekTimeline(page, 0.25)
    await click(page.getByRole('button', { name: 'Mark', exact: true }))
    await seekTimeline(page, 0.75)
    await click(page.getByRole('button', { name: 'Mark', exact: true }))
    const beforeSegmentCount = await page.locator('.source-segment').count()
    const beforeTimeline = await page.locator('.timeline-time').textContent()

    await click(page.getByRole('button', { name: 'Open', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Open a video' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('button.video-picker-video')).toHaveCount(2)
    const first = dialog.locator('button.video-picker-video').filter({ hasText: 'first.mp4' })
    const second = dialog.locator('button.video-picker-video').filter({ hasText: 'second.mp4' })
    await expect(first).toBeVisible()
    await expect(second).toBeVisible()
    await expect(dialog.locator('button.video-picker-directory').filter({ hasText: 'nested' })).toBeVisible()

    const preview = page.locator('[data-video-picker] .video-picker-preview video')
    await expect(preview).toHaveCount(1)
    await second.focus()
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => ({
      muted: video.muted,
      paused: video.paused
    })), { timeout: 5_000 }).toMatchObject({ muted: true, paused: false })
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 5_000 }).toBeGreaterThan(0.05)
    const previewTime = await preview.evaluate((video: HTMLVideoElement) => video.currentTime)
    await page.waitForTimeout(200)
    expect(await preview.evaluate((video: HTMLVideoElement) => video.currentTime)).not.toBe(previewTime)

    await second.evaluate((button) => (button as HTMLElement).blur())
    await hover(first)
    await expect(dialog.locator('.video-picker-preview')).toHaveAttribute('aria-label', /first\.mp4/)
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 5_000 }).toBeGreaterThan(0.05)
    await first.evaluate((button) => (button as HTMLElement).blur())
    await hover(dialog.getByRole('heading', { name: 'Open a video' }))
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.paused), { timeout: 5_000 }).toBe(true)
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.getAttribute('src')), { timeout: 5_000 }).toBeNull()

    await second.focus()
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => !video.paused), { timeout: 5_000 }).toBe(true)
    await page.keyboard.press('Delete')
    await expect(page.locator('.source-segment')).toHaveCount(beforeSegmentCount)
    await expect(page.locator('.source-segment').first()).toHaveAttribute('title', 'first.mp4')
    await expect(page.locator('.timeline-time')).toHaveText(beforeTimeline ?? '')

    await click(dialog.getByRole('button', { name: 'Cancel', exact: true }))
    await expect(dialog).toBeHidden()
    await expect(page.locator('.source-segment').first()).toHaveAttribute('title', 'first.mp4')
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.paused), { timeout: 5_000 }).toBe(true)
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.getAttribute('src')), { timeout: 5_000 }).toBeNull()
  } finally {
    await close(app)
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('opens the selected file from the chooser', async () => {
  test.setTimeout(60_000)
  const fixture = createFixture()
  const app = await launch(fixture.first, fixture.second)

  try {
    const page = await app.firstWindow()
    await click(page.getByRole('button', { name: 'Open', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Open a video' })
    await expect(dialog).toBeVisible()
    await click(dialog.locator('button.video-picker-video').filter({ hasText: 'second.mp4' }))
    await expect(dialog).toBeHidden()
    await expect(page.locator('.source-segment').first()).toHaveAttribute('title', 'second.mp4')
  } finally {
    await close(app)
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('opens a Short through the native chooser fallback with a cover canvas', async () => {
  test.setTimeout(60_000)
  const fixture = createFixture()
  const app = await launch(fixture.first, fixture.first)

  try {
    const page = await app.firstWindow()
    await click(page.getByRole('button', { name: 'Open Short', exact: true }))
    await completeVideoPicker(page)
    await expect(page.locator('.preview-stage')).toHaveCSS('aspect-ratio', '1080 / 1920')
    await expect(page.locator('.source-segment').first()).toHaveAttribute('title', 'first.mp4')
  } finally {
    await close(app)
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})
