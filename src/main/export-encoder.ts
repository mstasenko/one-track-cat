import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { HardwareLabel } from '../types'
import { ffmpegPath, hardwareFfmpegCandidates } from './binaries'

export { hardwareFfmpegCandidates } from './binaries'

const execFileAsync = promisify(execFile)
export const vaapiCodecs = ['av1_vaapi', 'hevc_vaapi', 'h264_vaapi'] as const
export type VaapiCodec = typeof vaapiCodecs[number]

export interface ExportEncoder {
  executable: string
  input: string[]
  filterSuffix: string
  /** Filter needed after raw RGB input has been read by a hardware encoder. */
  rawVideoFilter?: string
  videoLabel: (softwareLabel: string) => string
  output: string[]
  hardwareLabel?: HardwareLabel
}

interface RenderDevice {
  path: string
  vendor: string
  pciSlot?: string
}

export function softwareEncoder(): ExportEncoder {
  return {
    executable: ffmpegPath(),
    input: [],
    filterSuffix: '',
    videoLabel: (label) => label,
    output: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-threads', '4', '-pix_fmt', 'yuv420p'],
    hardwareLabel: 'CPU'
  }
}

function renderDeviceHardwareLabel(device: RenderDevice): HardwareLabel | undefined {
  if (device.vendor.trim().toLowerCase() !== '0x8086' || !device.pciSlot) return undefined
  // Intel's PCI slot identifies the integrated controller; the other Intel
  // render nodes are discrete controllers. Unknown vendors remain unlabeled.
  return device.pciSlot.trim().endsWith(':00:02.0') ? 'iGPU' : 'dGPU'
}

// AV1 uses a 0–255 quality scale. 110 keeps bitrate variable and was calibrated
// on representative 4K samples; it is not a source-quality guarantee.
export function vaapiCodecOutput(codec: VaapiCodec): string[] {
  return codec === 'av1_vaapi'
    ? ['-c:v', codec, '-rc_mode', 'CQP', '-global_quality', '110']
    : ['-c:v', codec, '-qp', '18']
}

/** Reads the same sysfs identity used for VAAPI discovery without guessing unknown vendors. */
export async function hardwareLabelForRenderNode(renderNode: string): Promise<HardwareLabel | undefined> {
  const entry = basename(renderNode)
  if (!/^renderD\d+$/.test(entry)) return undefined
  const [vendor, uevent] = await Promise.all([
    readFile(`/sys/class/drm/${entry}/device/vendor`, 'utf8').catch(() => ''),
    readFile(`/sys/class/drm/${entry}/device/uevent`, 'utf8').catch(() => '')
  ])
  const pciSlot = /^PCI_SLOT_NAME=(.+)$/m.exec(uevent)?.[1]
  return renderDeviceHardwareLabel({ path: renderNode, vendor, pciSlot })
}

function vaapiEncoder(executable: string, device: RenderDevice, codec: VaapiCodec): ExportEncoder {
  const hardwareLabel = renderDeviceHardwareLabel(device)
  return {
    executable,
    input: ['-vaapi_device', device.path],
    filterSuffix: 'format=nv12,hwupload[hardwarev]',
    rawVideoFilter: 'format=nv12,hwupload',
    videoLabel: () => 'hardwarev',
    output: vaapiCodecOutput(codec),
    ...(hardwareLabel === undefined ? {} : { hardwareLabel })
  }
}

export function rankRenderDevices(devices: RenderDevice[]): RenderDevice[] {
  // Intel's integrated graphics conventionally occupies PCI slot 00:02.0.
  // Prefer another Intel device (such as Arc) while retaining every render node.
  return [...devices].sort((left, right) => {
    const rank = (device: RenderDevice): number => {
      if (device.vendor.trim().toLowerCase() !== '0x8086') return 2
      return device.pciSlot && !device.pciSlot.endsWith(':00:02.0') ? 0 : 1
    }
    return rank(left) - rank(right) || left.path.localeCompare(right.path)
  })
}

async function renderDevices(): Promise<RenderDevice[]> {
  try {
    const entries = await readdir('/dev/dri', { withFileTypes: true })
    const devices = await Promise.all(entries
      .filter((entry) => entry.isCharacterDevice() && /^renderD\d+$/.test(entry.name))
      .map(async (entry) => {
        const path = `/dev/dri/${entry.name}`
        const vendor = await readFile(`/sys/class/drm/${entry.name}/device/vendor`, 'utf8').catch(() => '')
        const pciSlot = await readFile(`/sys/class/drm/${entry.name}/device/uevent`, 'utf8')
          .then((value) => /^PCI_SLOT_NAME=(.+)$/m.exec(value)?.[1] ?? '')
          .catch(() => '')
        return { path, vendor, pciSlot }
      }))
    return rankRenderDevices(devices)
  } catch {
    return []
  }
}

/** Returns an accessible Intel iGPU for decode while leaving a dGPU to inference/encoding. */
export async function integratedDecodeDevice(): Promise<string | undefined> {
  if (process.env.otc_CPU_ONLY === '1') return undefined
  const device = (await renderDevices()).find((candidate) => renderDeviceHardwareLabel(candidate) === 'iGPU')
  if (!device) return undefined
  try {
    await access(device.path, constants.R_OK | constants.W_OK)
    return device.path
  } catch {
    return undefined
  }
}

export function vaapiProbeArgs(renderDevice: string, codec: VaapiCodec): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-vaapi_device', renderDevice,
    '-f', 'lavfi', '-i', 'color=size=1280x720:duration=0.04',
    '-vf', 'format=nv12,hwupload', ...vaapiCodecOutput(codec), '-frames:v', '1', '-f', 'null', '-'
  ]
}

async function availableFfmpegs(): Promise<string[]> {
  const available: string[] = []
  for (const path of hardwareFfmpegCandidates()) {
    try {
      await access(path)
      available.push(path)
    } catch {
      // Try the next trusted system location.
    }
  }
  return available
}

async function vaapiWorks(executable: string, renderDevice: string, codec: VaapiCodec): Promise<boolean> {
  try {
    await access(renderDevice)
    await execFileAsync(executable, vaapiProbeArgs(renderDevice, codec), { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

async function vaapiEncoders(executable: string, devices: RenderDevice[]): Promise<ExportEncoder[]> {
  const encoders: ExportEncoder[] = []
  for (const device of devices) {
    for (const codec of vaapiCodecs) {
      if (await vaapiWorks(executable, device.path, codec)) {
        encoders.push(vaapiEncoder(executable, device, codec))
      }
    }
  }
  return encoders
}

async function detectEncoders(): Promise<ExportEncoder[]> {
  const devices = await renderDevices()
  for (const executable of await availableFfmpegs()) {
    const hardware = await vaapiEncoders(executable, devices)
    if (hardware.length) return [...hardware, softwareEncoder()]
  }
  return [softwareEncoder()]
}

let cachedEncoders: Promise<ExportEncoder[]> | null = null

export function exportEncoders(): Promise<ExportEncoder[]> {
  if (process.env.otc_CPU_ONLY === '1') return Promise.resolve([softwareEncoder()])
  cachedEncoders ??= detectEncoders()
  return cachedEncoders
}
