OpenVINO reorder-cache GPU plugin recipe
=========================================

This directory contains the small source patch used by the FlashVSR+ worker's
process-private executable reuse, enabled by the default AI-pack recipe.
The source identity is intentionally
pinned: with no `--source`, the builder creates
`dist/ai-pack-cache/openvino-source` using a filtered clone, fetches the exact
commit, and initializes the required GPU submodules.  It never accepts an
arbitrary binary override.

Pinned inputs
-------------

* OpenVINO source commit:
  `7d81aad55a539c827049ac9628ba4f8d5abb4539`
* OpenVINO build identity: `2026.5.0-23457-7d81aad55a5`
* SDK wheel: `2026.5.0.dev20261014` (the artifact and SHA are read from
  `scripts/ai-pack-pins.mjs`)
* GPU runtime: OpenCL (`GPU_RT_TYPE=OCL`)
* Checked-in patch: `reorder-cache.patch`

The builder verifies the source commit, rejects unrelated tracked or
untracked changes, checks the initialized GPU-build submodule revisions
against the source gitlinks, and applies only this patch to a disposable
staging copy.  A pristine checkout and a checkout whose only tracked change
is exactly this patch are both accepted.  It does not inspect or use the
research worktree or any private absolute path.

Preparing a source checkout
---------------------------

An explicit source checkout is useful for offline/reviewed builds.  Use a
disposable checkout and verify the revision before invoking the builder.
Recursive submodule initialization is required; the builder then checks the
GPU-build submodules itself.

    git clone https://github.com/openvinotoolkit/openvino.git openvino-reorder-cache
    git -C openvino-reorder-cache checkout --detach \
      7d81aad55a539c827049ac9628ba4f8d5abb4539
    git -C openvino-reorder-cache submodule update --init --recursive
    git -C openvino-reorder-cache rev-parse HEAD

Omitting `--source` performs the equivalent pinned fetch into
`dist/ai-pack-cache/openvino-source`; it does not follow a branch or accept a
different remote revision.  An existing canonical directory is validated and
is never replaced automatically.

Build
-----

The pinned wheel must already be authenticated and extracted by the pack
recipe when `--sdk-root` is supplied.  The output is a new regular ELF file;
the adjacent `.buildreceipt.json` records the actual output SHA and size,
source/patch/submodule provenance, compiler versions, build flags, and wheel
pin.  A rebuild is not expected to retain the historical qualified plugin
SHA.

    python3 scripts/build-openvino-gpu.py \
      --source /path/to/openvino-reorder-cache \
      --sdk-root /path/to/extracted-sdk \
      --build dist/ai-pack-cache/openvino-gpu-build \
      --out dist/ai-pack-cache/artifacts/libopenvino_intel_gpu_plugin-otc-reorder-cache.so

The build is deliberately limited to the `openvino_intel_gpu_plugin` target,
with non-GPU plugins, frontends, bindings, samples, and tests disabled.  It
uses two build jobs. The fetch includes xbyak (configured by upstream even in
GPU-only builds) and the pinned OpenCL loader fallback, not just GPU headers.
The caller must run it under an external memory limit of
at most 6 GiB (for example, a constrained build VM/container); the recipe does
not attempt to reset or reclaim host resources. The build prefers system OpenCL
development files, with the pinned source loader as upstream's fallback, and
uses the extracted SDK TBB configuration when `--sdk-root` is
given; the TBBBind static fallback is disabled so configuration does not fetch
an unpinned dependency.  The final plugin has only `$ORIGIN` RUNPATH, so its runtime libraries
must be staged beside it or otherwise be available through the normal system
loader policy.

Relocating the historical qualification artifact
--------------------------------------------------

For a local, authenticated migration of the historical A770 artifact, the
optional `--from-plugin` mode accepts only the SHA recorded in
`native/ai-enhance/flash-assets/flash_attention_provenance.json`, removes its
private build RUNPATH, sets `$ORIGIN`, and emits a new receipt.  The resulting
SHA is a new artifact identity and still requires fresh qualification before
publication.

    python3 scripts/build-openvino-gpu.py \
      --from-plugin /path/to/libopenvino_intel_gpu_plugin.so \
      --build dist/ai-pack-cache/openvino-gpu-relocate \
      --out dist/ai-pack-cache/artifacts/libopenvino_intel_gpu_plugin-otc-reorder-cache.so

This mode is not a substitute for the source recipe and does not make the
historical timing receipt a shipped-product claim.

License and source availability
-------------------------------

OpenVINO and this narrow source change remain available under the upstream
Apache-2.0 terms.  Keep the upstream source URL, exact commit, patch, and
third-party notices with release provenance.  Do not distribute the private
research checkout or its build tree as a dependency of the application.
