import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('scripts/install-dev-desktop.mjs')

const devDesktop = `[Desktop Entry]
Type=Application
Name=OneTrackCat
Comment=Turn gameplay into highlights.
Icon=OneTrackCat
Exec=/usr/bin/false
Terminal=false
NoDisplay=true
Categories=AudioVideo;Video;
StartupWMClass=OneTrackCat
`

function run(dataHome: string): void {
  execFileSync(process.execPath, [script], {
    env: { ...process.env, XDG_DATA_HOME: dataHome },
    stdio: 'pipe'
  })
}

function desktopPath(dataHome: string): string {
  return join(dataHome, 'applications', 'OneTrackCat.desktop')
}

describe('development desktop integration', () => {
  it('preserves an existing packaged desktop entry', () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'otc-dev-desktop-'))
    const packaged = `[Desktop Entry]
Type=Application
Name=OneTrackCat
Exec="/opt/OneTrackCat.AppImage" %F
Icon=OneTrackCat
Terminal=false
Categories=AudioVideo;Video;
StartupWMClass=OneTrackCat
MimeType=video/mp4;video/quicktime;video/x-matroska;video/webm;
`
    mkdirSync(join(dataHome, 'applications'), { recursive: true })
    writeFileSync(desktopPath(dataHome), packaged)

    try {
      run(dataHome)
      run(dataHome)
      expect(readFileSync(desktopPath(dataHome), 'utf8')).toBe(packaged)
    } finally {
      rmSync(dataHome, { recursive: true, force: true })
    }
  })

  it('creates a development entry and permits a second invocation', () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'otc-dev-desktop-'))

    try {
      expect(existsSync(desktopPath(dataHome))).toBe(false)
      run(dataHome)
      run(dataHome)
      expect(readFileSync(desktopPath(dataHome), 'utf8')).toBe(devDesktop)
    } finally {
      rmSync(dataHome, { recursive: true, force: true })
    }
  })
})
