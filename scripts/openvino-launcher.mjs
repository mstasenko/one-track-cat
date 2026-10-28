/** One environment for both optional workers; only their binary names differ. */
export function openvinoLauncher(binary) {
  if (!/^[a-z0-9-]+\.bin$/.test(binary)) throw new Error('Invalid worker binary name')
  return [
    '#!/bin/sh', 'set -eu',
    'pack_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'export OPENVINO_LIB_PATH="$pack_root/lib"',
    'export LD_LIBRARY_PATH="$pack_root/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
    // Restrict discovery itself, before OpenCL initializes every vendor's
    // driver. With no Intel ICD installed, CPU processing remains available.
    'export OCL_ICD_VENDORS=/etc/OpenCL/vendors/intel.icd',
    'export CUDA_VISIBLE_DEVICES=""',
    // Keep the driver's default cache: AI stages recompile between memory-
    // bounded phases. pkexec gives elevated workers their own root HOME.
    `exec "$pack_root/${binary}" "$@"`, ''
  ].join('\n')
}
