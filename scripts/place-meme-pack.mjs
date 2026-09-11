import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const release = join(root, 'release')
const destination = join(release, 'meme')

mkdirSync(release, { recursive: true })
rmSync(destination, { recursive: true, force: true })
cpSync(join(root, 'dist', 'meme-pack'), destination, { recursive: true })
copyFileSync(join(root, 'dist', 'otc-media-pack.zip'), join(release, 'otc-media-pack.zip'))

// The AppImage is the distributable; electron-builder's unpacked tree and
// diagnostics only make the local release directory harder to understand.
for (const name of ['linux-unpacked', 'builder-debug.yml', 'builder-effective-config.yaml']) {
  rmSync(join(release, name), { recursive: true, force: true })
}
