import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, _electron as electron } from '@playwright/test'

const projectRoot = resolve(import.meta.dirname, '..')
const packageVersion = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version
const appImage = join(projectRoot, 'release', `OneTrackCat-${packageVersion}-ubuntu26-wayland-x86_64.AppImage`)
if (!existsSync(appImage)) throw new Error(`Packaged AppImage is missing: ${appImage}`)
const env = Object.fromEntries(Object.entries({
  ...process.env,
  APPIMAGE_EXTRACT_AND_RUN: '1',
  otc_HEADLESS_TEST: '1',
  otc_CPU_ONLY: '1',
  otc_E2E_GPU_OFF: '1',
  LIBGL_ALWAYS_SOFTWARE: '1',
  CUDA_VISIBLE_DEVICES: ''
}).filter(([, value]) => value !== undefined))

let application
const failures = []
const observed = new WeakSet()
const observe = (page) => {
  if (observed.has(page)) return
  observed.add(page)
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`))
  page.on('crash', () => failures.push('renderer crashed'))
}

try {
  application = await electron.launch({ executablePath: appImage, args: ['--no-sandbox'], env, timeout: 30_000 })
  application.on('window', observe)
  const page = await application.firstWindow({ timeout: 30_000 })
  observe(page)

  await expect(page.getByRole('heading', { name: 'Drop a video', exact: true })).toBeVisible()
  for (const name of ['Open', 'Open Short']) {
    const control = page.getByRole('button', { name, exact: true })
    await expect(control).toBeVisible()
    await expect(control).toBeEnabled()
    const box = await control.boundingBox()
    if (!box || box.width <= 0 || box.height <= 0) throw new Error(`${name} control did not render`)
  }
  await page.waitForTimeout(250)
  const historicalErrors = await page.pageErrors()
  if (historicalErrors.length > 0) failures.push(...historicalErrors.map((error) => `page error: ${error.message}`))
  if (failures.length > 0) throw new Error(failures.join('\n'))
  console.log('Packaged AppImage initial UI smoke passed')
} finally {
  await application?.close().catch(() => undefined)
}
