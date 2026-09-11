import { copyFile, mkdir, writeFile } from 'node:fs/promises'
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
try {
  await writeFile(desktopPath, `[Desktop Entry]
Type=Application
Name=OneTrackCat
Comment=Turn gameplay into highlights.
Icon=OneTrackCat
Exec=/usr/bin/false
Terminal=false
NoDisplay=true
Categories=AudioVideo;Video;
StartupWMClass=OneTrackCat
`, { flag: 'wx', mode: 0o644 })
} catch (catchError) {
  if (catchError?.code !== 'EEXIST') throw catchError
}
