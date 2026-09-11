import { expect, test, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { click, dismissHardwareWarningIfNeeded, e2eEnvironment, main, seekTimeline, syntheticVideo } from './support'

interface RuntimeFixture {
  cwd: string
  workerLog: string
}

const repositoryRoot = resolve(import.meta.dirname, '../..')

function runtimeFixture(): RuntimeFixture {
  const cwd = mkdtempSync(join(tmpdir(), 'otc-face-cache-e2e-'))
  const pack = join(cwd, 'dist', 'face-pack')
  mkdirSync(pack, { recursive: true })
  for (const directory of ['config', 'data', 'cache']) mkdirSync(join(cwd, directory))
  symlinkSync(join(repositoryRoot, 'node_modules'), join(cwd, 'node_modules'), 'dir')

  const workerLog = join(pack, 'worker-starts.log')
  writeFileSync(join(pack, 'manifest.json'), '{"format":1}\n')
  writeFileSync(join(pack, 'model.xml'), 'test model\n')
  writeFileSync(join(pack, 'model.bin'), 'test weights\n')
  writeFileSync(join(pack, 'otc-face-blur.bin'), 'test worker\n')
  writeFileSync(join(pack, 'otc-face-blur'), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
appendFileSync(join(__dirname, 'worker-starts.log'), 'start\\n')
process.stderr.write('otc-face-blur: starting\\n')
process.stderr.write('otc-face-blur: device=CPU\\n')
process.stdin.pipe(process.stdout)
`)
  chmodSync(join(pack, 'otc-face-blur'), 0o755)
  return { cwd, workerLog }
}

async function launch(fixture: RuntimeFixture, input?: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: input ? [main, input] : [main],
    cwd: fixture.cwd,
    env: e2eEnvironment({
      otc_CPU_ONLY: '1',
      otc_E2E_COMPACT: '1',
      otc_E2E_GPU_OFF: '1',
      XDG_CONFIG_HOME: join(fixture.cwd, 'config'),
      XDG_DATA_HOME: join(fixture.cwd, 'data'),
      XDG_CACHE_HOME: join(fixture.cwd, 'cache')
    })
  })
  await dismissHardwareWarningIfNeeded(await app.firstWindow())
  return app
}

async function openSelectedFaceBlur(page: Page): Promise<void> {
  await expect(page.getByText('black.mp4', { exact: true })).toBeVisible({ timeout: 15_000 })
  await seekTimeline(page, 0.25)
  await click(page.getByRole('button', { name: 'Mark', exact: true }))
  await seekTimeline(page, 0.75)
  await click(page.getByRole('button', { name: 'Mark', exact: true }))
  await seekTimeline(page, 0.5)
  await click(page.getByRole('button', { name: 'Blur faces', exact: true }))
  await expect(page.locator('.face-blur-menu')).toBeVisible()
  await expect(page.locator('.face-blur-scope')).toContainText('selected range')
}

async function waitForVideoData(video: Locator): Promise<void> {
  await expect(video).toBeVisible()
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState), {
    timeout: 30_000
  }).toBeGreaterThanOrEqual(2)
}

function mediaPath(url: string): string {
  return url.split('?')[0] ?? url
}

async function waitForRenderedUrl(page: Page, expectedPath?: string): Promise<string> {
  const video = page.locator('.preview-stage .preview-rendered-video')
  const currentPath = async (): Promise<string> => {
    if (await video.count() !== 1) return ''
    return mediaPath((await video.getAttribute('src')) ?? '')
  }
  if (expectedPath) await expect.poll(currentPath, { timeout: 30_000 }).toBe(expectedPath)
  else await expect.poll(currentPath, { timeout: 30_000 }).not.toBe('')
  await waitForVideoData(video)
  const source = await video.getAttribute('src')
  if (!source) throw new Error('Rendered face preview has no source URL')
  return source
}

function workerStarts(path: string): number {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

test('restores a real cached face preview across a normal-close restart without starting the worker again', async () => {
  test.setTimeout(120_000)
  const fixture = runtimeFixture()
  const input = syntheticVideo(fixture.cwd, true)
  let first: ElectronApplication | undefined
  let restored: ElectronApplication | undefined
  try {
    first = await launch(fixture, input)
    expect(await first.evaluate(({ app }) => ({
      name: app.getName(),
      userData: app.getPath('userData')
    }))).toEqual({
      name: 'OneTrackCat',
      userData: join(fixture.cwd, 'config', 'OneTrackCat')
    })
    const firstPage = await first.firstWindow()
    await openSelectedFaceBlur(firstPage)
    await click(firstPage.getByRole('button', { name: 'Apply face blur', exact: true }))
    const firstRendered = firstPage.locator('.preview-stage .preview-rendered-video')
    await waitForVideoData(firstRendered)
    const firstSource = await firstRendered.getAttribute('src')
    if (!firstSource) throw new Error('First rendered face preview has no source URL')
    expect(firstSource).toMatch(/^media:\/\/local\//)
    await expect.poll(() => firstRendered.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeCloseTo(1.5, 1)
    expect(workerStarts(fixture.workerLog)).toBe(1)
    await expect(firstPage.locator('.face-blur-range')).toHaveCount(1)

    await first.close()
    first = undefined

    restored = await launch(fixture)
    const restoredPage = await restored.firstWindow()
    await expect(restoredPage.getByText('black.mp4', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(restoredPage.locator('.face-blur-range')).toHaveCount(1)
    expect(restored.windows()).toHaveLength(1)

    const restoredRendered = restoredPage.locator('.preview-stage .preview-rendered-video')
    const restoredSource = restoredPage.locator('.preview-stage .preview-source-video:not(.preview-rendered-video):not(.preview-transition-previous)')
    await waitForVideoData(restoredRendered)
    const restoredSourceUrl = await restoredRendered.getAttribute('src')
    if (!restoredSourceUrl) throw new Error('Restored face preview has no source URL')
    expect(restoredSourceUrl.split('?')[0]).toBe(firstSource.split('?')[0])
    await expect.poll(() => restoredRendered.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeCloseTo(1.5, 1)
    await expect.poll(() => restoredRendered.evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true)
    await expect(restoredPage.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
    await expect(restoredPage.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
    expect(workerStarts(fixture.workerLog)).toBe(1)

    await seekTimeline(restoredPage, 0.1)
    await expect(restoredSource).toBeVisible()
    await expect(restoredRendered).toBeHidden()
    await seekTimeline(restoredPage, 0.6)
    await expect(restoredRendered).toBeVisible()
    await expect(restoredSource).toBeHidden()
    await expect.poll(() => restoredRendered.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeCloseTo(2.1, 1)
    expect(workerStarts(fixture.workerLog)).toBe(1)
  } finally {
    await restored?.close()
    await first?.close()
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
})

test('keeps two disjoint face previews through a second apply and restart', async () => {
  test.setTimeout(120_000)
  const fixture = runtimeFixture()
  const input = syntheticVideo(fixture.cwd, true)
  let first: ElectronApplication | undefined
  let restored: ElectronApplication | undefined
  try {
    first = await launch(fixture, input)
    const firstPage = await first.firstWindow()
    await openSelectedFaceBlur(firstPage)
    await click(firstPage.getByRole('button', { name: 'Apply face blur', exact: true }))
    const firstSource = await waitForRenderedUrl(firstPage)
    const firstPath = mediaPath(firstSource)
    expect(firstPath).toMatch(/^media:\/\/local\//)
    await expect.poll(() => workerStarts(fixture.workerLog)).toBe(1)
    await expect(firstPage.locator('.face-blur-range')).toHaveCount(1)

    await seekTimeline(firstPage, 0.9)
    await click(firstPage.locator('.face-blur-menu').getByRole('button', { name: '← Back', exact: true }))
    await click(firstPage.getByRole('button', { name: 'Blur faces', exact: true }))
    await expect(firstPage.locator('.face-blur-scope')).toContainText('selected range')
    await click(firstPage.getByRole('button', { name: 'Apply face blur', exact: true }))
    const secondSource = await waitForRenderedUrl(firstPage)
    const secondPath = mediaPath(secondSource)
    expect(secondPath).not.toBe(firstPath)
    await expect.poll(() => workerStarts(fixture.workerLog)).toBe(2)
    await expect(firstPage.locator('.face-blur-range')).toHaveCount(2)

    await seekTimeline(firstPage, 0.5)
    await waitForRenderedUrl(firstPage, firstPath)
    await expect.poll(() => workerStarts(fixture.workerLog)).toBe(2)

    await first.close()
    first = undefined

    restored = await launch(fixture)
    const restoredPage = await restored.firstWindow()
    await expect(restoredPage.getByText('black.mp4', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(restoredPage.locator('.face-blur-range')).toHaveCount(2)
    expect(restored.windows()).toHaveLength(1)
    await expect.poll(() => workerStarts(fixture.workerLog)).toBe(2)

    await seekTimeline(restoredPage, 0.5)
    await waitForRenderedUrl(restoredPage, firstPath)
    await seekTimeline(restoredPage, 0.9)
    await waitForRenderedUrl(restoredPage, secondPath)
    await expect.poll(() => workerStarts(fixture.workerLog)).toBe(2)
  } finally {
    await restored?.close()
    await first?.close()
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
})
