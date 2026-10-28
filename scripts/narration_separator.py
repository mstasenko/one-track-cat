"""Torch-free MossFormer2 qualification worker and bounded audio DSP.

The model estimates speech, not a guaranteed clean background. Export/review
integration must not accept it until residual-speech and background tests pass.
"""

import argparse
import importlib.util
import json
from pathlib import Path
import time

import numpy as np


RATE = 48000
CHUNK = 4 * RATE
HOP = 384
WINDOW = 1920
STRIDE = 3 * RATE


def frames(samples):
    if samples.ndim != 1 or samples.size != CHUNK or not np.isfinite(samples).all():
        raise ValueError("Expected one finite four-second mono chunk")
    return np.lib.stride_tricks.sliding_window_view(samples, WINDOW)[::HOP]


def mel_filters():
    # Kaldi fbank defaults: 20 Hz low cutoff, power spectrum, 2048-point FFT,
    # mel=1127*ln(1+Hz/700), no Nyquist-bin contribution.
    hz = np.arange(1024, dtype=np.float32) * (RATE / 2048)
    mel = 1127 * np.log1p(hz / 700)
    edges = np.linspace(1127 * np.log1p(20 / 700), 1127 * np.log1p(24000 / 700), 62)
    rising = (mel[None] - edges[:-2, None]) / (edges[1:-1, None] - edges[:-2, None])
    falling = (edges[2:, None] - mel[None]) / (edges[2:, None] - edges[1:-1, None])
    return np.maximum(0, np.minimum(rising, falling)).astype(np.float32)


MELS = mel_filters()
HAMMING = np.hamming(WINDOW).astype(np.float32)


def deltas(features):
    padded = np.pad(features, ((2, 2), (0, 0)), mode="edge")
    return (padded[3:-1] - padded[1:-3] + 2 * (padded[4:] - padded[:-4])) / 10


def features(samples, rng=None):
    value = frames(samples * 32768).copy()
    # Match upstream's unit dither at 16-bit PCM scale; a seeded generator makes
    # comparisons reproducible without silently changing that preprocessing.
    rng = rng if rng is not None else np.random.default_rng(42)
    value += rng.standard_normal(value.shape, dtype=np.float32)
    value -= value.mean(axis=-1, keepdims=True)
    previous = np.pad(value, ((0, 0), (1, 0)), mode="edge")[:, :-1]
    value = (value - 0.97 * previous) * HAMMING
    power = np.abs(np.fft.rfft(value, n=2048)).astype(np.float32) ** 2
    bank = np.log(np.maximum(power[:, :-1] @ MELS.T, np.finfo(np.float32).eps))
    first = deltas(bank)
    return np.concatenate((bank, first, deltas(first)), axis=1)[None].astype(np.float32)


def masked_audio(samples, mask):
    if samples.ndim != 2 or samples.shape[0] != CHUNK or samples.shape[1] not in (1, 2):
        raise ValueError("Expected four seconds of mono or stereo audio")
    if mask.shape != (496, 961) or not np.isfinite(mask).all() or not np.isfinite(samples).all():
        raise ValueError("Invalid speech mask or audio")
    result = np.zeros_like(samples, dtype=np.float32)
    weights = np.zeros(CHUNK, dtype=np.float32)
    for channel in range(samples.shape[1]):
        spectrum = np.fft.rfft(frames(samples[:, channel]) * HAMMING)
        decoded = np.fft.irfft(spectrum * mask, n=WINDOW).astype(np.float32) * HAMMING
        for index, frame in enumerate(decoded):
            start = index * HOP
            result[start:start + WINDOW, channel] += frame
            if channel == 0:
                weights[start:start + WINDOW] += HAMMING ** 2
    return result / weights[:, None]


def separate_audio(source, speech, background, infer, progress=lambda done, total: None):
    """Stream overlap-add into opened SoundFiles; working memory is clip-length independent."""
    if source.samplerate != RATE or source.channels not in (1, 2) or source.frames <= 0:
        raise ValueError("Separator input must be nonempty 48 kHz mono/stereo PCM")
    if any(output.samplerate != RATE or output.channels != source.channels for output in (speech, background)):
        raise ValueError("Separator output format does not match input")
    overlap = CHUNK - STRIDE
    window = np.minimum(np.arange(1, CHUNK + 1), np.arange(CHUNK, 0, -1)).astype(np.float32)
    window /= window.max()
    pending = np.zeros((CHUNK, source.channels), dtype=np.float32)
    weights = np.zeros(CHUNK, dtype=np.float32)
    total = source.frames
    for start in range(0, total, STRIDE):
        source.seek(start)
        raw = source.read(CHUNK, dtype="float32", always_2d=True)
        count = len(raw)
        padded = np.pad(raw, ((0, CHUNK - count), (0, 0)))
        if not np.isfinite(padded).all():
            raise ValueError("Source contains nonfinite audio")
        # Silence bypass avoids hallucinated low-level speech from dither.
        estimate = np.zeros_like(padded) if not np.any(padded) else masked_audio(
            padded, np.asarray(infer(features(padded.mean(axis=1))))
        )
        pending += estimate * window[:, None]
        weights += window
        emitted = min(STRIDE, count)
        vocal = pending[:emitted] / weights[:emitted, None]
        speech.write(vocal)
        # Derive the residual sample-for-sample at the original level, not by
        # independently normalizing two stems or adding the old mix back later.
        background.write(raw[:emitted] - vocal)
        pending[:overlap] = pending[STRIDE:]
        pending[overlap:] = 0
        weights[:overlap] = weights[STRIDE:]
        weights[overlap:] = 0
        progress(min(total, start + emitted), total)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--speech", type=Path, required=True)
    parser.add_argument("--background", type=Path, required=True)
    parser.add_argument("--precision", choices=("f16", "f32"), default="f32")
    parser.add_argument("--reference", type=Path, help="Optional bounded conversion-reference NPZ for numerical checks")
    args = parser.parse_args()
    outputs = (args.speech.resolve(), args.background.resolve())
    if len(set(outputs)) != 2 or args.audio.resolve() in outputs or any(path.exists() for path in outputs):
        raise ValueError("Outputs must be distinct new files")
    if importlib.util.find_spec("torch") is not None:
        raise RuntimeError("Use the torch-free runtime environment")
    import openvino as ov
    import soundfile as sf

    core = ov.Core()
    devices = [name for name in core.available_devices
               if name.startswith("GPU") and "B580" in str(core.get_property(name, "FULL_DEVICE_NAME"))]
    if len(devices) != 1:
        raise RuntimeError("Exactly one accessible B580 is required")
    started = time.monotonic()
    compiled = core.compile_model(args.model, devices[0], {
        "PERFORMANCE_HINT": "LATENCY", "INFERENCE_PRECISION_HINT": args.precision})
    print(json.dumps({"stage": "compiled", "device": devices[0], "precision": args.precision,
                      "seconds": time.monotonic() - started}), flush=True)
    if args.reference is not None:
        if args.reference.stat().st_size > 8 * 1024 ** 2:
            raise ValueError("Numerical reference is too large")
        with np.load(args.reference, allow_pickle=False) as reference:
            value, expected = reference["features"], reference["expected"]
        if value.shape != (1, 496, 180) or expected.shape != (1, 496, 961):
            raise ValueError("Invalid numerical reference shapes")
        actual = compiled([value])[0]
        print(json.dumps({"stage": "reference", "max_absolute_error": float(np.max(np.abs(actual - expected))),
                          "relative_l2_error": float(np.linalg.norm(actual - expected) / max(1e-12, np.linalg.norm(expected)))}),
              flush=True)

    def infer(value):
        return compiled([value])[0][0]

    def progress(done, total):
        print(json.dumps({"stage": "separating", "done": done, "total": total}), flush=True)

    started = time.monotonic()
    with sf.SoundFile(args.audio) as source:
        for path in outputs:
            path.parent.mkdir(parents=True, exist_ok=True)
        with sf.SoundFile(args.speech, mode="x", samplerate=RATE, channels=source.channels,
                          format="WAV", subtype="FLOAT") as speech, sf.SoundFile(
                args.background, mode="x", samplerate=RATE, channels=source.channels,
                format="WAV", subtype="FLOAT") as background:
            separate_audio(source, speech, background, infer, progress)
    print(json.dumps({"stage": "separated", "seconds": time.monotonic() - started}), flush=True)


if __name__ == "__main__":
    main()
