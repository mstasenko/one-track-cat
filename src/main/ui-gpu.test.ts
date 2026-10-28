import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  accessSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const replacement = { ...actual, ...fsMocks }
  return { ...replacement, default: replacement }
})

import { configureIntelUiGpu } from './ui-gpu'

const sysfs = '/sys/class/drm'
const device = (name: string): string => `${sysfs}/${name}/device`
const render = (name: string): string => `/dev/dri/${name}`
const sysfsFiles = new Map<string, string>()

function setDevice(name: string, vendor: string, pci: string, bootVga: string): void {
  sysfsFiles.set(`${device(name)}/vendor`, vendor)
  sysfsFiles.set(`${device(name)}/uevent`, `PCI_SLOT_NAME=${pci}\n`)
  sysfsFiles.set(`${device(name)}/boot_vga`, bootVga)
}

beforeEach(() => {
  fsMocks.accessSync.mockReset()
  fsMocks.existsSync.mockReset()
  fsMocks.readdirSync.mockReset()
  fsMocks.readFileSync.mockReset()
  sysfsFiles.clear()
  fsMocks.readFileSync.mockImplementation((path: string) => {
    const value = sysfsFiles.get(path)
    if (value === undefined) throw new Error(`missing mock for ${path}`)
    return value
  })
  fsMocks.existsSync.mockImplementation((path: string) => [
    '/usr/share/glvnd/egl_vendor.d/50_mesa.json',
    '/usr/share/vulkan/icd.d/intel_icd.json',
    '/etc/OpenCL/vendors/intel.icd'
  ].includes(path))
})

describe('Linux UI GPU policy', () => {
  it('prefers an accessible Intel discrete GPU without probing AMD', () => {
    fsMocks.readdirSync.mockReturnValue(['renderD400', 'renderD401', 'renderD402'])
    setDevice('renderD400', '0x8086', '0000:00:02.0', '1')
    setDevice('renderD401', '0x8086', '0000:03:00.0', '0')
    setDevice('renderD402', '0x1002', '0000:0a:00.0', '0')
    const accessed: string[] = []
    fsMocks.accessSync.mockImplementation((path: string) => { accessed.push(path) })

    const policy = configureIntelUiGpu()

    expect(policy).toEqual({
      disableHardwareAcceleration: false,
      renderNode: render('renderD401'),
      environment: {
        CUDA_VISIBLE_DEVICES: '',
        __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json',
        VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/intel_icd.json',
        VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/intel_icd.json',
        OCL_ICD_VENDORS: '/etc/OpenCL/vendors/intel.icd',
        DRI_PRIME: 'pci-0000_03_00_0'
      }
    })
    expect(accessed).toEqual([render('renderD400'), render('renderD401')])
  })

  it('falls back to the accessible Intel iGPU when the discrete node is unavailable', () => {
    fsMocks.readdirSync.mockReturnValue(['renderD400', 'renderD401'])
    setDevice('renderD400', '0x8086', '0000:00:02.0', '1')
    setDevice('renderD401', '0x8086', '0000:03:00.0', '0')
    fsMocks.accessSync.mockImplementation((path: string) => {
      if (path === render('renderD401')) throw new Error('permission denied')
    })

    const policy = configureIntelUiGpu()

    expect(policy.renderNode).toBe(render('renderD400'))
    expect(policy.environment.DRI_PRIME).toBe('pci-0000_00_02_0')
  })

  it('disables hardware acceleration while retaining Intel loader whitelists without Intel', () => {
    fsMocks.readdirSync.mockReturnValue(['renderD402'])
    setDevice('renderD402', '0x1002', '0000:0a:00.0', '0')

    const policy = configureIntelUiGpu()

    expect(policy.disableHardwareAcceleration).toBe(true)
    expect(policy.renderNode).toBeUndefined()
    expect(policy.environment).toMatchObject({
      CUDA_VISIBLE_DEVICES: '',
      __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json',
      VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/intel_icd.json',
      VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/intel_icd.json',
      OCL_ICD_VENDORS: '/etc/OpenCL/vendors/intel.icd'
    })
  })
})
