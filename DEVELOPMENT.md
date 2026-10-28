# OneTrackCat development

This document is for contributors working on OneTrackCat. The user guide is in
[README.md](README.md). Commands and implementation notes describe the current checkout;
run the commands yourself before reporting a build or test result.

## Supported development environment

OneTrackCat is developed and tested on Ubuntu 26.04 with GNOME on Wayland. Use Node.js 22.22 or
newer and npm 11.18.x. Python 3.11 or newer is needed for catalogue-generator tests. A C++17
toolchain and CMake are additionally needed to build the optional face and Upscale packs.

Install JavaScript dependencies and start the desktop app in development mode:

```bash
npm install
npm run dev
```

The development launcher prepares the local media pack and installs the development desktop
entry when needed. Development does not require Docker or `sudo`.

The scoped `@electron/get` override keeps the packager's proxy support on
`global-agent` 4, without the vulnerable `roarr`/`sprintf-js` dependency chain.
Keep it until the packager updates its downloader; verify proxy setup and
`npm audit` when changing it. Exact pins and the seven-day release delay remain enabled.
Package lockfiles are disabled and ignored. Keep direct dependency versions exact and run
`npm audit` after installation: indirect dependencies can change between installs.

Test commands group short result names by suite, with colored status marks and no live redraws.
Vitest, Playwright, Python and maintainability checks use the same indented status rows
and `Results: N passed, N failed, N skipped` footer, without dashed separators or timing banners.
`npm test` also prints a grand total of completed suites (including maintainability checks).
The run count excludes skipped tests; an early command failure is marked as an incomplete run.
Suite headings and test labels use sentence case; keep acronyms and code identifiers intact.
Use a short behavior phrase for each test and put repeated context in a `describe` group,
not in every test name. File headings replace filename separators with spaces.
Use `FORCE_COLOR=0` to disable colors. Failure details and HTML reports remain available.
Unexpected console errors and warnings fail unit tests; passing tests do not print debug logs.

## Useful commands

```bash
npm run lint
npm run typecheck
npm run test:vitest
npm run test:e2e
npm test
npm run build
```

`npm run test:vitest` runs Vitest with coverage and the maintainability checks in
`scripts/quality.mjs`. `npm run test:e2e` builds the Electron application and runs the Playwright
suite through the headless Wayland launcher. `npm test` runs linting, TypeScript checks, Vitest,
quality checks, media-pack build and verification, and the Wayland Electron tests.

Ordinary tests use tiny generated media and need no AI packs, downloaded models, private
projects, or GPU. HEVC seek checks run by default. After building both AI packs, run
`npm run test:packs` for the seven CPU integration checks: cached face styles and Replay,
known-face export/cache reuse, and tiny RIFE export with audio and metadata checks.
These are mandatory in release CI and fail if their pack prerequisites are missing;
there are no opt-in skip flags. The face export fixture is the pinned public NASA image
prepared by face-pack verification. Full-resolution GPU performance experiments are not
part of the automated test suite.

The preview audio checks use PulseAudio or PipeWire. The headless launcher preserves an available
desktop audio connection; set `PULSE_SERVER` explicitly for another server. These checks record
only the editor's mix and output silence. They are skipped when no audio server is available;
the unit tests and FFmpeg audio-boundary tests still run.

Focused tests can be run with Vitest, for example:

```bash
npx vitest run src/main/face-preview.test.ts src/renderer/src/model/use-face-preview.test.tsx --no-coverage
```

The repository may contain unfinished work while several contributors are working. This file
does not claim that the current checkout passes any of these commands.

## IMKG meme catalogue

The app bundles a small metadata index of captioned images from the
[IMKG project's original ImgFlip data](https://memes.science/). It does not bundle the images
or load the full graph. The index is loaded only when image search needs it; preview/import
uses the original Imgflip image. Existing captions are part of that image, not editable text.

To regenerate `src/main/imkg-catalog.json`, download the public
[ImgFlip archive](https://owncloud.ut.ee/owncloud/s/mFdPCY2mWdQLZ7Q) and run:

```bash
python3 scripts/build-imkg-catalog.py /path/to/imgflip-08_07_2022.zip src/main/imkg-catalog.json
```

The current 114,369,670-byte archive has SHA-256
`6523b96005fd36bcd363f680fe5cc40cdbcee7ca9a8bd703dddca7ef7799b8f1`.
The generator streams its JSON instead of loading the 660 MB member into memory. It keeps
up to three distinct, highest-voted captioned examples per template, using views and image ID
to break ties. Only names, captions, safe image URLs and instance IDs are retained. This is a
representative catalogue, not a search over every IMKG instance. Regeneration is a developer
step, not part of app startup or the ordinary build. Run `npm test` after changing the index.

The index's provenance is recorded in the JSON and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
IMKG's license does not replace the separate rights in the linked meme images.

## Release build

Build the AppImage and the public media pack with:

```bash
npm run package
```

The release output is written to `release/`. The package script builds the media pack, prepares
the FFmpeg bundle, builds the Electron application, creates the AppImage, and places the media
pack beside it. `npm run build` only creates the Electron build output.

The optional face pack is built and verified separately:

```bash
npm run build:face-pack
otc_CPU_ONLY=1 npm run verify:face-pack
```

The face-pack builder uses a build-only Python 3.11 virtual environment with pinned conversion
dependencies. It downloads or checks pinned model sources and an OpenVINO runtime, builds the
native C++17 helper with CMake, runs native tests, and creates `release/otc-face-pack.zip`.
Set `otc_FACE_PYTHON` to select a Python 3.11 executable. The build cache and generated
pack live under `dist/`; they are not application source files.

The generated face-pack directory contains the launcher, native helper, selected OpenVINO
libraries, a manifest, the model-source catalog, and license/notice files:

```text
dist/face-pack/
├── otc-face-blur
├── otc-face-blur.bin
├── sources.json
├── lib/
└── manifest.json
```

The build directory also contains the pinned `model.xml` and `model.bin` used for CPU
verification. They are not included in the runtime archive. On first use, the app downloads
those files from `sources.json` into a private user-data directory, verifies them, and reuses
them for later projects. Existing face packs with bundled weights remain supported offline.

`npm run verify:face-pack` checks the manifest, hashes, archive paths, executable bits, native
runtime dependencies, model provenance, licenses, and the optional known-face smoke fixtures.
When fixtures are available, the verifier runs the smoke test with the CPU device.

## FFmpeg selection and packaging

Development looks for FFmpeg in this order:

1. `/usr/bin/ffmpeg`
2. `/usr/local/bin/ffmpeg`
3. `dist/ffmpeg-vaapi/ffmpeg`
4. The pinned `ffmpeg-static` package binary

Run `npm run build:ffmpeg` to download the pinned FFmpeg build into `dist/ffmpeg-vaapi/` and
verify that it contains the required software and VAAPI encoders. Packaged applications use the
FFmpeg copied into the AppImage resources; the release build also includes `ffprobe`.

The AppImage is therefore self-contained for its normal media-processing tools. Development may
use a system FFmpeg when one is present, which makes it important to test the packaged build
separately when preparing a release.

## CPU-only validation

Set `otc_CPU_ONLY=1` for deterministic CPU-only development and validation. The flag:

- disables Electron hardware acceleration;
- restricts encoder discovery to the software encoder; and
- selects CPU face inference instead of the automatic device path.

The face-pack builder and verifier set this flag for their build and smoke-test subprocesses.

## Face processing architecture

The ordinary editor preview is intentionally unprocessed. A rendered face preview or export
composes the timeline first, then sends RGB24 video frames through the face worker and encodes
the masked frames once. Audio is processed separately and muxed with the completed video. The
pipeline uses bounded streams and drains the worker during cancellation so a worker holding a
GPU context can exit normally.

The face worker receives effect rows describing start/end time, sensitivity, face-size detail,
hold time, strength, and style. The optional pack supplies the native helper, OpenVINO libraries,
the model-source catalog, and provenance/licence metadata. The current runtime archive does not
ship model weights: first use downloads them into the private app-data directory and verifies
them before processing. Existing bundled-weight packs continue to work offline.

### Two different caches

OneTrackCat has separate caches for encoded whole-video previews and face detections:

- The completed whole-video preview cache is an in-process cache. Its key includes the source,
  composition, face settings, face-pack files, and relevant input file stamps. A matching complete
  preview can be stream-copied into an export without repeating the full encode. Partial selected
  previews are never published as whole-video cache entries.
- The detection cache is persisted below the app's user-data directory as
  `face-preview/detections.cache` and is bounded to 64 MiB. A job stages its output in a temporary
  directory, validates the bounded records, and atomically publishes the result only after the
  source/settings key still matches. Selected previews and later exports can reuse these raw
  detections with the appropriate composed-timeline frame offset during the current app session.

Both caches are invalidated by source, composition, detection-setting, or face-pack changes.
Changing only masking style, strength, or hold time keeps raw detections reusable, but requires
rendering the new appearance. A cancelled or incomplete job must not publish either cache.
Starting a successfully opened new project or resetting the saved project removes the app-owned
preview and detection files. Canceled/failed opens and saved-session restore retain them. Cleanup
is skipped while preview/export work owns the cache.

## Upscale export

Upscaling applies to the whole composed export, not a selection or saved
editing state. The dialog selects Off, FlashVSR+ Turbo (default when enabled),
or Base. Spatial restoration supports 3840×2160 or 2160×3840 output on an Intel
discrete GPU; other aspect ratios are explicitly unavailable rather than silently
stretched, cropped, or passed to an unqualified backend. RIFE-only interpolation
supports the existing canvas geometry and can fall back to CPU. The plan never
shrinks an already larger canvas or lowers its frame rate.
For portrait spatial work, the worker rotates the RGB input into the fixed
landscape Flash/RIFE pipeline, then rotates each output back. Pixel coordinates
are permuted, not cropped or stretched; the shared model graphs stay unchanged.

Build the optional native pack separately on Ubuntu 26.04:

```bash
npm run build:upscale-pack
otc_CPU_ONLY=1 npm run verify:upscale-pack
otc_CPU_ONLY=1 node scripts/smoke-upscale-pack.mjs
```

The standalone sparse-attention numerical gate is CPU-only by default and does not query a
device. Run its reference self-check with the checked-in kernel source:

```bash
python3 scripts/test_flash_attention_gpu.py --kernel-root native/upscale/flash-assets
```

Run the GPU variants manually only on a freshly idle, explicitly owned Intel device; choose
exactly `A770` or `B580` and add `--run`:

```bash
OCL_ICD_VENDORS=/etc/OpenCL/vendors/intel.icd python3 scripts/test_flash_attention_gpu.py \
  --kernel-root native/upscale/flash-assets --run --expected-device B580
```

This is a focused kernel regression gate, not a full export or throughput qualification, and is
not part of standard CI.

The reproducible recipe uses reviewed versioned FlashVSR+ graph XML, structural
complements, published positive conditioning, qualified RIFE IR and notices. It
authenticates the pinned OpenVINO 2026.5 development wheel and matched Ubuntu OpenSSL
development/runtime packages, builds the C++17 worker with CMake, runs native
tests and creates `release/otc-upscale-pack.zip`. Python is build-only standard-library
tooling; Python, PyTorch and original learned checkpoints are not shipped. Accepted
graph bytes and generated native authority are reused; ordinary builds do not
re-run the laboratory exporter. Rebuilds use unique staging and preserve previous
generated outputs as backups. Directory/archive publication is not one atomic
transaction, and a failed build must not be treated as a verified pack.

The GPU plugin additionally needs the descriptor-import fix in
`assets/openvino/reorder-cache.patch`, at the exact runtime source revision.
`scripts/build-openvino-gpu.py` documents a source-build path and accepts only
the authenticated historical binary for the relocation fast path; see
`assets/openvino/README.txt`. A known authenticated relocatable binary is the
local fast path (`--gpu-plugin FILE` selects only that identity). Without it,
the recipe builds the exact source/patch against the pinned SDK, then embeds
that output's size and SHA-256 into the worker at configuration time. Rebuilds
need fresh qualification; bit-identical output across compilers is not assumed.
The native cache authenticates the library actually loaded, not a writable
runtime manifest or just its ABI version. `otc-upscale.bin --verify-runtime
FILE` checks that compiled-in identity without creating an OpenVINO Core or
accessing a GPU.
CPU-only recipe checks run with `npm run test:upscale-recipes` and in `npm test`.

Extract the pack's `upscale-pack` directory beside the AppImage; development uses
`dist/upscale-pack`. Before the first spatial export, the user explicitly starts the
model setup in the dialog. The existing resumable downloader fetches the selected
mode's two pinned safetensors plus a shared decoder and prompt (7.02 GB total)
into the private user-data model directory. It does not download both modes at once.
The same native worker reconstructs and authenticates 3.59 GB of BF16 prepared BINs
from those originals and the pack's small complements. Allow
space for both originals and prepared models. Setup checks free space before download
and again before preparation, reserving the prepared inventory plus 512 MiB; incomplete
source downloads are conservatively counted in full. Readiness requires native verification
of the complete prepared inventory, not a marker or the download finishing alone.
Cancellation waits for preparation to close, retains downloaded sources for reuse
and removes only that operation's incomplete owned prepared directory. Existing
verified models do not require originals to be downloaded again. Pack updates refresh authenticated small
structural files in the private cache without rewriting learned banks; an
interrupted refresh can be retried. Unknown or corrupt learned caches are preserved
for manual recovery rather than deleted or silently downloaded again. RIFE-only exports
do not inspect, download or prepare Flash assets. Readiness is mode-specific; an
installed Turbo model does not make Base ready. Model source URLs and hashes are
embedded at build time, not accepted from a writable runtime manifest.

The composed RGB24 stream receives face masks at the original canvas geometry
(reusing eligible detection caches), then Flash restoration, optional RIFE
interpolation and the final encoder. A twenty-frame source ring and causal model
windows avoid a whole decoded-video cache. Source frames are enhanced before RIFE
adds output-clock frames. LQ, denoiser, decoder and RIFE retire inference workspaces
between ownership phases. For 60 fps output, sources above 59 fps skip RIFE and
use nearest-timestamp frame repetition instead; source timing/duration stay unchanged.
Fixed disk-backed history is reserved before GPU work
(about 14.94 GiB for Turbo or 33.62 GiB for Base, plus the export reserve); it does
not grow with clip duration and is removed on completion or cancellation.
Compressed temporary media lives in the private job directory beside the
destination; final video/audio publication and cleanup follow the existing export
pipeline. Output files remain user-owned even when GPU access uses authorization.
`otc_CPU_ONLY=1` disables GPU selection for RIFE-only CPU validation; spatial Flash
fails clearly instead of retrying a stateful stream on an unqualified CPU backend.
Normal inference reports
its selected hardware rather than borrowing the encoder's device label.

The small-pack CI verifier and tiny native RIFE-only smoke do not establish
Electron/FFmpeg IPC, audio/metadata, spatial image quality or arbitrary-resolution
GPU fit. `npm run test:packs` uses a tiny RIFE-only CPU stream to check audio,
metadata removal and source preservation with the actual optional pack. Spatial
restoration is covered by regular orchestration tests and native qualification;
full-resolution GPU throughput still needs separate measurement. Retained component experiments
and independent source controls have specific inputs, geometry, precision and memory limits;
they are not blanket PyTorch parity, all-clips quality or all-GPU throughput
claims. Preserve numerical FAILs and precision-mode experiments as evidence.
Fresh Ubuntu 26 CI execution, final source/license publication and packaged app
integration still require release sign-off; private qualification is not release
approval.

SeedVR2 research is preserved separately in the OpenVINO reference fork, not
offered as a second product backend. Keep reference benchmarks separate from
claims about the actual packaged worker.

## GPU access and fallback

When the process already has access to a supported Intel render device, face inference and
hardware video encoding use that native access without a prompt. On a Linux host where an Intel
render device is present but inaccessible to the normal process, OneTrackCat starts a separate
privileged worker through the desktop authorization prompt when processing begins. The GUI,
project saves, and ordinary file-writing code remain under the normal user account.

The privileged face worker receives only the pack command and frame/effect stream. For ordinary
video export, the privileged encoder receives a raw video stream and returns an encoded video
stream; audio remains in the normal process. The worker does not change GPU device permissions or
install a persistent authorization rule. If the prompt is declined, unavailable, or the worker
fails authorization, OneTrackCat reports the fallback and continues with CPU processing where
possible.

The authorization path is intentionally exercised by tests with mocked processes. Do not treat a
successful mock as proof of a particular host's GPU permissions or driver behavior.

## Repository map

- `src/main/` — Electron main-process IPC, validation, media/export pipelines, and native-worker
  orchestration.
- `src/renderer/src/` — React UI, editor state, timeline behavior, and renderer tests.
- `native/face-blur/` — C++ face worker and native tests.
- `scripts/` — reproducible pack, FFmpeg, desktop-integration, and verification helpers.
- `tests/e2e/` — Playwright scenarios run through the headless Wayland harness.

Keep generated files in `dist/` and `release/`; do not commit build caches, downloaded model
sources, AppImages, or generated face/media packs.

## Licensing

The application source is GPL-3.0-only. The optional face pack and media pack include their own
licenses, notices, manifests, and provenance records. Preserve those files when redistributing a
pack or a packaged application.
