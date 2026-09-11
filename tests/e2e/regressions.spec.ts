import { expect, test, _electron as electron } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { click, completeVideoPicker, dismissHardwareWarningIfNeeded, e2eEnvironment, ffmpeg, ffprobe, hover, main, moveMouse, seekTimeline, syntheticVideo, wheel } from './support'
const applications: ElectronApplication[] = []
const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function launch(
  input: string,
  output?: string,
  overrides: NodeJS.ProcessEnv = {}
): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [main, input],
    env: e2eEnvironment({ ...(output ? { otc_E2E_OUTPUT: output } : {}), ...overrides })
  })
  applications.push(app)
  await dismissHardwareWarningIfNeeded(await app.firstWindow())
  return app
}

test.afterEach(async () => {
  for (const app of applications.splice(0)) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function probe(path: string): { format: { duration: string }; streams: { codec_type: string; width?: number; height?: number }[] } {
  const result: unknown = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path
  ], { encoding: 'utf8' }))
  return result as { format: { duration: string }; streams: { codec_type: string; width?: number; height?: number }[] }
}

test('plays from the point selected on the timeline', async () => {
  const directory = temporaryDirectory('otc-seek-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input)
  const window = await app.firstWindow()
  const preview = window.locator('.camera-layer > video:not(.preview-transition-previous)')
  await expect.poll(() => preview.evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
  await seekTimeline(window, 0.5)
  await click(window.getByRole('button', { name: 'Mark', exact: true }))
  await click(window.getByRole('button', { name: 'Play', exact: true }))
  await expect.poll(() => preview.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(3)
})

test('moves five seconds with arrow keys while paused or playing', async () => {
  const directory = temporaryDirectory('otc-arrows-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input)
  const window = await app.firstWindow()
  const preview = window.locator('.camera-layer > video:not(.preview-transition-previous)')
  await expect.poll(() => preview.evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
  await seekTimeline(window, 0)
  await window.keyboard.press('ArrowRight')
  await expect.poll(() => preview.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeCloseTo(5, 0)
  await click(window.getByRole('button', { name: 'Play', exact: true }))
  await window.keyboard.press('ArrowLeft')
  await expect(window.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect.poll(() => preview.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeLessThan(2)
})

test('keeps timeline and zoom controls on the transport row', async () => {
  const directory = temporaryDirectory('otc-zoom-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input)
  const window = await app.firstWindow()
  const timeline = window.locator('.timeline')
  const transport = window.locator('.transport')
  await expect(transport.getByText('Timeline', { exact: true })).toBeVisible()
  await expect(window.locator('.timeline-toolbar')).toHaveCount(0)
  expect(await transport.locator(':scope > *').evaluateAll((elements) => elements.map((element) => (
    element.getAttribute('aria-label') ?? element.textContent.trim()
  )))).toEqual(['Previous frame', 'Play', 'Next frame', 'Mark', 'Clear Marks', 'Remove Marked', 'Undo', 'Redo', 'Timeline', '00:00.00 / 00:06.00', 'Zoom out', 'Zoom in'])
  const playBox = await window.getByRole('button', { name: 'Play', exact: true }).boundingBox()
  const markBox = await window.getByRole('button', { name: 'Mark', exact: true }).boundingBox()
  expect(playBox?.width ?? 0).toBeGreaterThan(markBox?.width ?? 0)
  await click(window.getByRole('button', { name: 'Zoom in' }))
  await expect.poll(() => timeline.evaluate((element) => (element as HTMLElement).style.width)).toBe('125%')
  await wheel(window.locator('.timeline-scroll'), -100)
  await expect.poll(() => timeline.evaluate((element) => (element as HTMLElement).style.width)).toBe('150%')
  await click(window.getByRole('button', { name: 'Zoom out' }))
  await expect.poll(() => timeline.evaluate((element) => (element as HTMLElement).style.width)).toBe('125%')
})

test('shows the source frame under the timeline pointer', async () => {
  const directory = temporaryDirectory('otc-hover-preview-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input)
  const window = await app.firstWindow()
  const timeline = window.locator('.timeline')
  const box = await timeline.boundingBox()
  if (!box) throw new Error('Timeline is not visible')

  await hover(timeline, { position: { x: box.width / 2, y: 20 } })
  const preview = window.locator('.timeline-hover-preview')
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('00:03.00')
  await expect.poll(() => preview.locator('video').evaluate((video) => (video as HTMLVideoElement).currentTime))
    .toBeGreaterThan(2.5)

  await hover(window.locator('.transport'))
  await expect(preview).toBeHidden()
})

test('highlights and cuts the chosen side of one mark without a popup', async () => {
  const directory = temporaryDirectory('otc-one-point-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input)
  const window = await app.firstWindow()
  await seekTimeline(window, 0.4)
  await click(window.getByRole('button', { name: 'Mark', exact: true }))
  const selection = window.locator('.timeline-selection')
  await expect(selection).toBeVisible()
  await click(window.getByRole('button', { name: 'Undo', exact: true }))
  await expect(selection).toHaveCount(0)
  await click(window.getByRole('button', { name: 'Redo', exact: true }))
  await expect(selection).toBeVisible()
  await expect.poll(() => selection.evaluate((element) => parseFloat((element as HTMLElement).style.left))).toBe(0)
  await seekTimeline(window, 0.6)
  await expect.poll(() => selection.evaluate((element) => parseFloat((element as HTMLElement).style.left))).toBeCloseTo(40, 1)
  await seekTimeline(window, 0.2)
  await expect.poll(() => selection.evaluate((element) => parseFloat((element as HTMLElement).style.left))).toBe(0)
  await expect(window.getByRole('dialog')).toHaveCount(0)
  await click(window.getByRole('button', { name: 'Remove Marked', exact: true }))
  await expect(selection).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'Mark', exact: true })).toBeVisible()
})

test('supports more than two marks and selects the partition at the playhead', async () => {
  const directory = temporaryDirectory('otc-two-points-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input)
  const window = await app.firstWindow()
  await seekTimeline(window, 0.25)
  await click(window.getByRole('button', { name: 'Mark', exact: true }))
  await seekTimeline(window, 0.5)
  await click(window.getByRole('button', { name: 'Mark', exact: true }))
  await seekTimeline(window, 0.75)
  await click(window.getByRole('button', { name: 'Mark', exact: true }))
  await expect(window.locator('.timeline-mark')).toHaveCount(3)
  await expect(window.getByRole('button', { name: 'Mark', exact: true })).toHaveText('Mark')
  await seekTimeline(window, 0.625)
  const selection = window.locator('.timeline-selection')
  await expect.poll(() => selection.evaluate((element) => ({
    left: parseFloat((element as HTMLElement).style.left),
    width: parseFloat((element as HTMLElement).style.width)
  }))).toEqual({ left: 50, width: 25 })
  await seekTimeline(window, 0.9)
  await expect.poll(() => selection.evaluate((element) => ({
    left: parseFloat((element as HTMLElement).style.left),
    width: parseFloat((element as HTMLElement).style.width)
  }))).toEqual({ left: 75, width: 25 })
})

test('keeps the preview healthy after repeated editing operations', async () => {
  const directory = temporaryDirectory('otc-edit-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input)
  const window = await app.firstWindow()
  const preview = window.locator('.camera-layer > video:not(.preview-transition-previous)')
  await expect.poll(() => preview.evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
  await seekTimeline(window, 0.2)
  await click(window.getByRole('button', { name: 'Mark', exact: true }))
  await seekTimeline(window, 0.7)
  await click(window.getByRole('button', { name: 'Mark', exact: true }))
  await expect(window.locator('.timeline-selection')).toBeVisible()
  await click(window.getByRole('button', { name: 'Remove Marked', exact: true }))
  await click(window.getByRole('button', { name: 'Text', exact: true }))
  await click(window.getByRole('button', { name: 'Undo', exact: true }))
  await click(window.getByRole('button', { name: 'Redo', exact: true }))
  await click(window.getByRole('button', { name: 'Play', exact: true }))
  await expect(window.locator('.preview-error')).toBeHidden()
  await expect.poll(() => preview.evaluate((video) => (video as HTMLVideoElement).error?.code ?? 0)).toBe(0)
  await expect.poll(() => window.locator('.waveform path').evaluateAll((paths) => (
    paths.length > 0 && paths.every((path) => (path.getAttribute('d') ?? '').length > 0)
  ))).toBe(true)
})

test('renders added text into the exported video', async () => {
  const directory = temporaryDirectory('otc-text-')
  const input = syntheticVideo(directory, true)
  const output = join(directory, 'output.mp4')
  const app = await launch(input, output)
  const window = await app.firstWindow()
  await expect(window.getByText('black.mp4', { exact: true })).toBeVisible()
  await click(window.getByRole('button', { name: 'Text', exact: true }))
  const textBox = window.getByRole('textbox', { name: 'Text' })
  await expect(textBox).toBeFocused()
  await textBox.fill('VISIBLE TEXT')
  await expect(window.locator('.preview-text')).toHaveCSS('font-weight', '700')
  await window.evaluate(() => {
    const root = document.documentElement
    root.dataset.sawNan = 'false'
    new MutationObserver(() => {
      if (document.body.innerText.includes('NaN')) root.dataset.sawNan = 'true'
    }).observe(document.body, { childList: true, characterData: true, subtree: true })
  })
  await click(window.getByRole('button', { name: 'Export', exact: true }))
  const exportDialog = window.getByRole('dialog', { name: 'Exporting video' })
  await expect(exportDialog).toBeVisible()
  await expect(exportDialog.getByRole('progressbar')).toBeVisible()
  await expect(exportDialog.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 30_000 })
  await expect(exportDialog).toBeHidden()
  expect(await window.evaluate(() => document.documentElement.dataset.sawNan)).toBe('false')
  const frame = execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', output,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ])
  expect(frame.some((value) => value > 100)).toBe(true)
})

test('renders SVG library images into the exported video', async () => {
  const directory = temporaryDirectory('otc-svg-')
  const input = syntheticVideo(directory, true)
  const output = join(directory, 'output.mp4')
  const app = await launch(input, output)
  const window = await app.firstWindow()
  await expect(window.getByText('black.mp4', { exact: true })).toBeVisible()
  await click(window.getByRole('button', { name: 'Images', exact: true }))
  await click(window.getByRole('button', { name: 'Awesome Face', exact: true }))
  await click(window.getByRole('button', { name: 'Export', exact: true }))
  await expect(window.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 30_000 })
  await expect.poll(() => existsSync(output), { timeout: 30_000 }).toBe(true)
  const frame = execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', output,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ])
  expect(frame.some((value) => value > 150)).toBe(true)
})

test('exports WebM video audio together with an OGG effect', async () => {
  const directory = temporaryDirectory('media-export-')
  const input = syntheticVideo(directory, true)
  const output = join(directory, 'output.mp4')
  const app = await launch(input, output)
  const window = await app.firstWindow()
  await click(window.getByRole('button', { name: 'Videos', exact: true }))
  await click(window.getByRole('button', { name: 'Scary Maze Reaction', exact: true }))
  // Native checkbox actionability is flaky in headless GNOME; use the suite's
  // headless-safe click helper, just like the other controls here.
  await click(window.getByRole('checkbox', { name: 'Include audio' }))
  await click(window.getByRole('button', { name: '← Back' }))
  await click(window.getByRole('button', { name: '← Back' }))
  await click(window.getByRole('button', { name: 'Audio', exact: true }))
  await click(window.getByRole('button', { name: 'Wilhelm Scream', exact: true }))
  await click(window.getByRole('button', { name: 'Export', exact: true }))
  await expect(window.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 30_000 })
  await expect.poll(() => existsSync(output), { timeout: 30_000 }).toBe(true)
  expect(() => execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', output,
    '-map', '0:v:0', '-map', '0:a:0', '-t', '0.2', '-f', 'null', '-'
  ])).not.toThrow()
})

test('prepares, restores, previews, and exports an external GIF', async () => {
  const directory = temporaryDirectory('otc-gif-')
  const input = syntheticVideo(directory, true)
  const gif = join(directory, 'animated.gif')
  const output = join(directory, 'output.mp4')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=1', gif
  ])
  const app = await launch(input, output, { otc_E2E_MEDIA: gif })
  const window = await app.firstWindow()
  await click(window.getByRole('button', { name: 'New', exact: true }))
  await expect(window.getByRole('button', { name: 'animated', exact: true })).toBeVisible({ timeout: 15_000 })
  const gifPreview = window.locator('.visual-overlay video')
  await expect.poll(() => gifPreview.evaluate((video) => (video as HTMLVideoElement).readyState), {
    timeout: 15_000
  }).toBeGreaterThan(0)
  await app.close()

  const restored = await electron.launch({
    args: [main],
    env: e2eEnvironment({ otc_E2E_OUTPUT: output })
  })
  applications.push(restored)
  const restoredWindow = await restored.firstWindow()
  await dismissHardwareWarningIfNeeded(restoredWindow)
  const restoredGifPreview = restoredWindow.locator('.visual-overlay video')
  await expect.poll(() => restoredGifPreview.evaluate((video) => (video as HTMLVideoElement).readyState), {
    timeout: 15_000
  }).toBeGreaterThan(0)
  await click(restoredWindow.getByRole('button', { name: 'Export', exact: true }))
  await expect(restoredWindow.getByRole('dialog', { name: 'Exporting video' })).toBeVisible()
  await expect(restoredWindow.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 30_000 })
  await expect.poll(() => existsSync(output), { timeout: 30_000 }).toBe(true)
})

test('blocks editing and removes partial output when export is cancelled', async () => {
  const directory = temporaryDirectory('otc-cancel-')
  const input = join(directory, 'long.mp4')
  const output = join(directory, 'cancelled.mp4')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', input
  ])
  const app = await launch(input, output)
  const window = await app.firstWindow()
  await expect(window.getByText('long.mp4', { exact: true })).toBeVisible()
  await click(window.getByRole('button', { name: 'Text', exact: true }))
  await click(window.getByRole('button', { name: 'Export', exact: true }))
  const dialog = window.getByRole('dialog', { name: 'Exporting video' })
  await expect(dialog).toBeVisible()
  const cancel = dialog.getByRole('button', { name: 'Cancel' })
  await expect(cancel).toBeEnabled({ timeout: 10_000 })
  await click(cancel)
  await expect(dialog).toBeHidden({ timeout: 10_000 })
  expect(existsSync(output)).toBe(false)
  await expect(window.getByText('OneTrackCat could not export this video. Check the destination and try again.')).toHaveCount(0)
})

test('ripple-inserts and exports a second main-timeline video', async () => {
  test.setTimeout(60_000)
  const directory = temporaryDirectory('otc-insert-')
  const first = join(directory, 'first.mp4')
  const second = join(directory, 'second.mp4')
  const output = join(directory, 'combined.mp4')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', first
  ])
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=red:size=180x320:rate=30:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', second
  ])
  const app = await launch(first, output, { otc_E2E_VIDEO: second })
  const window = await app.firstWindow()
  await seekTimeline(window, 0.5)
  await click(window.getByRole('button', { name: 'Video', exact: true }))
  await window.getByLabel('Into inserted video').selectOption('dissolve')
  await window.getByLabel('Back to timeline').selectOption('circleopen')
  await window.getByLabel('Transition duration').selectOption('1')
  await click(window.getByRole('button', { name: 'Select video', exact: true }))
  await completeVideoPicker(window)
  await expect(window.locator('.source-segment')).toHaveCount(3)
  await expect(window.locator('.source-segment').nth(1)).toHaveAttribute('data-transition', 'dissolve')
  await expect(window.locator('.source-segment').nth(2)).toHaveAttribute('data-transition', 'circleopen')
  await expect(window.locator('.source-segment').nth(1)).toHaveAttribute('title', /second\.mp4/)
  await expect.poll(() => window.locator('.playhead').evaluate((element) => parseFloat((element as HTMLElement).style.left))).toBeCloseTo(50, 1)
  // Land just inside the fade; exact boundary clicks can round to the preceding frame.
  await seekTimeline(window, 0.27)
  await expect(window.locator('.preview-source-video[data-transition="dissolve"]')).toBeVisible()
  await expect(window.getByRole('region', { name: 'Video preview' }).getByLabel('Outgoing transition video')).toBeVisible()

  const timeline = window.locator('.timeline')
  const timelineBox = await timeline.boundingBox()
  if (!timelineBox) throw new Error('Timeline is not visible')
  await hover(timeline, { position: { x: timelineBox.width * 0.30, y: 20 } })
  const hoverFrame = window.locator('.timeline-hover-frame')
  await expect(hoverFrame.locator('video')).toHaveCount(2)
  await expect(hoverFrame.locator('video[data-transition="dissolve"]')).toBeVisible()
  await hover(window.locator('.transport'))

  const transitionedVideo = window.locator('.preview-source-video:not(.preview-transition-previous)')
  await click(window.getByRole('button', { name: 'Play', exact: true }))
  const renderedOpacities = new Set<string>()
  await expect.poll(async () => {
    renderedOpacities.add(await transitionedVideo.evaluate((video) => (video as HTMLVideoElement).style.opacity))
    return renderedOpacities.size
  }, { intervals: [20], timeout: 5_000 }).toBeGreaterThan(3)
  await click(window.getByRole('button', { name: 'Pause', exact: true }))
  await click(window.getByRole('button', { name: 'Export', exact: true }))
  await expect(window.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 30_000 })
  await expect.poll(() => existsSync(output), { timeout: 30_000 }).toBe(true)
  const result = probe(output)
  expect(Number(result.format.duration)).toBeCloseTo(2, 1)
  expect(result.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({ width: 320, height: 180 })
  expect(result.streams.some((stream) => stream.codec_type === 'audio')).toBe(true)
})

test('fills a vertical Short with a full-frame video overlay in preview and export', async () => {
  // Headless Wayland pointer round trips consume time before export.
  test.setTimeout(90_000)
  const directory = temporaryDirectory('otc-short-')
  const input = syntheticVideo(directory, true)
  const output = join(directory, 'short.mp4')
  const overlay = join(directory, 'white.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=white:size=320x180:rate=24:duration=6', '-c:v', 'libx264', '-threads', '1', overlay])
  const app = await launch(input, output, { otc_E2E_VIDEO: input, otc_E2E_MEDIA: overlay })
  const window = await app.firstWindow()
  await click(window.getByRole('button', { name: 'Open Short', exact: true }))
  await completeVideoPicker(window)
  await expect(window.locator('.preview-stage')).toHaveCSS('aspect-ratio', '1080 / 1920')
  await click(window.getByRole('button', { name: 'New', exact: true }))
  await expect(window.locator('.visual-overlay video')).toHaveCSS('object-fit', 'contain')
  const stage = await window.locator('.preview-stage').boundingBox()
  const item = await window.locator('.visual-overlay').boundingBox()
  if (!stage || !item) throw new Error('Overlay is not visible')
  await moveMouse(window, item.x + 5, item.y + 5)
  await window.mouse.down()
  await moveMouse(window, stage.x + 5, stage.y + 5)
  await window.mouse.up()
  const handle = await window.getByRole('button', { name: 'Resize overlay' }).boundingBox()
  if (!handle) throw new Error('Resize handle is not visible')
  await moveMouse(window, handle.x + handle.width / 2, handle.y + handle.height / 2)
  await window.mouse.down()
  await moveMouse(window, stage.x + stage.width + 10, stage.y + stage.height + 10)
  await window.mouse.up()
  await expect(window.locator('.visual-overlay video')).toHaveCSS('object-fit', 'cover')
  const timeline = window.locator('.timeline')
  const box = await timeline.boundingBox()
  if (!box) throw new Error('Timeline is not visible')
  await hover(timeline, { position: { x: box.width * 0.1, y: 20 } })
  await expect(window.locator('.timeline-hover-overlay video')).toHaveCSS('object-fit', 'cover')
  await click(window.getByRole('button', { name: 'Export', exact: true }))
  await expect(window.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 30_000 })
  await expect.poll(() => existsSync(output), { timeout: 30_000 }).toBe(true)
  expect(probe(output).streams.find((stream) => stream.codec_type === 'video')).toMatchObject({ width: 1080, height: 1920 })
  for (const y of [10, 1900]) {
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-threads', '1', '-ss', '1', '-i', output, '-vf', `crop=16:16:500:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    expect(pixels.reduce((sum, value) => sum + value, 0) / pixels.length).toBeGreaterThan(240)
  }
})

test('shows the cropped Short frame and active meme overlay in the timeline preview', async () => {
  const directory = temporaryDirectory('otc-short-hover-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input, undefined, { otc_E2E_VIDEO: input })
  const window = await app.firstWindow()
  await click(window.getByRole('button', { name: 'Open Short', exact: true }))
  await completeVideoPicker(window)
  await click(window.getByRole('button', { name: 'Images', exact: true }))
  const asset = window.locator('.visual-asset').first()
  await expect(asset).toBeVisible()
  await click(asset)

  const timeline = window.locator('.timeline')
  const box = await timeline.boundingBox()
  if (!box) throw new Error('Timeline is not visible')
  await hover(timeline, { position: { x: box.width * 0.1, y: 20 } })
  const preview = window.locator('.timeline-hover-preview')
  await expect(preview).toBeVisible()
  await expect(preview.locator('.timeline-hover-overlay')).toHaveCount(1)
  await expect(preview.locator('.timeline-hover-camera > video:not(.preview-transition-previous)')).toHaveCSS('object-fit', 'cover')
  const frame = await preview.locator('.timeline-hover-frame').boundingBox()
  expect(frame).not.toBeNull()
  expect((frame?.width ?? 0) / (frame?.height ?? 1)).toBeCloseTo(9 / 16, 2)
})
