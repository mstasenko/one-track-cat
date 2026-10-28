"""Build-only, CPU-only export of the pinned MossFormer2 speech-isolation candidate.

This is a qualification tool, not an accepted narration separator or runtime
dependency. Do not use its residual as a guaranteed speech-free background.
"""

import argparse
import hashlib
import importlib
import json
from pathlib import Path
import resource
import subprocess
import sys
import time


SOURCE_REVISION = "6b3774dc79c46ae8bed2a4fa5f706f0ac8c75c61"
WEIGHT_REVISION = "eff8c97925c8bec812af707814b3e5d777fd4503"
WEIGHT_SHA256 = "03692b9f773bbd6bb43b9c5a41f96b1e28affd66e13796b7bec66ad3d8b227c6"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audio", type=Path, help="Optional real 48 kHz input for conversion comparison")
    args = parser.parse_args()
    revision = subprocess.check_output(
        ["git", "-C", str(args.source), "rev-parse", "HEAD"], text=True
    ).strip()
    dirty = subprocess.check_output(
        ["git", "-C", str(args.source), "status", "--porcelain", "--untracked-files=no"], text=True
    )
    if revision != SOURCE_REVISION or dirty:
        raise ValueError("Use the unchanged, reviewed ClearerVoice source revision")
    if args.output.exists():
        raise ValueError("Conversion output must be a new directory")
    with args.weights.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != WEIGHT_SHA256:
        raise ValueError("Separator weights do not match the pinned upstream artifact")

    import numpy as np
    import openvino as ov
    import torch

    if not torch.__version__.endswith("+cpu"):
        raise ValueError("Use the isolated CPU-only conversion environment")
    torch.set_num_threads(4)
    torch.manual_seed(42)
    # Import only the reviewed model package, not ClearVoice's broad loader
    # (which downloads models, suppresses warnings and imports other tasks).
    sys.path.insert(0, str(args.source / "clearvoice/clearvoice/models"))
    module = importlib.import_module("mossformer2_se.mossformer2_se_wrapper")
    model = module.TestNet().eval()
    checkpoint = torch.load(args.weights, map_location="cpu", weights_only=True)
    state = checkpoint.get("model", checkpoint)
    state = {key.removeprefix("module."): value for key, value in state.items()}
    model.load_state_dict(state, strict=True)
    parameters = sum(value.numel() for value in model.parameters())

    # Four seconds, matching the upstream long-audio decode window. Keep the
    # feature/time shapes static; stream overlapping chunks instead of compiling
    # one unbounded sequence for the entire selected recording.
    example = torch.randn(1, 496, 180)
    if args.audio is not None:
        import soundfile as sf
        from narration_separator import CHUNK, RATE, features
        with sf.SoundFile(args.audio) as source:
            if source.samplerate != RATE:
                raise ValueError("Reference audio must be 48 kHz")
            audio = source.read(CHUNK, dtype="float32", always_2d=True).mean(axis=1)
        example = torch.from_numpy(features(np.pad(audio, (0, CHUNK - len(audio)))))
    with torch.inference_mode():
        expected = model(example)[-1].numpy()
    started = time.monotonic()
    converted = ov.convert_model(model, example_input=example, input=[example.shape])
    args.output.mkdir(parents=True)
    path = args.output / "model.xml"
    ov.save_model(converted, path, compress_to_fp16=True)
    # CPU defaults may choose BF16 arithmetic. Compare FP16 weight compression
    # against FP32 arithmetic explicitly, rather than conflating both changes.
    compiled = ov.Core().compile_model(path, "CPU", {
        "INFERENCE_NUM_THREADS": 4, "INFERENCE_PRECISION_HINT": "f32"})
    actual = compiled([example.numpy()])[0]
    if actual.shape != expected.shape or not np.isfinite(actual).all():
        raise ValueError("Converted separator has invalid output")
    error = float(np.max(np.abs(actual - expected)))
    # FP16-compressed weights need not produce bit-identical FP32 outputs.
    # Save both for inspection; a scalar tolerance is not audio quality approval.
    np.savez(args.output / "conversion-reference.npz", features=example.numpy(),
             expected=expected, actual=actual)
    metadata = {
        "source_revision": revision, "weight_revision": WEIGHT_REVISION,
        "weights_sha256": digest,
        "parameters": parameters, "weight_precision": "FP16", "sample_rate": 48000,
        "chunk_samples": 192000, "feature_shape": list(example.shape),
        "mask_shape": list(actual.shape), "conversion_seconds": time.monotonic() - started,
        "reference_max_absolute_error": error,
        "reference_relative_l2_error": float(np.linalg.norm(actual - expected) / max(1e-12, np.linalg.norm(expected))),
        "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "torch": torch.__version__, "openvino": ov.__version__,
        "qualified": False,
    }
    (args.output / "provenance.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata), flush=True)


if __name__ == "__main__":
    main()
