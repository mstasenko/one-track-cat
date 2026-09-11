# OneTrackCat development

This document is for contributors working on OneTrackCat. The user guide is in
[README.md](README.md). Commands and implementation notes describe the current checkout;
run the commands yourself before reporting a build or test result.

## Supported development environment

OneTrackCat is developed and tested on Ubuntu 26.04 with GNOME on Wayland. Use Node.js 22.22 or
newer and npm 11.18.x. Python 3.11 or newer is needed for catalogue-generator tests. A C++17
toolchain and CMake are additionally needed to build the optional face pack.

Install JavaScript dependencies and start the desktop app in development mode:

```bash
npm install
npm run dev
```

The development launcher prepares the local media pack and installs the development desktop
entry when needed. Development does not require Docker or `sudo`.

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

The generated face-pack directory contains the launcher, native helper, model files, selected
OpenVINO libraries, a manifest, and license/notice files:

```text
dist/face-pack/
├── otc-face-blur
├── otc-face-blur.bin
├── model.xml
├── model.bin
├── lib/
└── manifest.json
```

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
hold time, strength, and style. The optional pack supplies the native helper, RetinaFace model,
OpenVINO libraries, and provenance/licence metadata. The pack is never downloaded at runtime.

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
