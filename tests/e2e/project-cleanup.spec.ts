import { expect, test, _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { click, completeVideoPicker, dismissHardwareWarningIfNeeded, e2eEnvironment, main, syntheticVideo } from './support'

test.describe('Project cleanup', () => {
  for (const action of ['Open another project', 'Reset project']) {
    test(`${action}: discard project caches; preserve sources, exports and models`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'otc-project-cleanup-'))
      const first = syntheticVideo(directory)
      const second = syntheticVideo(directory, true)
      const exported = join(directory, 'finished.mp4')
      writeFileSync(exported, 'finished user export')
      const app = await electron.launch({ args: [main, first], env: e2eEnvironment({
        XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), otc_E2E_VIDEO: second
      }) })
      try {
        const window = await app.firstWindow()
        await dismissHardwareWarningIfNeeded(window)
        await expect(window.locator('.source-name')).toHaveText('game.mp4')
        const userData = await app.evaluate(({ app }) => app.getPath('userData'))
        expect(userData.startsWith(directory)).toBe(true)
        const write = (path: string): string => {
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, 'test artifact')
          return path
        }
        const face = join(userData, 'face-preview')
        const narration = join(userData, 'narration')
        const templates = join(userData, 'online-templates')
        const proxies = join(directory, 'cache', 'otc', 'proxies')
        const oldFiles = [
          write(join(face, 'preview-old.mp4')), write(join(face, 'preview-old.json')),
          write(join(face, 'detections.cache')), write(join(face, 'detections.cache.json')),
          ...['original.wav', 'speech.wav', 'background.wav', 'utterance-cached.wav', 'old-mix.wav', 'old-voice.f32le', 'draft.json']
            .map((name) => write(join(narration, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name))),
          write(join(templates, 'imgflip-123.png')), write(join(proxies, `${'a'.repeat(24)}.mp4`))
        ]
        const preserved = [first, second, exported,
          write(join(userData, 'otc-voice-models', 'voice', 'model.bin')),
          write(join(userData, 'otc-face-models', 'faces', 'model.bin')),
          write(join(userData, 'otc-flashvsr-plus', 'models', 'turbo', 'model.bin'))]
        const before = preserved.map((path) => readFileSync(path))
        expect(oldFiles.every(existsSync)).toBe(true)
        if (action === 'Open another project') {
          await click(window.getByRole('button', { name: 'Open', exact: true }))
          await completeVideoPicker(window)
          await expect(window.locator('.source-name')).toHaveText('black.mp4')
        } else {
          await app.evaluate(({ Menu }) => {
            const item = Menu.getApplicationMenu()?.items.find((entry) => entry.label === 'Project')?.submenu?.items
              .find((entry) => entry.label === 'Reset project')
            if (!item || typeof item.click !== 'function') throw new Error('Reset menu missing')
            ;(item.click as () => void)()
          })
          await click(window.getByRole('dialog', { name: 'Reset project?' }).getByRole('button', { name: 'Reset project', exact: true }))
          await expect(window.getByRole('heading', { name: 'Drop a video' })).toBeVisible()
        }
        await expect.poll(() => oldFiles.filter(existsSync)).toEqual([])
        for (const path of [face, narration, templates, proxies]) {
          expect(existsSync(path) ? readdirSync(path) : []).toEqual([])
        }
        expect(preserved.map((path) => readFileSync(path))).toEqual(before)
      } finally {
        const child = app.process()
        const exited = child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve() : new Promise<void>((resolve) => child.once('exit', () => resolve()))
        await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
        await exited
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
})
