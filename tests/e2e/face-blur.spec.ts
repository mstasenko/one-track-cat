import { expect, test, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { click, dismissHardwareWarningIfNeeded, e2eEnvironment, main, syntheticVideo } from './support'

test('missing face pack explains the local install and never offers a download action', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'otc-face-pack-'))
  const input = syntheticVideo(directory, true)
  const app = await electron.launch({
    args: [main, input],
    env: e2eEnvironment({ otc_E2E_COMPACT: '1', otc_E2E_GPU_OFF: '1', otc_CPU_ONLY: '1' })
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('faces:pack-status')
      ipcMain.handle('faces:pack-status', () => ({ available: false, message: 'Test face pack is unavailable.' }))
    })
    await dismissHardwareWarningIfNeeded(page)
    await click(page.getByRole('button', { name: 'Blur faces', exact: true }))
    const missing = page.locator('.face-pack-missing')
    await expect(missing).toContainText('Download and extract the face-pack')
    await expect(missing).toContainText('next to the OneTrackCat AppImage')
    await expect(page.getByRole('button', { name: 'Apply face blur', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: /download/i })).toHaveCount(0)
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})
