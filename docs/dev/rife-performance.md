# RIFE frame-rate conversion

RIFE fills missing output slots; it must not reconstruct frames already present.
For interpolation without spatial upscaling, render the timeline directly at the
output rate and replace repeated slots only inside lower-rate video segments.
Explicit freezes remain holds. With Flash, keep the input rate so Flash does not
process additional frames; retain inputs at their nearest output slots instead.
This quantizes timestamps by at most half an output frame without changing the
video duration or audio timing.

The authenticated RIFE v4.25 model uses explicit FP16 convolution blocks, with
FP32 motion coordinates and warps. A global FP16 inference hint is unsafe in the
pinned OpenVINO runtime: identical UHD inputs produced different output pixels.
Do not replace the explicit graph boundaries with that hint.

The small `rife_warp` kernel implements only this model's FP32, bilinear,
border-padded, align-corners sampling. Its contiguous-X dispatch replaces the
reference kernel's expensive channel-first dispatch. The worker validates all
five warp attributes and authenticates both kernel files with compiled-in pins.
It uses the existing sealed-source/private-config mechanism. Other models and
CPU inference do not use this kernel. RGB byte inputs avoid uploading seven
full FP32 image planes; normalization and planar packing run on the GPU.

## B580 validation, 2026-10-24

- 3840×2160, distinct moving source frames, interpolation fractions 0.25/0.5/0.75.
- Original full-FP32 benchmark: approximately 1.0–1.1 seconds per inference.
- Optimized GPU inference: approximately 0.18–0.20 seconds, excluding host output
  conversion; actual `RifeSession::infer`: approximately 0.214 seconds warm.
- Repeated RGB outputs identical; compared with an independent FP32 reference,
  maximum difference one 8-bit colour level on tested moving frames.
- Stream check: 50 supplied 4K frames →60 output frames; all 50 originals retained
  byte for byte. Eight missing slots needed inference; identical image pairs
  avoided two more calls. Cold stream wall time included compilation, decoding,
  and SHA-256 checks and is not an inference benchmark.

Raw diagnostics are kept locally under `dist/rife-diagnostics`. Early
`pair.rgb` measurements used identical frames caused by FFmpeg output resync;
the `moving-*`, `session-quality`, and `pipeline-check` results supersede those
for quality validation. Rawvideo diagnostic extraction must explicitly select
`-fps_mode passthrough`; its implicit output synchronization can differ from
`framemd5`. Production's bounded decoder already selects passthrough.

## Streaming export validation, 2026-10-31

RIFE now fills only intervals **shorter than 0.5 seconds**. At half a second
or above (with 1 ns tolerance for timestamp rounding), keep the preceding recorded frame until the next real frame's slot;
never turn missing footage into a long morph. Scene cuts and exact endpoints
remain intact. This also applies to genuinely sparse source clocks.

The worker borrows retained frames for duplicate checks and output instead of
copying unchanged UHD buffers. A two-frame writer overlaps output backpressure
with inference; shared ownership keeps queued pixels alive after the input
window advances. Cancellation drops queued output, joins the writer, and
propagates errors. RIFE hardware is reported on activation rather than every frame.
The decoder-to-worker relay has a bounded 32 MiB high-water mark and is explicitly
unlinked before cancellation closes GPU stdin. Model precision is unchanged.

Two 60-second 3840×2160 VFR samples were selected from a 61-minute timeline.
Their measured interiors contain 482 missing 60-fps slots and 200 long-gap
slots, versus 482.6 and 201.1 expected from the full sources' timing tables.
Both used the real sources, the project's fade graph, B580 RIFE and AV1 encoding,
and iGPU decoding. Each process group was capped at 6 GiB RAM, without swap.

- Sample wall times, including startup/finalization: 123.05 s and 95.74 s.
- Combined steady processing: 1.741 wall seconds per video second.
- Full-timeline projection: approximately 106 minutes, plus final remux overhead.
  This is an estimate from short samples, not a full-export measurement.
- Peak process-group RAM: approximately 3 GiB; no GPU faults or OOMs observed.
- Before changing hold policy, the copy/queue optimizations produced a
  byte-identical 30-second MP4 to the original path (95 s →73 s).

Larger kernel pipe buffers, direct shell transport, and GPU RGB-to-NV12 conversion
did not give useful improvements and were left out. Raw short-run reports and
CPU profiles are under `dist/rife-optimization`; no whole-video benchmark was run.


### GPU byte output

RIFE also packs its output on the GPU: a UHD frame returns ~25 MB of RGB bytes
instead of ~100 MB of planar floats plus host conversion. A 256-entry threshold
table preserves the existing double-based half-up byte rounding at every f32
boundary. The visible crop precedes conversion and finite checks. Finite checks
reduce independent rows, then validate the small boolean mask on the host;
a single whole-image reduction was 1.53 seconds, versus 0.30 ms for rows.
The model's mixed precision and FP32 motion warps are unchanged.

CPU fixtures cover every byte boundary and both adjacent f32 values, subnormals,
NaN/infinity, channel/row layout, and invalid padded pixels outside the crop.
The same fixtures passed on B580 with the production Accuracy/dynamic-precision
properties. The GPU plugin's default precision did not preserve boundary bytes;
production properties are required. The native worker now also rejects early
input EOF immediately instead of repeating the last frame until the output
contract ends, making cooperative pipeline cancellation promptly release it.

A paired 30-second export improved 56.54 s →52.55 s (7.1%), with byte-identical
MP4s. Worker user CPU time fell 35.19 s →29.85 s (15.2%); total pipeline CPU use
changed little because decoding, colour conversion, and encoding remain.
Raw per-layer profiles, byte-boundary harness, and reports remain under
`dist/rife-optimization`. Profiling instrumentation is not shipped.

The two representative 60-second samples then improved 123.05 s →102.16 s and
95.74 s →89.99 s. Both resulting MP4s were byte-identical to the previous
half-second-guard build. Combined steady processing was 1.542 wall seconds per
video second: approximately **94 minutes**, plus remux, for the 61-minute project
(previous projection 106 minutes). This remains a subset-based estimate, not a
full export. Peak process-group RAM was 2.6 GiB, with no new GPU faults/OOMs.


### Live editor qualification caveat

The subsequent full editor export used the new worker (SHA-256
`9e9f6a4b0e52a7f4834b1e16a055fb08f7ae163cde6b4bc24d922a7693527e46`),
but passively measured approximately 28–30 output fps, projecting 124–133
minutes if sustained. The 94-minute subset estimate is therefore not a claim
that the full editor meets two hours. The isolated harness omitted the complete
two-input join graph, concurrent AAC output, Electron relay/IPC and production
FFmpeg allocator settings. Future wall-time comparisons must include these.
A tiny CPU graph audit ruled out whole-timeline 4:4:4 promotion: only the xfade
inputs are promoted, and its output returns to 4:2:0 before concat. No cosmetic
pixel-format change was added. The running export was not stopped or modified.

### Full Electron production qualification, 2026-10-31

The representative comparison was repeated through the full Electron export
path, including both source inputs, the join graph, AAC, and the native RIFE
worker. Three baseline and three production-pool MP4s were byte-identical by
case:

| Case | Baseline wall | Production-pool wall | SHA-256 |
| --- | ---: | ---: | --- |
| 0 | 125.1826 s | 84.1251 s | `5cc6d9f861be5c8ecd36f046049dc31f0bb1b9c2ea3d48bb360a52f4b20db5e9` |
| 1 | 124.7823 s | 97.1832 s | `d75daf28fc4d6750ffb6069fe7659558ba218d3f42d78c42b05e6cd2ab013296` |
| 2 | 115.3008 s | 86.1326 s | `3050e6744c6959fa7ac49f216f434a2c979c787918d3e74012529e9fa1b8a36e` |

The weighted harness result (`dist/rife-optimization/production-harness/weighted-results.json`)
projects the baseline at **118.3656 minutes** and production-pool at
**86.1094 minutes before final remux overhead**, a **27.251% reduction**. The
baseline projection is calibrated against the actual 117.84-minute game2
export. This full-path result supersedes the earlier subset-only timing as the
representative performance evidence; the earlier 106- and 94-minute numbers
remain historical short-sample estimates.

On Linux, the generic face pipeline shares the first decoder's stdout file
descriptor with the next pipeline child. Only that direct first decoder gets
the scoped FFmpeg allocator profile: 2 arenas, a 32 MiB mmap threshold, and a
64 MiB trim threshold instead of the ordinary 128 KiB thresholds. Other
FFmpeg children and ordinary jobs retain the default profile, and the copied
environment does not mutate Electron's `process.env`.

The native input pool caches at most two free frame-sized buffers (64 MiB
maximum), in addition to the live window/writer frames. Only exact-size,
unmodified input is eligible; resize, Flash, and other transformed inputs use
the fallback allocation path. The scoped allocator is
not a universal memory reduction: on the 4K 33-cut/353-compact-caption
qualification, peak process-group memory rose from about 5.2 GiB to 5.5 GiB
(approximately 6%) while allocator syscall churn fell substantially.

Additional B580 checks produced byte-identical MP4s for ordinary GPU encoding,
the actual two-second overlap join, and the long source hold. Cancellation
through the editor IPC left no published output or device holders. The regular
suite passed all 1,852 checks, all 43 native CPU checks passed, and the real CPU
AI-pack suite passed seven integrations plus its five stream smoke checks.
