import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs'

const MESA_EGL = '/usr/share/glvnd/egl_vendor.d/50_mesa.json'
const INTEL_ICD = '/usr/share/vulkan/icd.d/intel_icd.json'
const INTEL_OCL = '/etc/OpenCL/vendors/intel.icd'

export interface UiGpuPolicy {
  readonly disableHardwareAcceleration: boolean
  readonly renderNode?: string
  readonly environment: Readonly<Record<string, string>>
}

function read(path: string): string | undefined {
  try { return readFileSync(path, 'utf8').trim() } catch { return undefined }
}

function accessible(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
}

function firstExisting(paths: readonly string[]): string | undefined {
  return paths.find((path) => existsSync(path))
}

function pciPrime(pciAddress: string): string {
  return `pci-${pciAddress.replaceAll(':', '_').replace('.', '_')}`
}

/** Configure Electron and its Linux graphics loaders before the GPU process starts. */
export function configureIntelUiGpu(): UiGpuPolicy {
  if (process.platform !== 'linux') return { disableHardwareAcceleration: false, environment: {} }

  const mesaEgl = firstExisting([MESA_EGL, '/etc/glvnd/egl_vendor.d/50_mesa.json'])
  const intelIcd = firstExisting([INTEL_ICD, '/etc/vulkan/icd.d/intel_icd.json'])
  const intelOpenCl = firstExisting([INTEL_OCL, '/usr/share/OpenCL/vendors/intel.icd'])
  const environment: Record<string, string> = { CUDA_VISIBLE_DEVICES: '' }
  if (mesaEgl) environment.__EGL_VENDOR_LIBRARY_FILENAMES = mesaEgl
  if (intelIcd) {
    environment.VK_DRIVER_FILES = intelIcd
    environment.VK_ICD_FILENAMES = intelIcd
  }
  if (intelOpenCl) environment.OCL_ICD_VENDORS = intelOpenCl

  const candidates = (() => {
    try { return readdirSync('/sys/class/drm').filter((name) => /^renderD\d+$/.test(name)).sort() } catch { return [] }
  })()
  let integrated: { node: string; pci: string } | undefined
  let discrete: { node: string; pci: string } | undefined
  for (const name of candidates) {
    const device = `/sys/class/drm/${name}/device`
    if (read(`${device}/vendor`)?.toLowerCase() !== '0x8086') continue
    const uevent = read(`${device}/uevent`) ?? ''
    const pci = /^PCI_SLOT_NAME=(\S+)$/mi.exec(uevent)?.[1]
    if (!pci || !accessible(`/dev/dri/${name}`)) continue
    const selected = { node: `/dev/dri/${name}`, pci }
    if (read(`${device}/boot_vga`) === '0') discrete = selected
    else integrated ??= selected
  }
  const selected = discrete ?? integrated
  if (!selected) return { disableHardwareAcceleration: true, environment }
  environment.DRI_PRIME = pciPrime(selected.pci)
  return { disableHardwareAcceleration: false, renderNode: selected.node, environment }
}
