import { constants } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'

/** Shared authorization preflight for face blur, Re-voice and export.
 * Read sysfs only: initializing a GPU runtime here could open other vendors' GPUs.
 * Missing devices are not permission failures and must not trigger a password prompt. */
export async function restrictedIntelRenderNode(): Promise<string | undefined> {
  if (process.env.otc_CPU_ONLY === '1' || process.platform !== 'linux') return undefined
  const entries = await readdir('/sys/class/drm').catch(() => [] as string[])
  for (const entry of entries.filter((name) => /^renderD\d+$/.test(name)).sort()) {
    const vendor = await readFile(`/sys/class/drm/${entry}/device/vendor`, 'utf8').catch(() => '')
    if (vendor.trim().toLowerCase() !== '0x8086') continue
    const path = `/dev/dri/${entry}`
    try { await access(path, constants.R_OK | constants.W_OK) } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')) return path
    }
  }
  return undefined
}
