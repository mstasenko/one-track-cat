import { expect, test, _electron as electron } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { click, dismissHardwareWarningIfNeeded, e2eEnvironment, main, syntheticVideo } from './support'

function animationNames(element: Element): string[] {
  const elements = [element, ...Array.from(element.querySelectorAll('*'))]
  return elements.flatMap((candidate) => {
    const styles = [
      getComputedStyle(candidate),
      getComputedStyle(candidate, '::before'),
      getComputedStyle(candidate, '::after')
    ]
    return styles.map((style) => style.animationName)
  })
}

test('shows a cancellable export wait animation and honors reduced motion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'otc-export-wait-'))
  const input = syntheticVideo(directory)
  let app: ElectronApplication | undefined

  try {
    const output = join(directory, 'pending.mp4')
    app = await electron.launch({
      args: [main, input],
      env: e2eEnvironment({
        otc_CPU_ONLY: '1',
        otc_E2E_COMPACT: '1',
        otc_E2E_GPU_OFF: '1',
        otc_E2E_OUTPUT: output
      })
    })
    const page = await app.firstWindow()
    await dismissHardwareWarningIfNeeded(page)
    await expect(page.getByText('game.mp4', { exact: true })).toBeVisible({ timeout: 15_000 })

    await app.evaluate(({ ipcMain }) => {
      let rejectExport: ((reason?: unknown) => void) | undefined
      ipcMain.removeHandler('export:start')
      ipcMain.removeHandler('job:cancel')
      ipcMain.handle('export:start', async (event) => {
        event.sender.send('job:progress', {
          id: 'e2e-export-wait',
          kind: 'export',
          state: 'running',
          progress: 0.35,
          message: 'Waiting for test cancellation…'
        })
        await new Promise<void>((_resolve, reject) => { rejectExport = reject })
      })
      ipcMain.handle('job:cancel', (_event, id) => {
        if (id !== 'e2e-export-wait') return false
        rejectExport?.(new Error('Job cancelled'))
        rejectExport = undefined
        return true
      })
    })

    await click(page.getByRole('button', { name: 'Export', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Exporting video' })
    await expect(dialog).toBeVisible()
    const track = dialog.locator('.export-progress-track')
    const progress = dialog.locator('progress')
    await expect(track).toBeVisible()
    await expect(progress).toHaveCount(1)
    await expect(progress).toBeVisible()
    await expect(progress).toHaveAttribute('max', '1')
    await expect(progress).toHaveAttribute('value', '0.35')
    await expect.poll(async () => (await track.evaluate(animationNames)).some((name) => name !== 'none')).toBe(true)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(async () => (await track.evaluate(animationNames)).every((name) => name === 'none')).toBe(true)

    await click(dialog.getByRole('button', { name: 'Cancel' }))
    await expect(dialog).toBeHidden()
  } finally {
    if (app) await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})
