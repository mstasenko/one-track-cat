// Fixed release pins for the optional FlashVSR+ runtime pack.
// Bulk learned artifacts are deliberately not payloadPins: the application
// downloads the selected mode from the immutable Flash catalog and prepares
// it in the user's private model directory.  The two small fixed BF16 files
// are derived learned values and are pinned as pack assets below.
export const releasePins = {
  runtime: {
    version: '2026.5.0-23457-7d81aad55a5',
    wheelVersion: '2026.5.0.dev20261014',
    runtimeNoticeMember: 'openvino-2026.5.0.dev20261014.dist-info/licenses/licensing/runtime-third-party-programs.txt',
    artifact: 'openvino-2026.5.0.dev20261014-23457-cp311-cp311-manylinux_2_28_x86_64.whl',
    artifactSha256: '1eb7d70fa7228cf50abcf73ea52d09fd0b5f53c316ae7bdfe1016bf211bf911d',
    url: 'https://storage.openvinotoolkit.org/wheels/nightly/openvino/openvino-2026.5.0.dev20261014-23457-cp311-cp311-manylinux_2_28_x86_64.whl',
    gpuSourceRevision: '7d81aad55a539c827049ac9628ba4f8d5abb4539',
    gpuPatchSha256: '2db5e19d91a111fe8d9803db7ad9eddc9a1a2957dc6d75e179ff47d74839e7c1',
    executableCache: 'process-private-weight-descriptors-v1'
  },
  flash: {
    modelId: 'flashvsr-plus',
    revision: '46b79520946ac67dec94d1566490690953c7debc',
    promptRevision: 'b548a2cc2c929d3d4676f2973abe27876ec4dee7',
    catalogSha256: '58359ac7e061107de34983e2c0de26232c9fbd8f81987fd65a89ab380a8f8184',
    modes: 'turbo,base',
    licenseSpdx: 'Apache-2.0',
    licenseFile: 'LICENSE-FLASHVSR-APACHE.txt',
    licenseBytes: 11357,
    licenseSha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    licenseUrl: 'https://raw.githubusercontent.com/OpenImagingLab/FlashVSR_Plus/b548a2cc2c929d3d4676f2973abe27876ec4dee7/LICENSE',
    modelCardUrl: 'https://huggingface.co/ruchangyao/FlashVSR_plus',
    modelCardRevision: '46b79520946ac67dec94d1566490690953c7debc',
    modelCardReadmeSha256: '35d9806a14f9b05495c77bbb59a545f4ed75f6be7ab65979de9860d587bee0f1',
    baseModel: 'Wan-AI/Wan2.1-T2V-1.3B',
    baseModelLicenseUrl: 'https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B/resolve/main/LICENSE.txt',
    fixedProvenanceFile: 'NOTICE-FLASHVSR-PROVENANCE.json',
    fixedProvenanceBytes: 2743,
    fixedProvenanceSha256: 'f442a765092a003af5e432dce25cfc717b4fde56facb036514b85602f30e1c1f'
  },
  rife: {
    variant: 'v2-packed7',
    archiveSha256: '912fea8a9a405799cbe122605da12d6e4b5330aec83a0e026910651cb34d39fa',
    sourceSha256: '65c57a5e4abb17ad67faf35054291ac53affab0506d509d2e66698f6ecd75584'
  },
  openssl: {
    version: '3.5.5-1ubuntu3.7',
    source: 'openssl',
    distribution: 'Ubuntu',
    artifactSha256: '3ff73e121f6cd4f19e80ab4329dfd914108b3936c9db3708200203a9b245b34d',
    glibcMinimum: '2.38'
  }
}

// Structural files contain no bulk checkpoint payload.  The two fixed mode
// BINs are small BF16 values derived from external authenticated source.
export const flashStructuralFiles = [
  'flash_pre_4096_bf16.xml', 'flash_pre_4096_bf16.bin',
  'flash_post_4096_bf16.xml', 'flash_post_4096_bf16.bin',
  'flash_cross_kv_bf16.xml', 'flash_cross_kv_bf16.bin',
  'flash_lq_projection_startup_bf16.xml', 'flash_lq_projection_startup_bf16.bin',
  'flash_lq_projection_stage1_bf16.xml', 'flash_lq_projection_stage1_bf16.bin',
  'flash_lq_projection_stage2_bf16.xml', 'flash_lq_projection_stage2_bf16.bin',
  'flash_edges_prefix_bf16.xml', 'flash_edges_prefix_bf16.bin',
  'flash_edges_suffix_bf16.xml', 'flash_edges_suffix_bf16.bin',
  'flash_text_bf16.xml', 'flash_text_bf16.bin',
  'flash_decoder_phased_front_bf16.xml', 'flash_decoder_phased_front_bf16.bin',
  'flash_decoder_phased_grow_memory_bf16.xml', 'flash_decoder_phased_grow_memory_bf16.bin',
  'flash_decoder_phased_remote_frame_child_bf16.xml', 'flash_decoder_phased_remote_frame_child_bf16.bin',
  'plus_split_key.xml', 'plus_split_key_dg2.xml',
  'bf16_cross_bridge_custom_layers.xml', 'bf16_cross_bridge_20261017.cl',
  'plus_sparse_xmx.cl',
  'flash_fixed_conditioning_bf16_turbo.bin', 'flash_fixed_conditioning_bf16_base.bin'
]

export const flashComplementFiles = [
  'flash_pre_4096_bf16.bin', 'flash_post_4096_bf16.bin',
  'flash_cross_kv_bf16.bin', 'flash_lq_projection_startup_bf16.bin',
  'flash_lq_projection_stage1_bf16.bin', 'flash_lq_projection_stage2_bf16.bin',
  'flash_edges_prefix_bf16.bin', 'flash_edges_suffix_bf16.bin',
  'flash_text_bf16.bin', 'flash_decoder_phased_front_bf16.bin',
  'flash_decoder_phased_grow_memory_bf16.bin',
  'flash_decoder_phased_remote_frame_child_bf16.bin', 'empty-complement'
]

// The only accepted cached GPU fast path.  Source-built plugins get a fresh
// receipt and dynamic fingerprint instead; their bytes are not a release pin.
export const gpuPluginPath = 'lib/libopenvino_intel_gpu_plugin.so'
export const gpuPluginPin = {
  bytes: 44933800,
  sha256: '10fd499296809c69a165e403a09fd2bd9bcdc6823c34e252c48e1295d2daab48'
}

// Exact bytes used by assembly/verification.  The runtime names are from the
// pinned wheel; RIFE/model and attribution bytes are reviewed assets, while
// native RIFE warp support is pinned from native/upscale/rife-assets.
// The GPU plugin is intentionally kept out of this table because its source
// build may have a different, freshly authenticated fingerprint.
export const payloadPins = {
  'runtime-source/reorder-cache.patch': { bytes: 7161, sha256: '2db5e19d91a111fe8d9803db7ad9eddc9a1a2957dc6d75e179ff47d74839e7c1' },
  'lib/libopenvino.so.2650': { bytes: 20726065, sha256: '2bd85cbaa908edb55944fe232fc300523cb8f2eb09593917ea14c5550ebb4c0a' },
  'lib/libopenvino_ir_frontend.so.2650': { bytes: 648529, sha256: '7d11439b876803bdeda175088164d7066324f5048e53d03ab8a0c5ed4283f316' },
  'lib/libopenvino_intel_cpu_plugin.so': { bytes: 63770033, sha256: 'd9228361a5cc224734b18a788bcfedd7d49606fa92aa88719119f481d36a23cb' },
  'lib/plugins.xml': { bytes: 172, sha256: '88406eb6e5a16c4aee998b61343c6b56e6d09bb6ece2de12ac190452c661cf9b' },
  'lib/libtbb.so.12': { bytes: 369313, sha256: 'ac9518497a4f2cb6729792730f145ee58367316031511923fef263c9ac81ca61' },
  'lib/libtbbbind_2_5.so.3': { bytes: 33025, sha256: '179ebd1223abd20a461dc978f24090d7ef7c1308b8dff14e4adfe4a21d75543f' },
  'lib/libtbbmalloc.so.2': { bytes: 159729, sha256: '0cccbdb4783bf190da19b34540fb7f749b0955ec1982d7ac8e5f398365399895' },
  'lib/libtbbmalloc_proxy.so.2': { bytes: 28377, sha256: 'ecd654634c8a40fe45850c230e2fdbead674c4a1d6a54e89c117e919b61a6df0' },
  'lib/libhwloc.so.15': { bytes: 473321, sha256: 'e91be9f5bc1c87aadb08f2e19ebcb742979adda0a5434f72650a154e317e7fb1' },
  'lib/cache.json': { bytes: 8840377, sha256: '0b2ad2a99516a3411ce3fef274e8ae2880b41a6f00c9bac6768cd4a94b87c41c' },
  'lib/libcrypto.so.3': { bytes: 6386528, sha256: '5385f0436ac2e284ba8c5fb1488874057c29c04be72dea32add832694f381e28' },
  'rife.xml': { bytes: 335754, sha256: '7b5e8df0dc32b206569b81c1e69a65269ece571420005a989679dd523f8d0fe3' },
  'rife.bin': { bytes: 22643376, sha256: 'c166cc6df78e76a50950c26988c64c30dc33e1e5867a3ebcb4cb4e630a8afaa9' },
  'rife_warp.cl': { bytes: 1346, sha256: '46c8ac6b107493c1796ffc176b452027e48ba8b64f689ca62f9396f377134d1d' },
  'rife_warp.xml': { bytes: 455, sha256: 'ed9f0c618f3b85633162f4b215ce5254edc6e83094e6997d7b058554784b292c' },
  'LICENSE-ONE-TRACK-CAT.txt': { bytes: 35149, sha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986' },
  'LICENSE-OPENSSL.txt': { bytes: 11358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  'LICENSE-OPENVINO.txt': { bytes: 11357, sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4' },
  'LICENSE-RIFE-MIT.txt': { bytes: 1066, sha256: 'f629619f078e3ed699f1ea401248cb7796c36334e3b8ec0eb2c082eceaa5f084' },
  'LICENSE-FLASHVSR-APACHE.txt': { bytes: 11357, sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4' },
  'NOTICE-FLASHVSR.txt': { bytes: 1357, sha256: 'ec6e1c26b98786194119b94cf645470a573d0cb4a04158722564e9045dec1157' },
  'NOTICE-FLASHVSR-PROVENANCE.json': { bytes: 2743, sha256: 'f442a765092a003af5e432dce25cfc717b4fde56facb036514b85602f30e1c1f' },
  'NOTICE-OPENSSL-UBUNTU.txt': { bytes: 2543, sha256: '6a7da622fe0637a334d2a8fc470852d2ffb77d9a2b2f930f854e32a41ad6ef35' },
  'NOTICE-OPENVINO-ONEDNN.txt': { bytes: 28475, sha256: 'f1b16991dfe8488f3f5f07cccba575c31c91175a9f2c8d9e1569665f86e0b2f6' },
  'NOTICE-OPENVINO-RUNTIME.txt': { bytes: 120451, sha256: 'caf4040a8c3043c9fdc7638ccc61078b40ce623e69e3bcd2bc544ae70a368b2f' },
  'NOTICE-OPENVINO-TBB.txt': { bytes: 46979, sha256: 'b10997cc50652ba6ab365e3bc43e13057681cd4a56533b46171529bd249749f3' }
}

// Keep the runtime inventory stable even though the GPU plugin has dynamic
// source-build bytes and therefore is not in payloadPins.
export const runtimeLibraryNames = [
  'libopenvino.so.2650', 'libopenvino_ir_frontend.so.2650',
  'libopenvino_intel_cpu_plugin.so', gpuPluginPath.slice(4),
  'plugins.xml', 'libtbb.so.12', 'libtbbbind_2_5.so.3', 'libtbbmalloc.so.2',
  'libtbbmalloc_proxy.so.2', 'libhwloc.so.15', 'cache.json', 'libcrypto.so.3'
]

export const modelNotice = [
  'FlashVSR+ source model: ruchangyao/FlashVSR_plus, revision',
  '46b79520946ac67dec94d1566490690953c7debc.',
  'Prompt source: OpenImagingLab/FlashVSR_Plus, revision',
  'b548a2cc2c929d3d4676f2973abe27876ec4dee7.',
  'Turbo and Base bulk learned safetensors are downloaded and prepared by the',
  'application; no bulk checkpoint payload is included in this pack.',
  'The fixed conditioning BINs are small learned-derived BF16 artifacts,',
  'with their exact provenance pinned separately.',
  'RIFE v4.25 packed-7 assets are retained from the reviewed existing IR.',
  'This optional pack does not claim full-video quality or arbitrary-geometry support.'
].join(' ')

export function matchesReleaseProvenance(record) {
  return Object.entries(releasePins).every(([group, values]) =>
    Object.entries(values).every(([key, value]) => record?.[group]?.[key] === value))
}
