import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
const applicationsDirectory = join(dataHome, 'applications')
const iconsDirectory = join(dataHome, 'icons', 'hicolor', '512x512', 'apps')
const desktopPath = join(applicationsDirectory, 'OneTrackCat.desktop')
const iconPath = join(projectRoot, 'src', 'icon.png')

await Promise.all([
  mkdir(applicationsDirectory, { recursive: true }),
  mkdir(iconsDirectory, { recursive: true })
])
await copyFile(iconPath, join(iconsDirectory, 'OneTrackCat.png'))
const developmentEntry = `[Desktop Entry]
Type=Application
Version=1.0
Name=OneTrackCat Dev
Comment=Run the OneTrackCat development build
Icon=OneTrackCat
Exec=/usr/bin/systemd-run --user --collect --quiet --unit=one-track-cat-dev --same-dir /usr/local/bin/npm run dev
Path=${projectRoot}
Terminal=false
Categories=AudioVideo;Video;
StartupNotify=false
StartupWMClass=OneTrackCat
X-OneTrackCat-Development=true
`

try {
  const existing = await readFile(desktopPath, 'utf8')
  if (existing.includes('X-OneTrackCat-Development=true') || existing.includes('Name=OneTrackCat Dev')) {
    await writeFile(desktopPath, developmentEntry, { mode: 0o644 })
  }
} catch (catchError) {
  if (catchError?.code !== 'ENOENT') throw catchError
  await writeFile(desktopPath, developmentEntry, { mode: 0o644 })
}
