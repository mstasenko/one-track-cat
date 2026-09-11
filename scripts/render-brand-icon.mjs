import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
const source = join(root, 'assets', 'icon.svg')
const output = join(root, 'src', 'icon.png')
const temporary = await mkdtemp(join(tmpdir(), 'icon-render-'))
let application

function assertRgbaPng(data) {
  if (data.toString('ascii', 1, 4) !== 'PNG') throw new Error('Renderer did not produce a PNG')
  if (data.readUInt32BE(16) !== 512 || data.readUInt32BE(20) !== 512 || data[25] !== 6) {
    throw new Error('Expected a 512x512 RGBA PNG')
  }
}

try {
  await writeFile(join(temporary, 'package.json'), '{"main":"main.cjs"}')
  await writeFile(join(temporary, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    app.whenReady().then(async () => {
      const window = new BrowserWindow({
        width: 512, height: 512, useContentSize: true, frame: false,
        transparent: true, backgroundColor: '#00000000', show: true
      })
      await window.loadFile(process.env.otc_ICON_SOURCE)
    })
  `)

  application = await electron.launch({
    args: [temporary, '--no-sandbox'],
    env: { ...process.env, otc_ICON_SOURCE: source }
  })
  const page = await application.firstWindow()
  await page.screenshot({ path: output, omitBackground: true })
  assertRgbaPng(await readFile(output))
} finally {
  if (application) await application.close().catch(() => undefined)
  await rm(temporary, { recursive: true, force: true })
}
