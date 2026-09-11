import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDesktopEntry, installDesktopIntegration } from './desktop'

describe('AppImage desktop integration', () => {
  it('quotes executable paths and declares video file support', () => {
    const entry = createDesktopEntry('/home/sap/one-track-cat/OneTrackCat.AppImage')
    expect(entry).toContain('Name=OneTrackCat')
    expect(entry).toContain('Exec="/home/sap/one-track-cat/OneTrackCat.AppImage" %F')
    expect(entry).toContain('Icon=OneTrackCat')
    expect(entry).toContain('video/mp4')
  })

  it('installs the user desktop file and icon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'otc-desktop-'))
    const resourcesPath = join(root, 'bundle')
    const dataHome = join(root, 'data')
    await mkdir(join(resourcesPath, 'resources'), { recursive: true })
    await writeFile(join(resourcesPath, 'resources', 'icon.png'), 'icon')
    await installDesktopIntegration({ appImagePath: '/apps/OneTrackCat.AppImage', resourcesPath, dataHome })
    expect(await readFile(join(dataHome, 'applications', 'OneTrackCat.desktop'), 'utf8')).toContain('/apps/OneTrackCat.AppImage')
    expect(await readFile(join(dataHome, 'icons', 'hicolor', '512x512', 'apps', 'OneTrackCat.png'), 'utf8')).toBe('icon')
  })
})
