# Code layout

Keep the existing feature paths; add a shared helper only when independent
features need the same behavior.

- `src/`: pure timeline/effect types and calculations shared by preview and export.
- `src/main/`: filesystem, FFmpeg, jobs, IPC and worker ownership. Keep feature
  files together by prefix (`face-*`, `narration-*`, `upscale-*`). Cross-feature helpers
  have neutral names, such as `intel-device` and `model-directory`.
- `src/renderer/src/model/`: editor state, editing operations and Undo/Redo.
- `src/renderer/src/components/`: React controls and preview rendering.
- `native/face-blur/` and `native/upscale/`: bounded native inference workers.
- `scripts/`: build, conversion and verification tools; not application state.
- `assets/`: reviewed model catalogs, licenses, kernels and small pinned assets.
  Downloaded weights and generated builds belong in `dist/`, never source folders.

Use kebab-case for TypeScript modules, CLI scripts and directories; PascalCase
for React component files (camelCase for hooks); snake_case for Python modules and C++ files. Python
tests use `test_*.py`, native tests use `*_tests.cpp`, and TypeScript tests live
beside their implementation as `*.test.ts` or `*.test.tsx`.

Re-voice is the UI feature name, `narration` is its editing domain, and
`voice-pack` is its optional runtime. Those names have different roles. Installed
pack names, worker protocols, saved-project fields and model hashes are
compatibility boundaries, not cosmetic rename targets.

Keep transcript editing (`narration-transcript`, `narration-slice`) separate from
audio generation and fitting (`narration-generate`, `narration-fit`). Transcript
times come from recognition; cuts may clip their audio windows but must not
rewrite the user's words. All generated sections share the first established
original-speaker reference, including retries and edits to later sections.

Comment ownership, coordinate/time units, security checks and cache invalidation
where they matter. Keep inference backends separate when their actual lifetime
or data contracts differ; do not introduce a generic worker framework merely to
make their APIs look alike.
