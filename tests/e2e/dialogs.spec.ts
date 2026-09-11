import { expect, test, _electron as electron } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { click, dismissHardwareWarningIfNeeded, e2eEnvironment, main, syntheticVideo } from './support'

const packageMetadata = createRequire(import.meta.url)('../../package.json') as { version: string }
const applications: ElectronApplication[] = []
const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function launch(input: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [main, input],
    env: e2eEnvironment({ otc_CPU_ONLY: '1' })
  })
  applications.push(app)
  await dismissHardwareWarningIfNeeded(await app.firstWindow())
  return app
}

async function openResetMenu(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.items
      .find((entry) => entry.label === 'Project')?.submenu?.items
      .find((entry) => entry.label === 'Reset project')
    if (!item) throw new Error('Reset project menu item is missing')
    if (typeof item.click !== 'function') throw new Error('Reset project menu item is not actionable')
    const activate = item.click as () => void
    activate()
  })
}

test.afterEach(async () => {
  for (const app of applications.splice(0)) await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('traps Reset project confirmation, preserves Cancel/Escape, and resets only on explicit confirmation', async () => {
  const directory = temporaryDirectory('otc-reset-dialog-')
  const input = syntheticVideo(directory, true)
  const app = await launch(input)
  const window = await app.firstWindow()
  await click(window.getByRole('button', { name: 'Text', exact: true }))
  const text = window.getByRole('textbox', { name: 'Text' })
  await text.fill('DIALOG TEXT')
  await expect(text).toHaveValue('DIALOG TEXT')

  await window.emulateMedia({ reducedMotion: 'reduce' })
  await openResetMenu(app)
  const dialog = window.getByRole('dialog', { name: 'Reset project?' })
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  const reset = dialog.getByRole('button', { name: 'Reset project', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveClass(/confirmation-dialog/)
  await expect(cancel).toBeFocused()
  await expect.poll(() => dialog.evaluate((element) => {
    const style = getComputedStyle(element)
    return `${style.animationName}/${style.animationDuration}`
  })).toBe('none/0s')

  await window.keyboard.press('Tab')
  await expect(reset).toBeFocused()
  await window.keyboard.press('Tab')
  await expect(cancel).toBeFocused()
  await window.keyboard.press('Shift+Tab')
  await expect(reset).toBeFocused()
  await window.keyboard.press('Delete')
  await expect(dialog).toBeVisible()
  await window.keyboard.press('Shift+Tab')
  await expect(cancel).toBeFocused()
  await window.keyboard.press('Space')
  await expect(dialog).toBeHidden()
  await expect(text).toHaveValue('DIALOG TEXT')

  await openResetMenu(app)
  await expect(dialog).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(text).toHaveValue('DIALOG TEXT')

  await openResetMenu(app)
  await expect(dialog).toBeVisible()
  await click(reset)
  await expect(dialog).toBeHidden()
  await expect(window.getByRole('heading', { name: 'Drop a video' })).toBeVisible()
  await expect(window.getByRole('textbox', { name: 'Text' })).toHaveCount(0)
})

test('restores normal-close state and Reset project forgets it', async () => {
  const directory = temporaryDirectory('otc-restore-')
  const input = syntheticVideo(directory, true)
  const first = await launch(input)
  const firstWindow = await first.firstWindow()
  await click(firstWindow.getByRole('button', { name: 'Text', exact: true }))
  await firstWindow.getByRole('textbox', { name: 'Text' }).fill('RESTORED')
  await first.close()

  const restored = await electron.launch({ args: [main], env: e2eEnvironment() })
  applications.push(restored)
  const restoredWindow = await restored.firstWindow()
  await dismissHardwareWarningIfNeeded(restoredWindow)
  await expect(restoredWindow.getByRole('textbox', { name: 'Text' })).toHaveValue('RESTORED')
  await expect(restoredWindow.getByRole('button', { name: 'Undo' })).toBeEnabled()
  await click(restoredWindow.getByRole('button', { name: 'Undo' }))
  await expect(restoredWindow.getByRole('textbox', { name: 'Text' })).toHaveValue('Your text')
  await expect(restoredWindow.getByRole('button', { name: 'Redo' })).toBeEnabled()
  await click(restoredWindow.getByRole('button', { name: 'Redo' }))
  await expect(restoredWindow.getByRole('textbox', { name: 'Text' })).toHaveValue('RESTORED')
  expect(await restored.evaluate(({ Menu }) => {
    const project = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Project')
    return project?.submenu?.items.filter((item) => item.type !== 'separator').map((item) => item.label)
  })).toEqual([`OneTrackCat ${packageMetadata.version}`, 'Reset project'])
  await openResetMenu(restored)
  const resetDialog = restoredWindow.getByRole('dialog', { name: 'Reset project?' })
  await expect(resetDialog).toBeVisible()
  await click(resetDialog.getByRole('button', { name: 'Reset project', exact: true }))
  await expect(restoredWindow.getByRole('heading', { name: 'Drop a video' })).toBeVisible()
  await restored.close()

  const empty = await electron.launch({ args: [main], env: e2eEnvironment() })
  applications.push(empty)
  const emptyWindow = await empty.firstWindow()
  await dismissHardwareWarningIfNeeded(emptyWindow)
  await expect(emptyWindow.getByRole('heading', { name: 'Drop a video' })).toBeVisible()
})

test('keeps editing and jobs usable after a failed close save is canceled', async () => {
  const directory = temporaryDirectory('otc-close-save-cancel-')
  const input = syntheticVideo(directory, true)
  const blockedUserData = join(directory, 'blocked-user-data')
  writeFileSync(blockedUserData, 'not a directory')
  const app = await launch(input)
  const window = await app.firstWindow()
  await click(window.getByRole('button', { name: 'Text', exact: true }))
  const text = window.getByRole('textbox', { name: 'Text' })
  await text.fill('BEFORE CANCEL')
  await expect(text).toHaveValue('BEFORE CANCEL')

  await app.evaluate(({ dialog }) => {
    const state = {
      calls: 0,
      original: dialog.showMessageBoxSync.bind(dialog)
    }
    interface E2EState { calls: number; original: typeof state.original }
    ;(globalThis as typeof globalThis & { __otcCloseSaveCancel?: E2EState }).__otcCloseSaveCancel = state
    dialog.showMessageBoxSync = () => {
      state.calls += 1
      return 1
    }
  })
  await app.evaluate(({ app }, path) => app.setPath('userData', path), blockedUserData)
  await app.evaluate(({ app }) => app.quit())
  await expect.poll(() => app.evaluate(() => {
    interface E2EState { calls: number }
    return (globalThis as typeof globalThis & { __otcCloseSaveCancel?: E2EState }).__otcCloseSaveCancel?.calls ?? 0
  })).toBe(1)
  await expect.poll(() => app.windows().length).toBe(1)
  await expect(text).toHaveValue('BEFORE CANCEL')

  await app.evaluate(({ dialog }) => {
    interface E2EState { original: typeof dialog.showMessageBoxSync }
    const state = (globalThis as typeof globalThis & { __otcCloseSaveCancel?: E2EState }).__otcCloseSaveCancel
    if (!state) throw new Error('Close-save test state is missing')
    dialog.showMessageBoxSync = state.original
  })
  await app.evaluate(({ app }, path) => app.setPath('userData', path), directory)

  await text.fill('AFTER CANCEL')
  await expect(text).toHaveValue('AFTER CANCEL')

  await app.evaluate(({ app }) => app.quit())
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(0)
  expect(readFileSync(join(directory, 'editor-state.json'), 'utf8')).toContain('AFTER CANCEL')
})
