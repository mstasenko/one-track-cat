# Re-voice OpenVINO models v1

Preconverted Apache-2.0 models for OneTrackCat's optional Re-voice feature:

- VoxCPM2 FP16, converted from OpenBMB's pretrained VoxCPM2 checkpoint.
- MossFormer2 SE 48K FP16 weights, converted from Alibaba's pretrained checkpoint.
  Execute the separator in FP32 for the qualified Intel Arc B580 path.

These are inference-format conversions, not newly trained or speaker-fine-tuned
models. No recordings, voice samples, private projects, or generated speech are
included. Original copyright and Apache-2.0 notices apply.

The runtime downloads these files separately, verifies pinned SHA-256 checksums,
and rejoins the oversized VoxCPM2 file. No PyTorch conversion runs on clients.
Whisper large-v3 and Qwen3.5-4B are downloaded from their official OpenVINO
Hugging Face repositories, not duplicated in these assets.

Sources and conversion provenance:

- https://huggingface.co/openbmb/VoxCPM2/tree/32279effe8c19989596f05d353d1447f51d9e915
- https://huggingface.co/alibabasglab/MossFormer2_SE_48K/tree/eff8c97925c8bec812af707814b3e5d777fd4503
- https://github.com/openvinotoolkit/openvino_notebooks/tree/9e942df1f80bcf4e60154f78f20fafd728fc127e
- https://github.com/modelscope/ClearerVoice-Studio/tree/6b3774dc79c46ae8bed2a4fa5f706f0ac8c75c61

The converted graphs are supported by the corresponding OTC voice runtime.
Public model availability is not a claim that speech separation is perfect.
