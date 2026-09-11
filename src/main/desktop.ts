import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface DesktopIntegrationOptions {
  appImagePath: string
  resourcesPath: string
  dataHome: string
}
function quoteExec(path: string): string {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$')}"`
}

export function createDesktopEntry(appImagePath: string): string {
  return `[Desktop Entry]
Type=Application
Name=OneTrackCat
Comment=Turn gameplay into highlights.
Exec=${quoteExec(appImagePath)} %F
Icon=OneTrackCat
Terminal=false
Categories=AudioVideo;Video;
StartupWMClass=OneTrackCat
MimeType=video/mp4;video/quicktime;video/x-matroska;video/webm;
`
}

async function writeWhenChanged(path: string, contents: string): Promise<void> {
  try {
    if (await readFile(path, 'utf8') === contents) return
  } catch {
    // A missing first-run file is expected.
  }
  await writeFile(path, contents, { mode: 0o644 })
}

export async function installDesktopIntegration(options: DesktopIntegrationOptions): Promise<void> {
  const applicationsDirectory = join(options.dataHome, 'applications')
  const iconDirectory = join(options.dataHome, 'icons', 'hicolor', '512x512', 'apps')
  await Promise.all([
    mkdir(applicationsDirectory, { recursive: true }),
    mkdir(iconDirectory, { recursive: true })
  ])
  await Promise.all([
    copyFile(join(options.resourcesPath, 'resources', 'icon.png'), join(iconDirectory, 'OneTrackCat.png')),
    writeWhenChanged(join(applicationsDirectory, 'OneTrackCat.desktop'), createDesktopEntry(options.appImagePath))
  ])
}
