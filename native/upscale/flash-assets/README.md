# FlashVSR+ structural assets

These are fixed, CPU-generated OpenVINO structural assets for the qualified
4096-row BF16 POST graph. Learned tensors remain Parameters and are appended
by the native authenticated preparation table; these files contain no learned
checkpoint payload.

The selected graph is `flash_post_4096_bf16.xml`, with its two private BF16
Result barriers intact. `prepareFlashPostModel` verifies the fixed ABI and
FFN2 chain, then replaces just those Results with the two qualified owning
Assign sinks in memory. This avoids the stock IR reader's assumption that
every serialized Assign has a matching ReadValue. No feedback, new numeric
conversion, or computation is introduced. The two state owners retain their
full memory charge. The original Assign-only IR is a reproduction artifact,
not the selected load format.
The custom-layer XML uses only relative filenames and the checked-in CL files.

Research regeneration used the pinned POST bridge/precise helpers. Runtime
pack generation must consume these files
and must not import the research helper tree.

Historical provenance (2026-10-17): source commit `b548a2cc2c929d3d4676f2973abe27876ec4dee7`,
model revision `46b79520946ac67dec94d1566490690953c7debc`, and the preparation
helper snapshot used `seedvr_prepare.cpp` SHA-256
`3ccac29048e34e3407d455a11e34a9ff9ac1a12a5567e637bab26dd58fc36b16` and
`seedvr_prepare_detail.hpp` SHA-256
`8a9009511274af263251578e49845b6c33bdce0d23dc67de5444d247985ef0fa`.
Those are historical filenames and hashes; the current shared helpers are
`model_assets.*` and `model_prepare.*`.
The generator is `scripts/prepare-flash-post.py` and uses the native build-only
BF16 converter. Its fixed XML SHA-256 is
`1de0453729011b0d6e61f43a993e04b559fe27c3aa0e4894c69cf42f3afc3d37`;
the structural BIN is unchanged. This selects a portable representation, not
a different learned checkpoint or precision policy.
That historical generation's combined header SHA-256 is
`6ade2f94ecac684932d180d0ae9e61624e696a61f7e224f7c21acfa15ea52119`.
It passes a C++17 syntax-only check including 30 Turbo plans, 30 Base plans,
and 13 bindings.

The checked-in shared-source identity is `plus_sparse_xmx.cl` (34017 bytes,
SHA-256 `5062adc6e4810d5c203334149d088b4bca64aa7f5a5b5757f348eed3de546b8d`);
the accepted worker used the 33942-byte baseline source SHA-256
`65a557d9d0124520d260dfbfd6fd05e802aad54f8aaa659fc7463b2268b5327d`. The
checked-in source differs only in comments: it removes the cache-only trial and
product-name wording, states capability-based selection, and states the
canonical 16-work-item versus scalar-subgroup split-partial 128-work-item
geometry.
The XMLs are canonical `plus_split_key.xml` (1272 bytes, SHA-256
`56ea1ebe718ab3e22122118729e7bf0874b20bb4e12a23160f529c93d6b34d84`) and
capability-selected `plus_split_key_dg2.xml` (1270 bytes, SHA-256
`1ddc0bf1fde271d3173b750316b61008a9fcf51be7328c689c05be5f4e9b44b4`). The
canonical XML is preserved for the SIMD16/2D path; the DG2 split-partial entry
uses 128 work items while its merge entry remains 16, with SG8, 49,152 bytes of
SLM (16 KiB K/V plus 32 KiB Q), and 256-GRF with no spill. The source keeps the
historical `OTC_A770_SG8` macro spelling for exact-source provenance; its
automatic selection is based on the missing 2D block-I/O capability, not a
product-name test. On the host side, the single `flashUsesPackedKv` helper
admits the reviewed Gen12 family through OpenVINO's `uarch_version` property;
it is an architecture proxy, not a general OpenCL-extension query. These two
choices agree on the qualified A770/B580 devices. The geometry and receipt are scoped to the tested
Intel Gen12 A770. The long4 metadata workaround preserves the JIT-provided
layout values while allowing fixed-index metadata reads to fold.

The accepted full-worker A770 vectorcache 1050 variant receipt used worker SHA-256
`9a53e0e8dcb3eed5afc2cc3d161e7599514607dd3dc0ecc86d28e7b373ae0045` and the
exact patched OpenVINO GPU plugin SHA-256
`76f189d18c38760ee2cfb7b32fc507cb06cbdde7e66554103203cb2261dc46d8`. Across
45 frames, Turbo took 248.901700135 s (5.5311488919 s/frame) and Base took
450.278758833 s (10.0061946407 s/frame); both 1119744000-byte outputs were
byte-identical to their same-mode canonical baselines. This receipt requires
the compiled model cache and patched plugin and is not a current installed-app,
shipped-pack, or product-throughput claim. No other-device or B580 qualification
is claimed.
Earlier source and worker measurements remain under the historical records in
`flash_attention_provenance.json`.

The PRE pair `flash_pre_4096_bf16.xml/.bin` is a separate structural export
from `scripts/export-flash-structure.py`; its provenance records the 15 exact
graph-builder source hashes. The 768-byte BIN contains only small structural
constants, not learned tensors. Two fresh exports are byte-identical, with
13 Parameters, 18 Results and no state nodes.
The native PRE wrapper now verifies that ABI and recreates only its six
owning BF16 Assign barriers. PRE and POST share request/weight-bank handling,
but retain their separately qualified precision policies. The build-time
generator's `--stage pre` option emits the nine-weight plans for both modes.
All 60 prepared PRE layer BINs (540 learned spans) were independently checked
against the external source checkpoints with a separate NumPy BF16 RNE
implementation. A finite B580 Turbo PRE component test matched all 90 output
arrays from the Python reference, including ABA and input-preservation checks.
This did not qualify Base or the full video pipeline at that historical stage.
Both PRE and POST are now used by
the FlashVSR+ export path.

The three `flash_lq_projection_*_bf16.xml/.bin` pairs are build-only exports
from `scripts/export-flash-projection.py`. Their small BINs hold structural
constants only; the 3/3/5 learned weights for startup/prefix/suffix stay external.
Two fresh exports are byte-identical. The serialized graphs pass the stock IR
reader and native ABI/hidden-state/precision checks without compiling a device.
The prefix input is named `old_cache1`, distinct from its `cache1` output, so
the IR reader cannot silently rename it. `flash_lq_provenance.json` records the
builder/exporter hashes and working geometry (2176×3840, visible 2160×3840).
The fixed-UHD native LQ component now matches the constant-weight Python
reference byte-for-byte in Turbo and Base across startup and three consecutive
groups. Non-finite rejection, failed-session reuse rejection, and zero final
tracked GPU allocations passed. Other geometries and a complete export worker
remain unqualified.
The data graphs stay unchanged: a separate weight-free GPU request checks
their completed BF16 output roots. An inline finite-predicate fanout left the
LQ cache Results unwritten on the pinned runtime; using a Boolean mask with
staged ReduceMin in the separate request avoids both that issue and the slow
monolithic logical reduction. This is a workaround, not a proven core fix.
Startup retires before steady-stage compilation. The largest observed
allocation snapshot fell from 8,659,360,924 to 5,790,325,844 bytes; neither
number is a continuously sampled physical VRAM peak.
Both modes' three prepared LQ BINs (22 learned spans total) were independently
compared with the original F32 checkpoints using chunked NumPy BF16 RNE.
The native structural test authenticates the fixed asset pins before parsing.

The three `flash_decoder_phased_*_bf16.xml/.bin` pairs contain the fixed UHD
TCDecoder front, tiled growth-history stage, and tiled frame-child stage.
The working frame is 2176×3840; growth/frame stages use 16 tiles with a 12-row
halo. These are structural graphs, not the learned decoder or a full worker.
The native reader authenticates the assets before role validators check their
exact names, shapes and types;
growth's `grow_weight` and frame's `frame_grow` are dynamic child-bank inputs,
not static `weight__` bindings.

`scripts/prepare-flash-decoder.py` authenticates the original `TCDecoder.ckpt`
(189,018,333 bytes, SHA-256
`e224bdcf2f52745cbf4d393ff5374c2ba09e90285d5d19062d2bf63b915b6161`)
and emits the compiled preparation table. The native preparer reads fixed raw
F32 spans from that authenticated file and converts them to BF16 with
round-to-nearest-even. It needs no runtime ZIP/pickle parser, Python, Torch,
or separate derivative checkpoint. Its three managed BINs include 64 static
bindings and four child-bank slices; learned payloads are not checked in.
All prepared spans and structural prefixes were independently byte-compared
with NumPy conversion of the original checkpoint. CPU structural/preparation
checks do not establish native UHD inference, full-video quality or throughput.
