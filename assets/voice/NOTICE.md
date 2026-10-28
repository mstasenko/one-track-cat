# Voice-pack model and adapter sources

Preserve upstream licenses, model cards, copyright notices and any NOTICE files
when distributing a pack. No original sample recordings are included in it.
Rights to a recording or a person's voice remain separate from model licenses.

- **Whisper large-v3**: OpenAI's source/model release is MIT; the official
  OpenVINO conversion card declares Apache-2.0. Preserve both notices:
  https://github.com/openai/whisper/blob/main/LICENSE
  https://huggingface.co/OpenVINO/whisper-large-v3-fp16-ov
  revision `220761e60602a5ca694c409d5f424563b75d6820`.
- **Silero VAD**: Silero Team, MIT. Official fixed-shape OpenVINO model:
  https://github.com/snakers4/silero-vad/tree/066409f3d9db45a30d21dfcbf9147826ffdd7052
  `src/silero_vad/data/silero_vad_openvino_16k.onnx`.
- **Qwen3.5-4B INT8**: Qwen, Apache-2.0. Official OpenVINO artifact:
  https://huggingface.co/OpenVINO/Qwen3.5-4B-int8-ov
  revision `e4d8de7a25bc3007261c28785bc190c97cabd243`.
- **VoxCPM2**: OpenBMB, Apache-2.0.
  https://huggingface.co/openbmb/VoxCPM2
  revision `32279effe8c19989596f05d353d1447f51d9e915`.
  Source code: https://github.com/OpenBMB/VoxCPM
  commit `cce58a5b59303c9bd63d12f23afe6a49a4a80c59`.
- **MossFormer2 SE 48K**: Alibaba, Apache-2.0.
  https://huggingface.co/alibabasglab/MossFormer2_SE_48K
  revision `eff8c97925c8bec812af707814b3e5d777fd4503`.
  Converter architecture from https://github.com/modelscope/ClearerVoice-Studio
  commit `6b3774dc79c46ae8bed2a4fa5f706f0ac8c75c61`.
- **VoxCPM2 OpenVINO adapter**: OpenVINO notebooks, Apache-2.0.
  https://github.com/openvinotoolkit/openvino_notebooks
  commit `9e942df1f80bcf4e60154f78f20fafd728fc127e`.
  Adapter SHA-256:
  `942455d80931f5cc2b69fc37d4a0de39bf0d38fb6b0719398d05809ddc4b21af`.

Runtime wheel dependencies retain their own distribution license files. The
development installer links an existing environment. The portable pack preserves
runtime distribution licenses and includes the model/adapter license notices.
