# Re-voice development

The local desktop effect uses Recognize → optional Edit transcript → Generate.
Recognition always reads original base audio, not a previous generated overlay.
Recognize applies balanced wording cleanup. The large editor shows only the
resulting editable transcript; Apply saves edits only. Panel Generate recreates
the voice without running text cleanup again.
Cleanup requests conservative Russian stress marks and ё where appropriate.
They remain editable; base VoxCPM2 does not guarantee that it follows stress marks.
It replaces selected base audio with separated environment + newly generated
speech. Other audio layers remain independent. Original/AI switching, saved
drafts/revisions, Undo, cuts, and export use the ordinary audio-overlay path.
Export does not run inference again. Unedited video can be stream-copied.

## Runtime

All neural inference uses OpenVINO. Models run sequentially, not simultaneously.
The inference environment contains no PyTorch/CUDA; CPU PyTorch is build-only.
Current GPU qualification is B580 only; no NVIDIA/AMD inference or comparison.
CPU fallback is slower, and authorization failure is reported before fallback.
Only the worker is elevated if needed. Audio writers drop to the caller's UID
before opening output files. The editor itself stays unprivileged.

| Stage | Model / stored precision | Important qualification |
| --- | --- | --- |
| Speech separation | MossFormer2 SE 48K, 55M, FP16 weights | **FP32 execution required**: B580 FP16 execution had ~60.5% mask error; FP32 ~0.0602% relative L2 vs the source reference. |
| Speech detection | Silero VAD, FP32 | One CPU thread; bounded 30-second input blocks. |
| Word alignment / ASR | Full Whisper large-v3, 1.55B, FP16 | Speech-directed crops up to 30 seconds; original word anchors, no LLM timestamps. |
| Text cleanup | Qwen3.5-4B, INT8 | Official OpenVINO VLM loader, text only, thinking disabled; optional human review. |
| Voice recreation | VoxCPM2, ~2B, FP16 | Pinned upstream OpenVINO adapter; 10 inference steps, bounded utterances. |

MossFormer is an enhancement/separation candidate, not a guarantee that original
speech is completely inaudible in the residual. Background preservation and
voice naturalness still require listening on the user's recording. Short
English/Russian samples are functional checks, not a claim of universal SOTA.

Speech may finish early; remaining time contains environment only. Overruns
allow at most 15% pitch-preserving acceleration, otherwise require shorter text.
Changing a phrase reuses other synthesized phrases. Speed edits disable stale
narration until reanalysis. Reset/new project removes managed narration files
when no job is using them; Undo retains immutable media until then.

All sections share one immutable original-speaker reference. The first section
revoiced establishes it from up to 60 seconds of original audio starting there,
bounded by the timeline end. Usable original recognition anchors define the
reference window; extra recognition does not enter the selected section's transcript.
Short recordings remain usable.
Existing saved references stay unchanged until explicitly replaced.
Original uses that recording and its transcript for acoustic continuation as well
as speaker identity. Each sentence is synthesized independently; the previous
generated sentence is not fed back, which avoids cumulative voice drift but does
not provide continuous paragraph-level prosody. Original sentence anchors stay fixed.
The worker encodes each shared reference once per padding mode in a generation
batch, then reuses private copies of those VAE latents across sentences. This
small, two-entry cache stays in memory and is released with the model; it creates
no project files. Sentence text and LM state are processed afresh. Deeper GPU
KV-prefix reuse is excluded: B580 checks changed spoken words and showed no
speed benefit for the current short reference.
Generation checks the assembled speech against the reviewed wording, including when
subtitles are off. A complete recognized sentence followed by clearly extra words
can have only that unwanted tail faded out; its background and timeline stay fixed.
The same recognition pass supplies optional subtitle timing.
Generation streams bounded chunks with six model patches of decoder context:
the causal VAE needs 20 preceding latent frames plus the current four-frame patch.
This matches full decoding within FP16 rounding without allocating sentence-sized
VAE activations. Changing the decoder context invalidates synthesized-utterance
caches; existing generated project revisions remain available for Undo.
Explicit delivery styles use reference-only controllable cloning with a
parenthesized style instruction, as documented upstream. This avoids a
continuation prompt fighting the requested delivery. Speaker identity still
comes from the shared recording. This style path can preserve less of its detailed
delivery than Original. Style is part of the utterance cache key.

## Local development install / checks

`node scripts/install-dev-voice-pack.mjs [model-cache-directory]` installs the
already-qualified local environment/models into `dist/voice-pack` using links,
without duplicating their large weights. It fails if those prerequisites are
absent. This development install is not the portable release pack.
Run `npm run build` afterwards, then launch the normal desktop development icon.

`npm run build:voice-pack` packages the qualified torch-free environment into
`release/otc-voice-pack.zip`, without models or development recordings. It builds
in a fresh `dist/voice-pack-release` directory and refuses occupied output paths.
The portable runtime is isolated from host Python packages and verified after
relocation. Use the same supported Linux baseline as OneTrackCat.

`sources.json` pins revisions, file sizes and SHA-256 checksums. Recognize
downloads models into the private app-data `otc-voice-models` folder before
opening a worker. The existing downloader resumes partial files, checks hashes
and provides progress/cancellation/ETA. Only the oversized VoxCPM file needs
bounded, verified reassembly; chunks are removed after atomic publication.
Reset clears generated project audio, not installed weights.

Whisper and Qwen come from official OpenVINO repositories. Converted VoxCPM2 and
MossFormer files are separate GitHub model-release assets, not runtime ZIP data
or Git LFS objects. Clients never install PyTorch or convert these models.

Model source revisions and required notices are in [NOTICE.md](NOTICE.md).
CPU audio, IPC, UI, persistence/editing, cancellation and stream-copy regression
tests run in `npm test`; hidden GUI tests never launch AI models or GPUs.
`scripts/test_narration_separator.py` and `scripts/test_narration_worker.py`
additionally validate bounded DSP, long ASR chunking, cached utterances,
privilege dropping and cancellation in the voice runtime.
`scripts/smoke-narration-worker.py` is an explicit finite
B580 smoke, not part of automatic tests. Raw development measurements remain in
the ignored model cache; never treat process RSS as GPU memory usage.

The 12-second English worker smoke completed all four stages: separation
4.71 s, full Whisper 8.66 s, cleanup 6.03 s, and one 3.36-second synthesized
utterance 10.85 s. These include model setup, are not hour-long throughput
estimates, and are not compared with an NVIDIA run.
