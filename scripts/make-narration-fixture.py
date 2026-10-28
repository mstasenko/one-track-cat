"""Create a deterministic speech/background mixture for separator qualification.

Synthetic engine-like noise is a controlled DSP test, not proof of performance
on actual gameplay sounds. The clean speech stays an external development fixture.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--speech", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Fixture output must be a new directory")
    with sf.SoundFile(args.speech) as source:
        if source.samplerate != 48000 or not 0 < source.frames <= 30 * 48000:
            raise ValueError("Use a short 48 kHz speech fixture")
        speech = source.read(dtype="float32", always_2d=True)
    time = np.arange(len(speech), dtype=np.float32) / 48000
    rng = np.random.default_rng(217)
    hum = sum(np.sin(2 * np.pi * frequency * time) / (index + 1)
              for index, frequency in enumerate((93, 186, 279, 372)))
    hum = hum[:, None] * (0.7 + 0.3 * np.sin(2 * np.pi * 0.4 * time[:, None]))
    noise = hum + rng.standard_normal(speech.shape) * 0.6
    noise *= np.sqrt(np.mean(speech ** 2) / np.mean(noise ** 2)) / 10 ** (5 / 20)
    if not np.isfinite(noise).all() or np.max(np.abs(speech + noise)) >= 1:
        raise ValueError("Invalid or clipping test mixture")
    args.output.mkdir(parents=True)
    for name, audio in (("speech", speech), ("background", noise), ("mixture", speech + noise)):
        sf.write(args.output / f"{name}.wav", audio, 48000, subtype="FLOAT")
    print(json.dumps({"samples": len(speech), "sample_rate": 48000, "snr_db": 5,
                      "background": "synthetic engine-like hum and white noise", "seed": 217}))


if __name__ == "__main__":
    main()
