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
