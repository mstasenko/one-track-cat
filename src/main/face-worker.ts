import { constants } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import type { ProjectCanvas } from '../types'
import type { FaceCommand } from './face-process'

interface FacePack {
  executable: string
  model: string
}

interface FaceWorkerCanvas {
  width: number
  height: number
  fps: number
}

const drmRoot = '/sys/class/drm'
const driRoot = '/dev/dri'
const pkexecPath = '/usr/bin/pkexec'
const renderNodePattern = /^renderD\d+$/

function nativeArgs(pack: FacePack, canvas: FaceWorkerCanvas, effects: string, device: 'CPU' | 'AUTO'): string[] {
  return [
    '--model', pack.model, '--width', String(canvas.width), '--height', String(canvas.height), '--fps', String(canvas.fps),
    '--effects', effects, '--device', device
  ]
}

export function nativeFaceWorkerCommand(pack: FacePack, canvas: FaceWorkerCanvas, effects: string, device: 'CPU' | 'AUTO'): FaceCommand {
  return { executable: pack.executable, args: nativeArgs(pack, canvas, effects, device) }
}

function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  const code = error.code
  return code === 'EACCES' || code === 'EPERM'
}

function isIntelVendor(vendor: string): boolean {
  return vendor.trim().toLowerCase() === '0x8086'
}

async function renderEntries(): Promise<string[]> {
  try {
    return (await readdir(drmRoot)).filter((name) => renderNodePattern.test(name)).sort()
  } catch {
    return []
  }
}

async function deniedIntelNode(entry: string): Promise<string | undefined> {
  const vendor = await readFile(`${drmRoot}/${entry}/device/vendor`, 'utf8').catch(() => '')
  if (!isIntelVendor(vendor)) return undefined
  try {
    await access(`${driRoot}/${entry}`, constants.R_OK | constants.W_OK)
  } catch (error) {
    if (isPermissionError(error)) return `${driRoot}/${entry}`
  }
  return undefined
}

/** Returns the first Intel render node inaccessible to the current user. */
export async function restrictedIntelRenderNode(): Promise<string | undefined> {
  if (process.env.otc_CPU_ONLY === '1' || process.platform !== 'linux') return undefined
  for (const entry of await renderEntries()) {
    const denied = await deniedIntelNode(entry)
    if (denied) return denied
  }
  return undefined
}

export async function buildFaceWorkerCommand(
  pack: FacePack,
  canvas: ProjectCanvas,
  effects: string
): Promise<FaceCommand> {
  if (process.env.otc_CPU_ONLY === '1') return nativeFaceWorkerCommand(pack, canvas, effects, 'CPU')
  const restrictedNode = await restrictedIntelRenderNode()
  const autoCommand = nativeFaceWorkerCommand(pack, canvas, effects, 'AUTO')
  if (!restrictedNode) return autoCommand
  return {
    executable: pkexecPath,
    args: ['--disable-internal-agent', autoCommand.executable, ...autoCommand.args],
    elevated: true
  }
}
