import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { openvinoLauncher } = createRequire(import.meta.url)('../scripts/openvino-launcher.mjs') as {
  openvinoLauncher: (binary: string) => string
}
let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('optional OpenVINO worker launchers', () => {
  it.each([
    ['otc-upscale.bin', '1'], ['otc-face-blur.bin', '1'],
    ['otc-upscale.bin', undefined], ['otc-face-blur.bin', undefined]
  ] as const)('isolates Intel discovery and preserves %s cache setting %s', async (binary, cacheSetting) => {
    directory = await mkdtemp(join(tmpdir(), 'otc worker '))
    const launcher = join(directory, 'worker')
    await writeFile(launcher, openvinoLauncher(binary), { mode: 0o755 })
    await writeFile(join(directory, binary), '#!/bin/sh\nprintf "%s\\n" "$OCL_ICD_VENDORS" "$CUDA_VISIBLE_DEVICES" "$OPENVINO_LIB_PATH" "$LD_LIBRARY_PATH" "$NEO_CACHE_PERSISTENT" "$@"\n', { mode: 0o755 })

    const output = execFileSync(launcher, ['--input', 'a path; not a command'], {
      encoding: 'utf8',
      env: {
        ...process.env, OCL_ICD_VENDORS: '/unwanted/vendors', CUDA_VISIBLE_DEVICES: '0',
        LD_LIBRARY_PATH: '/existing/libraries', PKEXEC_UID: '1000', NEO_CACHE_PERSISTENT: cacheSetting
      }
    })
    expect(output.split('\n')).toEqual([
      '/etc/OpenCL/vendors/intel.icd', '', join(directory, 'lib'),
      `${join(directory, 'lib')}:/existing/libraries`, cacheSetting ?? '',
      '--input', 'a path; not a command', ''
    ])
  })

  it('rejects binary names that could escape the pack or change the shell command', () => {
    for (const binary of ['../other.bin', 'worker.bin; false', 'worker\n.bin']) {
      expect(() => openvinoLauncher(binary)).toThrow('Invalid worker binary name')
    }
  })
})
