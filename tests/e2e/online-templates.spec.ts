import { expect, test, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  click,
  dismissHardwareWarningIfNeeded,
  e2eEnvironment,
  ffmpeg,
  hover,
  main,
  scroll
} from './support'

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

interface Fixture {
  directory: string
  input: string
  image: string
}

type SearchMode = 'all' | 'imgflip-offline' | 'many' | 'video'

function createFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'otc-online-templates-'))
  const input = join(directory, 'base.mp4')
  const image = join(directory, 'fixture.png')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:size=64x36:rate=12:duration=1.2',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-an', input
  ])
  writeFileSync(image, tinyPng)
  return { directory, input, image }
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [main, fixture.input],
    env: e2eEnvironment({
      otc_HEADLESS_TEST: '1',
      otc_E2E_COMPACT: '1',
      otc_E2E_GPU_OFF: '1',
      otc_E2E_MEDIA: fixture.image
    })
  })
  await dismissHardwareWarningIfNeeded(await app.firstWindow())
  return app
}

async function mockTemplates(app: ElectronApplication, asset: { type: string; name: string; path: string }, mode: SearchMode): Promise<void> {
  await app.evaluate(({ ipcMain }, options) => {
    const memefact = [
      { id: '7', source: 'memefact', name: 'Shared Cat', type: 'image', url: 'https://i.imgflip.com/otc-shared.png' }
    ]
    const ordinaryImgflip = [
      { id: '007', source: 'imgflip', name: 'Duplicate Imgflip', type: 'image', url: 'https://i.imgflip.com/otc-shared.png' },
      { id: '8', source: 'imgflip', name: 'Imgflip Cat', type: 'image', url: 'https://i.imgflip.com/otc-only.png' }
    ]
    const imkg = [
      { id: '007', source: 'imkg', name: 'IMKG Cat', type: 'image', url: 'https://i.imgflip.com/otc-imkg.png' }
    ]
    const video = [
      { id: '42', source: 'imgflip', name: 'Online Video', type: 'video', url: 'https://i.imgflip.com/otc-video.mp4' }
    ]
    const imgflip = options.mode === 'many'
      ? Array.from({ length: 23 }, (_, index) => ({
          id: String(index + 8),
          source: 'imgflip',
          name: `Online ${index + 8}`,
          type: 'image',
          url: 'https://i.imgflip.com/otc-only.png'
        }))
      : ordinaryImgflip
    ipcMain.removeHandler('templates:search')
    ipcMain.handle('templates:search', (_event, source: unknown) => {
      if (source === 'memefact') return options.mode === 'video' ? [] : memefact
      if (source === 'imgflip' && options.mode === 'imgflip-offline') throw new Error('Imgflip offline')
      if (source === 'imkg') return options.mode === 'many' || options.mode === 'video' ? [] : imkg
      if (options.mode === 'video') return video
      return imgflip
    })
    ipcMain.removeHandler('templates:import')
    ipcMain.handle('templates:import', (_event, source: unknown) => ({
      ...options.asset,
      name: options.mode === 'video' ? 'Online Video' : source === 'imkg' ? 'IMKG Cat' : 'Shared Cat'
    }))
    ipcMain.removeHandler('templates:open-page')
    ipcMain.handle('templates:open-page', () => undefined)
  }, { asset, mode })
}

async function routePreviews(page: Page, videoPath?: string): Promise<void> {
  await page.route(/^https:\/\/i\.imgflip\.com\/otc-(?:shared|only|imkg)\.png$/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng }))
  if (videoPath) {
    await page.route('https://i.imgflip.com/otc-video.mp4', (route) =>
      route.fulfill({ status: 200, contentType: 'video/mp4', body: readFileSync(videoPath) }))
  }
}

async function prepare(fixture: Fixture, mode: SearchMode): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(fixture)
  const page = await app.firstWindow()
  await routePreviews(page, mode === 'video' ? fixture.input : undefined)
  const asset = await page.evaluate(() => window.otc.openMedia())
  if (!asset) throw new Error('Test media was not returned by the native media chooser')
  expect(asset.path).toBe(fixture.image)
  await mockTemplates(app, asset, mode)
  return { app, page }
}

async function close(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined)
}

test('shows online templates below local assets, previews the image, deduplicates providers, and inserts it', async () => {
  test.setTimeout(60_000)
  const fixture = createFixture()
  const { app, page } = await prepare(fixture, 'all')
  try {
    await click(page.getByRole('button', { name: 'Images', exact: true }))
    const search = page.getByPlaceholder('Search images')
    await search.fill('cat')

    const online = page.locator('.online-templates')
    const list = online.locator('.asset-list')
    await expect(online).toBeVisible()
    await expect(list).toHaveCount(1)
    await expect(online.locator('.online-template-results')).toHaveCount(0)
    await expect(online.locator('h3')).toHaveCount(0)
    await expect(online.locator('[data-template-id="7"]')).toContainText('Shared Cat')
    await expect(online.locator('[data-template-id="8"]')).toHaveAttribute('title', /Online .*Imgflip/)
    await expect(online.locator('[data-template-id="007"]')).toHaveCount(1)
    await expect(online.locator('[data-template-id="007"]')).toContainText('IMKG Cat')
    await expect(online.locator('[data-template-id="007"]')).toHaveAttribute('title', /Online .*IMKG/)
    await expect(online.locator('[data-template-id="7"]')).toHaveAttribute('title', /Online .*MemeFact/)
    await expect(online.locator('[data-template-id="7"]')).toHaveAttribute('title', /Shared Cat/)

    const firstResult = online.locator('[data-template-id="7"]')
    const compactWidths = await firstResult.evaluate((button) => {
      const link = button.parentElement?.querySelector<HTMLElement>('.online-template-link')
      const style = window.getComputedStyle(button)
      const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
      const paddingRight = Number.parseFloat(style.paddingRight) || 0
      const buttonRect = button.getBoundingClientRect()
      const linkRect = link?.getBoundingClientRect()
      const nameWidth = button.clientWidth - paddingLeft - paddingRight
      return {
        name: { clientWidth: nameWidth, rectWidth: nameWidth },
        button: { clientWidth: button.clientWidth, rectWidth: buttonRect.width },
        link: link ? { clientWidth: link.clientWidth, rectWidth: linkRect?.width ?? 0 } : null,
        nameRight: buttonRect.right - paddingRight,
        linkLeft: linkRect?.left ?? null
      }
    })
    console.log(`compact template widths: ${JSON.stringify(compactWidths)}`)
    expect(compactWidths.name.clientWidth).toBeGreaterThanOrEqual(90)
    if (compactWidths.linkLeft !== null) expect(compactWidths.nameRight).toBeLessThanOrEqual(compactWidths.linkLeft)
    const localRow = list.locator(':scope > .visual-asset').first()
    expect(Math.abs(await localRow.evaluate((element) => element.getBoundingClientRect().height) - await firstResult.evaluate((element) => element.getBoundingClientRect().height))).toBeLessThanOrEqual(1)
    await expect(firstResult.locator('xpath=..').locator('.online-template-link')).toHaveAttribute('aria-label', 'View source for Shared Cat')
    const imkgResult = online.locator('[data-template-source="imkg"][data-template-id="007"]')
    await expect(imkgResult.locator('xpath=..').locator('.online-template-link')).toHaveAttribute('aria-label', 'View source for IMKG Cat')
    await click(imkgResult.locator('xpath=..').locator('.online-template-link'))
    await hover(imkgResult)
    const imkgPreview = page.getByLabel('Preview of IMKG Cat')
    await expect(imkgPreview).toBeVisible()
    await expect.poll(() => imkgPreview.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)

    await hover(online.locator('[data-template-id="8"]'))
    const preview = page.getByLabel('Preview of Imgflip Cat')
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await click(search)
    await expect(page.locator('.online-template-preview')).toHaveCount(0)

    await click(imkgResult)
    const overlay = page.locator('.preview-stage .visual-overlay img')
    await expect(overlay).toHaveCount(1)
    await expect.poll(() => overlay.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await expect(page.locator('.inspector')).toContainText('IMKG Cat')
  } finally {
    await close(app)
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('previews and inserts an online Imgflip video', async () => {
  test.setTimeout(60_000)
  const fixture = createFixture()
  const videoFixture = { ...fixture, image: fixture.input }
  const { app, page } = await prepare(videoFixture, 'video')
  try {
    await click(page.getByRole('button', { name: 'Videos', exact: true }))
    await page.getByPlaceholder('Search videos').fill('cat')
    const online = page.locator('.online-templates')
    const result = online.locator('[data-template-source="imgflip"][data-template-id="42"]')
    await expect(result).toBeVisible()
    await hover(result)
    const onlinePreview = page.getByLabel('Preview of Online Video')
    await expect(onlinePreview).toBeVisible()
    const previewVideo = onlinePreview.locator('video')
    await expect.poll(() => previewVideo.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0)
    await expect.poll(() => previewVideo.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2)

    await click(result)
    const overlay = page.locator('.preview-stage .visual-overlay video')
    await expect(overlay).toHaveCount(1)
    await expect.poll(() => overlay.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0)
    await expect(page.locator('.inspector')).toContainText('Online Video')
  } finally {
    await close(app)
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('keeps successful provider results visible when Imgflip is offline', async () => {
  test.setTimeout(60_000)
  const fixture = createFixture()
  const { app, page } = await prepare(fixture, 'imgflip-offline')
  try {
    await click(page.getByRole('button', { name: 'Images', exact: true }))
    await page.getByPlaceholder('Search images').fill('cat')
    const online = page.locator('.online-templates')
    await expect(online.locator('[data-template-id="7"]')).toBeVisible()
    await expect(online.locator('[data-template-id="7"]')).toContainText('Shared Cat')
    await expect(online.getByRole('status')).toContainText('Imgflip unavailable.')
    await expect(online.getByRole('status')).toContainText('Imgflip offline')
  } finally {
    await close(app)
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('bounds a long online result list without collapsing local assets', async () => {
  test.setTimeout(60_000)
  const fixture = createFixture()
  const { app, page } = await prepare(fixture, 'many')
  try {
    await click(page.getByRole('button', { name: 'Images', exact: true }))
    await page.getByPlaceholder('Search images').fill('cat')
    const online = page.locator('.online-templates')
    const local = online.locator('.asset-list')
    await expect(online.locator('[data-template-id]')).toHaveCount(24)
    await expect(online.locator('.online-template-results')).toHaveCount(0)
    await expect(local.locator(':scope > button').first()).toBeVisible()
    await expect.poll(() => local.evaluate((element) => element.clientHeight)).toBeGreaterThan(0)

    const results = local
    await expect.poll(() => results.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    const last = online.locator('[data-template-id="30"]')
    await scroll(results, 10_000)
    await expect(last).toBeVisible()

    await hover(last)
    const preview = page.getByLabel('Preview of Online 30')
    await expect(preview).toBeVisible()
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    const previewBox = await preview.boundingBox()
    if (!previewBox) throw new Error('Online preview has no layout box')
    expect(previewBox.x).toBeGreaterThanOrEqual(0)
    expect(previewBox.y).toBeGreaterThanOrEqual(0)
    expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(viewport.width)
    expect(previewBox.y + previewBox.height).toBeLessThanOrEqual(viewport.height)
    await click(last)
    await expect(page.locator('.inspector')).toContainText('Shared Cat')
  } finally {
    await close(app)
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})
