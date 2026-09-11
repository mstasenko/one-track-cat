import { expect, test, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { click, dismissHardwareWarningIfNeeded, e2eEnvironment, main, seekTimeline, syntheticVideo } from './support'

type PreviewMode = 'success' | 'cancel' | 'error' | 'guard'

interface RestoredFacePreview {
  url: string
  start: number
  end: number
}

interface CapturedFaceBlur {
  id?: string
  sensitivity?: number
  detail?: string
  holdSeconds?: number
  strength?: number
  style?: string
  start?: number
  duration?: number
}

interface CapturedPreviewRequest {
  previewRange?: [number, number]
  faceBlurs?: CapturedFaceBlur[]
}

const applications: ElectronApplication[] = []
const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function launch(input?: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: input ? [main, input] : [main],
    env: e2eEnvironment({
      otc_CPU_ONLY: '1',
      otc_E2E_COMPACT: '1',
      otc_E2E_GPU_OFF: '1'
    })
  })
  applications.push(app)
  await dismissHardwareWarningIfNeeded(await app.firstWindow())
  return app
}

async function interceptFacePreview(app: ElectronApplication, mode: PreviewMode, resultUrl = ''): Promise<void> {
  await app.evaluate(({ ipcMain }, options) => {
    const { previewMode, previewUrl } = options
    const state = {
      requests: [] as unknown[],
      reject: undefined as ((reason?: unknown) => void) | undefined
    }
    type E2EState = typeof state
    ;(globalThis as typeof globalThis & { __otcFaceApply?: E2EState }).__otcFaceApply = state

    ipcMain.removeHandler('faces:pack-status')
    ipcMain.handle('faces:pack-status', () => ({ available: true, message: 'Test face pack available.' }))
    ipcMain.removeHandler('faces:preview')
    ipcMain.handle('faces:preview', async (event, request: unknown) => {
      state.requests.push(request)
      if (previewMode === 'success') return previewUrl
      if (previewMode === 'guard') throw new Error('Unexpected face preview during restore')
      event.sender.send('job:progress', {
        id: 'e2e-face-apply', kind: 'export', state: 'running', progress: 0,
        message: 'Rendering test face preview…'
      })
      if (previewMode === 'error') {
        await new Promise((resolve) => setTimeout(resolve, 100))
        throw new Error('Test face preview failed')
      }
      await new Promise<never>((_resolve, reject) => { state.reject = reject })
    })
    ipcMain.removeHandler('job:cancel')
    ipcMain.handle('job:cancel', (_event, id: unknown) => {
      if (id !== 'e2e-face-apply') return false
      state.reject?.(new Error('Job cancelled'))
      state.reject = undefined
      return true
    })
  }, { previewMode: mode, previewUrl: resultUrl })
}

async function interceptFaceRestore(app: ElectronApplication, result: RestoredFacePreview[]): Promise<void> {
  await app.evaluate(({ ipcMain }, preview) => {
    ipcMain.removeHandler('faces:restore')
    ipcMain.handle('faces:restore', () => preview)
  }, result)
}

async function capturedRequests(app: ElectronApplication): Promise<CapturedPreviewRequest[]> {
  return app.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __otcFaceApply?: { requests: unknown[] } }).__otcFaceApply
    return (state?.requests ?? []) as CapturedPreviewRequest[]
  })
}

async function clearCapturedRequests(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __otcFaceApply?: { requests: unknown[] } }).__otcFaceApply
    state?.requests.splice(0)
  })
}

async function authorizedMediaUrl(page: Page, path: string): Promise<string> {
  return page.evaluate((candidate) => window.otc.getPathUrl(candidate), path)
}

async function waitForVideoData(video: Locator): Promise<void> {
  await expect(video).toBeVisible()
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState), {
    timeout: 15_000
  }).toBeGreaterThanOrEqual(2)
}

async function installRenderedPreviewProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { loadedMetadata: 0 }
    document.addEventListener('loadedmetadata', (event) => {
      const target = event.target
      if (target instanceof HTMLVideoElement && target.classList.contains('preview-rendered-video')) {
        state.loadedMetadata += 1
      }
    }, true)
    ;(globalThis as typeof globalThis & {
      __otcRenderedProbe?: { loadedMetadata: number }
    }).__otcRenderedProbe = state
  })
}

async function renderedMetadataCount(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as typeof globalThis & {
    __otcRenderedProbe?: { loadedMetadata: number }
  }).__otcRenderedProbe?.loadedMetadata ?? 0)
}

async function playingPreviewVideoCount(page: Page): Promise<number> {
  return page.locator('.preview-stage video').evaluateAll((videos) => videos.filter((video) => !(video as HTMLVideoElement).paused).length)
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

async function applyEditedSettings(page: Page): Promise<void> {
  await page.getByRole('slider', { name: 'Sensitivity' }).fill('0.42')
  const smallFaces = page.getByRole('checkbox', { name: 'Small faces (slower)' })
  await expect(smallFaces).toBeChecked()
  await smallFaces.setChecked(true, { force: true })
  await page.getByRole('spinbutton', { name: 'Hold missed faces seconds' }).fill('0.55')
  await page.getByRole('slider', { name: 'Strength' }).fill('0.81')
  await page.getByRole('combobox', { name: 'Style' }).selectOption('mask')
  await click(page.getByRole('button', { name: 'Apply face blur', exact: true }))
}

test.afterEach(async () => {
  for (const app of applications.splice(0)) await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('Apply face blur adds the selected effect and previews fresh settings once', async () => {
  const directory = temporaryDirectory('otc-face-apply-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input)
  const page = await app.firstWindow()
  const resultUrl = await authorizedMediaUrl(page, input)
  await interceptFacePreview(app, 'success', resultUrl)
  await openSelectedFaceBlur(page)
  await expect(page.locator('.face-blur-menu').getByRole('button', { name: /preview/i })).toHaveCount(0)

  await installRenderedPreviewProbe(page)
  const playheadBeforeApply = await page.locator('.playhead').getAttribute('style')
  await applyEditedSettings(page)
  await expect.poll(async () => (await capturedRequests(app)).length).toBe(1)
  const requests = await capturedRequests(app)
  expect(requests).toHaveLength(1)
  const request = requests[0]
  expect(request?.previewRange?.[0]).toBeCloseTo(1.5, 1)
  expect(request?.previewRange?.[1]).toBeCloseTo(4.5, 1)
  expect(request?.faceBlurs).toHaveLength(1)
  expect(request?.faceBlurs?.[0]).toMatchObject({
    sensitivity: 0.42, detail: 'small', holdSeconds: 0.55, strength: 0.81, style: 'mask'
  })
  await expect(page.locator('.face-blur-range')).toHaveCount(1)
  const renderedVideo = page.locator('.preview-stage .preview-rendered-video')
  const sourceVideo = page.locator('.preview-stage .preview-source-video:not(.preview-rendered-video):not(.preview-transition-previous)')
  await waitForVideoData(renderedVideo)
  await expect(sourceVideo).toBeHidden()
  await expect(page.getByRole('dialog', { name: 'Rendered face-blur preview' })).toHaveCount(0)
  await expect(page.locator('.playhead')).toHaveAttribute('style', playheadBeforeApply ?? '')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
  await expect(renderedVideo).toHaveAttribute('src', resultUrl)
  await expect.poll(() => renderedVideo.evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true)
  const initialMetadataCount = await renderedMetadataCount(page)
  expect(initialMetadataCount).toBeGreaterThanOrEqual(1)
  const initialBox = await renderedVideo.boundingBox()
  if (!initialBox) throw new Error('Rendered preview is not laid out')

  const visualOverlayCount = await page.locator('.preview-stage .visual-overlay').count()
  const audioOverlayCount = await page.locator('.preview-stage audio').count()
  expect(await page.locator('.preview-stage video:visible').count()).toBe(1)

  await seekTimeline(page, 0.6)
  await expect(renderedVideo).toBeVisible()
  await expect(sourceVideo).toBeHidden()
  await expect.poll(() => renderedVideo.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeCloseTo(2.1, 1)
  await expect.poll(() => renderedMetadataCount(page)).toBe(initialMetadataCount)
  const scrubbedBox = await renderedVideo.boundingBox()
  if (!scrubbedBox) throw new Error('Rendered preview disappeared while scrubbing')
  expect(scrubbedBox.width).toBeCloseTo(initialBox.width, 3)
  expect(scrubbedBox.height).toBeCloseTo(initialBox.height, 3)
  expect(scrubbedBox.x).toBeCloseTo(initialBox.x, 3)
  expect(scrubbedBox.y).toBeCloseTo(initialBox.y, 3)

  await click(page.getByRole('button', { name: 'Play', exact: true }))
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect.poll(() => playingPreviewVideoCount(page)).toBe(1)
  await page.waitForTimeout(200)
  await click(page.getByRole('button', { name: 'Pause', exact: true }))
  await expect.poll(() => renderedMetadataCount(page)).toBe(initialMetadataCount)
  await expect.poll(() => playingPreviewVideoCount(page)).toBe(0)

  await seekTimeline(page, 0.1)
  await expect(sourceVideo).toBeVisible()
  await expect(renderedVideo).toBeHidden()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect.poll(() => playingPreviewVideoCount(page)).toBe(0)

  await seekTimeline(page, 0.6)
  await expect(renderedVideo).toBeVisible()
  await expect(sourceVideo).toBeHidden()
  await expect(renderedVideo).toHaveAttribute('src', resultUrl)
  await expect.poll(async () => (await capturedRequests(app)).length).toBe(1)
  await expect.poll(() => renderedVideo.evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true)
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect(page.locator('.preview-stage .visual-overlay')).toHaveCount(visualOverlayCount)
  await expect(page.locator('.preview-stage audio')).toHaveCount(audioOverlayCount)
})

test('restores an applied face preview after a normal-close relaunch without rendering again', async () => {
  const directory = temporaryDirectory('otc-face-restore-')
  const input = syntheticVideo(directory, true)
  const first = await launch(input)
  const firstPage = await first.firstWindow()
  const resultUrl = await authorizedMediaUrl(firstPage, input)
  await interceptFacePreview(first, 'success', resultUrl)
  await openSelectedFaceBlur(firstPage)
  await click(firstPage.getByRole('button', { name: 'Apply face blur', exact: true }))
  await expect.poll(async () => (await capturedRequests(first)).length).toBe(1)
  await expect(firstPage.locator('.face-blur-range')).toHaveCount(1)
  await waitForVideoData(firstPage.locator('.preview-rendered-video'))

  await first.close()

  const restored = await launch()
  const restoredPage = await restored.firstWindow()
  await interceptFaceRestore(restored, [{ url: resultUrl, start: 1.5, end: 4.5 }])
  await interceptFacePreview(restored, 'guard')
  await restoredPage.reload()
  await dismissHardwareWarningIfNeeded(restoredPage)
  await expect(restoredPage.locator('.app[data-initialized="true"]')).toBeVisible()
  await expect(restoredPage.getByText('black.mp4', { exact: true })).toBeVisible({ timeout: 15_000 })
  expect(restored.windows()).toHaveLength(1)
  await expect(restoredPage.locator('.face-blur-range')).toHaveCount(1)

  const renderedVideo = restoredPage.locator('.preview-stage .preview-rendered-video')
  const sourceVideo = restoredPage.locator('.preview-stage .preview-source-video:not(.preview-rendered-video):not(.preview-transition-previous)')
  await waitForVideoData(renderedVideo)
  await expect(renderedVideo).toHaveAttribute('src', resultUrl)
  await expect.poll(() => renderedVideo.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeCloseTo(1.5, 1)
  await expect.poll(() => renderedVideo.evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true)
  await expect(restoredPage.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect(restoredPage.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
  await expect.poll(() => playingPreviewVideoCount(restoredPage)).toBe(0)
  await expect.poll(async () => (await capturedRequests(restored)).length).toBe(0)

  await seekTimeline(restoredPage, 0.1)
  await expect(sourceVideo).toBeVisible()
  await expect(renderedVideo).toBeHidden()
  await expect.poll(async () => (await capturedRequests(restored)).length).toBe(0)

  await seekTimeline(restoredPage, 0.6)
  await expect(renderedVideo).toBeVisible()
  await expect(sourceVideo).toBeHidden()
  await expect(renderedVideo).toHaveAttribute('src', resultUrl)
  await expect.poll(() => renderedVideo.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeCloseTo(2.1, 1)
  await expect.poll(async () => (await capturedRequests(restored)).length).toBe(0)
})

test('clicking a face marker preserves its range and keeps reapply paused', async () => {
  const directory = temporaryDirectory('otc-face-marker-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input)
  const page = await app.firstWindow()
  const resultUrl = await authorizedMediaUrl(page, input)
  await interceptFacePreview(app, 'success', resultUrl)
  await openSelectedFaceBlur(page)
  await click(page.getByRole('button', { name: 'Apply face blur', exact: true }))
  await expect.poll(async () => (await capturedRequests(app)).length).toBe(1)
  const initialRequest = (await capturedRequests(app))[0]
  const initialEffect = initialRequest?.faceBlurs?.[0]
  await expect(page.locator('.face-blur-range')).toHaveCount(1)
  await waitForVideoData(page.locator('.preview-rendered-video'))
  await expect(page.getByRole('dialog', { name: 'Rendered face-blur preview' })).toHaveCount(0)

  await click(page.locator('.face-blur-menu').getByRole('button', { name: '← Back', exact: true }))
  await expect(page.locator('.face-blur-menu')).toBeHidden()
  await seekTimeline(page, 0.9)
  const playheadBeforeMarker = await page.locator('.playhead').getAttribute('style')
  await click(page.locator('.face-blur-range'))
  await expect(page.locator('.face-blur-menu')).toBeVisible()
  await expect(page.locator('.playhead')).toHaveAttribute('style', playheadBeforeMarker ?? '')

  await clearCapturedRequests(app)
  await click(page.getByRole('button', { name: 'Apply face blur', exact: true }))
  await expect.poll(async () => (await capturedRequests(app)).length).toBe(1)
  const requests = await capturedRequests(app)
  expect(requests).toHaveLength(1)
  const request = requests[0]
  expect(request?.previewRange?.[0]).toBeCloseTo(1.5, 1)
  expect(request?.previewRange?.[1]).toBeCloseTo(4.5, 1)
  expect(request?.faceBlurs).toHaveLength(1)
  expect(request?.faceBlurs?.[0]?.id).toBe(initialEffect?.id)
  expect(request?.faceBlurs?.[0]?.sensitivity).toBe(initialEffect?.sensitivity)
  expect(request?.faceBlurs?.[0]?.start).toBeCloseTo(1.5, 1)
  expect(request?.faceBlurs?.[0]?.duration).toBeCloseTo(3, 1)
  await expect(page.locator('.face-blur-range')).toHaveCount(1)
  await expect(page.locator('.playhead')).toHaveAttribute('style', playheadBeforeMarker ?? '')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
  await expect(page.locator('.preview-source-video:not(.preview-rendered-video):not(.preview-transition-previous)')).toBeVisible()
  await expect(page.locator('.preview-rendered-video')).toBeHidden()
})

test('cancelling a face preview keeps its timeline effect editable', async () => {
  const directory = temporaryDirectory('otc-face-apply-cancel-')
  const app = await launch(syntheticVideo(directory, true))
  const page = await app.firstWindow()
  await interceptFacePreview(app, 'cancel')
  await openSelectedFaceBlur(page)
  await click(page.getByRole('button', { name: 'Apply face blur', exact: true }))
  await expect(page.locator('.face-blur-range')).toHaveCount(1)
  const dialog = page.getByRole('dialog', { name: 'Applying face blur' })
  await expect(dialog).toBeVisible()
  await click(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  await expect(dialog).toBeHidden()
  await expect(page.locator('.face-blur-range')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Apply face blur', exact: true })).toBeEnabled()
  await expect(page.locator('.error-banner')).toHaveCount(0)
})

test('a face preview error keeps its timeline effect editable', async () => {
  const directory = temporaryDirectory('otc-face-apply-error-')
  const app = await launch(syntheticVideo(directory, true))
  const page = await app.firstWindow()
  await interceptFacePreview(app, 'error')
  await openSelectedFaceBlur(page)
  await click(page.getByRole('button', { name: 'Apply face blur', exact: true }))
  await expect(page.locator('.face-blur-range')).toHaveCount(1)
  await expect(page.locator('.error-banner')).toContainText('Test face preview failed', { timeout: 5000 })
  await expect(page.getByRole('dialog', { name: 'Applying face blur' })).toBeHidden()
  await expect(page.locator('.face-blur-range')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Apply face blur', exact: true })).toBeEnabled()
})
