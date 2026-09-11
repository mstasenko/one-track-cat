import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { click, dismissHardwareWarningIfNeeded, e2eEnvironment, ffmpeg, hover, main, seekTimeline } from './support'

type MediaKind = 'image' | 'video'

function blackBase(directory: string): string {
  const path = join(directory, 'base.mp4')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:size=320x180:rate=24:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', path
  ])
  return path
}

function whiteOverlay(directory: string, kind: MediaKind): string {
  const extension = kind === 'image' ? 'png' : 'mp4'
  const path = join(directory, `overlay.${extension}`)
  const input = 'color=c=white:size=64x64:rate=24:duration=1'
  const output = kind === 'image'
    ? ['-frames:v', '1', path]
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', path]
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', input, ...output])
  return path
}

function meanBrightness(frame: Buffer): number {
  let total = 0
  for (const value of frame) total += value
  return total / Math.max(1, frame.length)
}

function overlayBrightness(path: string, frameIndex: number): number {
  const frame = execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', path,
    '-vf', `select='eq(n\\,${frameIndex})',crop=20:20:240:30`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ])
  expect(frame).toHaveLength(20 * 20 * 3)
  return meanBrightness(frame)
}

async function styleOpacity(locator: Locator): Promise<number> {
  return locator.evaluate((element) => Number.parseFloat((element as HTMLElement).style.opacity || '1'))
}

async function closeWithoutSave(app: ElectronApplication | undefined): Promise<void> {
  if (app) await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined)
}

async function openEditor(input: string | undefined, media: string, output?: string): Promise<ElectronApplication> {
  return electron.launch({
    args: input ? [main, input] : [main],
    env: e2eEnvironment({
      otc_E2E_MEDIA: media,
      ...(output ? { otc_E2E_OUTPUT: output } : {})
    })
  })
}

async function configureMediaFade(page: Page): Promise<void> {
  const inspector = page.locator('.inspector')
  await expect(inspector).toBeVisible()
  const animation = inspector.locator('.control-row').filter({ hasText: 'Animation' }).locator('select')
  await animation.selectOption('fade')
  await inspector.getByRole('spinbutton', { name: 'Appears at' }).fill('0.5')
  await inspector.getByRole('spinbutton', { name: 'Opacity' }).fill('0.6')
  await inspector.getByRole('spinbutton', { name: 'Visual fade in' }).fill('0.1')
  await inspector.getByRole('spinbutton', { name: 'Visual fade out' }).fill('0.1')
  await expect(inspector.getByRole('spinbutton', { name: 'Appears at' })).toHaveValue('0.5')
  await expect(inspector.getByRole('spinbutton', { name: 'Opacity' })).toHaveValue('0.6')
  await expect(inspector.getByRole('spinbutton', { name: 'Visual fade in' })).toHaveValue('0.1')
  await expect(inspector.getByRole('spinbutton', { name: 'Visual fade out' })).toHaveValue('0.1')
}

async function setMediaFade(page: Page): Promise<void> {
  await click(page.getByRole('button', { name: 'New', exact: true }))
  const animation = page.locator('.inspector').locator('.control-row').filter({ hasText: 'Animation' }).locator('select')
  await expect(animation).toHaveValue('none')
  await expect(animation.locator('option')).toHaveCount(5)
  await expect(page.getByRole('button', { name: 'Preview animation' })).toHaveCount(0)
  await animation.selectOption('pop')
  await page.getByRole('spinbutton', { name: 'Animation duration', exact: true }).fill('0.8')
  await configureMediaFade(page)
}

async function exportCurrentAnimation(page: Page, output: string): Promise<void> {
  await click(page.getByRole('button', { name: 'Export', exact: true }))
  await expect.poll(() => existsSync(output), { timeout: 85_000 }).toBe(true)
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 85_000 })
}

async function assertPreviewAndTimeline(page: Page, kind: MediaKind, duration: number): Promise<void> {
  const mediaSelector = kind === 'image' ? '.visual-overlay img' : '.visual-overlay video'
  const hoverSelector = kind === 'image' ? '.timeline-hover-overlay img' : '.timeline-hover-overlay video'
  const preview = page.locator(mediaSelector)
  const partialTime = 0.55
  const plateauTime = 1
  const endTime = 0.5 + duration - 0.01
  // Pointer coordinates can round just before an exact start; sample inside the fade.
  const fadeProbeTime = 0.51

  await seekTimeline(page, fadeProbeTime / 3)
  await expect(preview).toHaveCount(1)
  await expect.poll(() => styleOpacity(preview)).toBeLessThan(0.05)
  await expect.poll(() => page.locator('.visual-overlay').evaluate((element) => Number.parseFloat((element as HTMLElement).style.opacity))).toBeCloseTo(0.6, 2)

  await seekTimeline(page, partialTime / 3)
  await expect.poll(() => styleOpacity(preview)).toBeCloseTo(0.5, 1)
  await seekTimeline(page, plateauTime / 3)
  await expect.poll(() => styleOpacity(preview)).toBeGreaterThan(0.95)
  await seekTimeline(page, endTime / 3)
  await expect.poll(() => styleOpacity(preview)).toBeLessThan(0.05)

  const timeline = page.locator('.timeline')
  const box = await timeline.boundingBox()
  if (!box) throw new Error('Timeline is not visible')
  await hover(timeline, { position: { x: box.width * (fadeProbeTime / 3), y: 20 } })
  const hoverMedia = page.locator(hoverSelector)
  await expect(hoverMedia).toHaveCount(1)
  await expect.poll(() => styleOpacity(hoverMedia)).toBeLessThan(0.05)
  await hover(timeline, { position: { x: box.width * (plateauTime / 3), y: 20 } })
  await expect.poll(() => styleOpacity(hoverMedia)).toBeGreaterThan(0.95)
}

function assertExport(path: string, duration: number): void {
  const start = overlayBrightness(path, 12)
  const partial = overlayBrightness(path, 13)
  const plateau = overlayBrightness(path, 24)
  const end = overlayBrightness(path, Math.ceil((0.5 + duration) * 24) - 1)
  expect(start).toBeLessThan(30)
  expect(partial).toBeGreaterThan(30)
  expect(partial).toBeLessThan(plateau - 20)
  expect(plateau).toBeGreaterThan(120)
  expect(plateau).toBeLessThan(190)
  expect(end).toBeGreaterThan(30)
  expect(end).toBeLessThan(plateau - 20)
}

async function runMediaFadeCase(kind: MediaKind): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `media-fade-${kind}-`))
  const input = blackBase(directory)
  const media = whiteOverlay(directory, kind)
  const output = join(directory, `${kind}-fade.mp4`)
  const duration = kind === 'image' ? 2.5 : 1
  let app: ElectronApplication | undefined
  let restored: ElectronApplication | undefined
  try {
    app = await openEditor(input, media, output)
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await expect(page.getByText('base.mp4', { exact: true })).toBeVisible()
    await seekTimeline(page, 0.5 / 3)
    await setMediaFade(page)

    await assertPreviewAndTimeline(page, kind, duration)

    await exportCurrentAnimation(page, output)
    assertExport(output, duration)

    await app.close()
    app = undefined
    restored = await openEditor(undefined, media)
    const restoredPage = await restored.firstWindow()
    await dismissHardwareWarningIfNeeded(restoredPage)
    await expect(restoredPage.getByText('base.mp4', { exact: true })).toBeVisible()
    const restoredInspector = restoredPage.locator('.inspector')
    await expect(restoredInspector.locator('.control-row').filter({ hasText: 'Animation' }).locator('select')).toHaveValue('fade')
    await expect(restoredInspector.getByRole('spinbutton', { name: 'Appears at' })).toHaveValue('0.5')
    await expect(restoredInspector.getByRole('spinbutton', { name: 'Opacity' })).toHaveValue('0.6')
    await expect(restoredInspector.getByRole('spinbutton', { name: 'Visual fade in' })).toHaveValue('0.1')
    await expect(restoredInspector.getByRole('spinbutton', { name: 'Visual fade out' })).toHaveValue('0.1')
    await restoredInspector.locator('.control-row').filter({ hasText: 'Animation' }).locator('select').selectOption('pop')
    await expect(restoredInspector.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('0.8')
  } finally {
    await closeWithoutSave(restored)
    await closeWithoutSave(app)
    rmSync(directory, { recursive: true, force: true })
  }
}

test('fades image overlays in preview, timeline hover, export, and saved sessions', async () => {
  test.setTimeout(90_000)
  await runMediaFadeCase('image')
})

test('fades video overlays in preview, timeline hover, export, and saved sessions', async () => {
  test.setTimeout(90_000)
  await runMediaFadeCase('video')
})
