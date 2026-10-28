"""Load the reviewed upstream VoxCPM2 adapter, shared by runtime and probes."""
import hashlib
import importlib.util
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np


# The causal VAE needs five preceding four-frame patches plus the current one
# when decoding a streaming chunk. Keep this model-specific setting beside the
# adapter/cache instead of duplicating it in the worker.
STREAMING_PREFIX_LEN = 6


def cache_encoded_wav(model):
    """Cache two stable per-model VAE prompt encodings.

    The upstream encoder can reuse its inference output buffer, so retain a
    copy and return a fresh copy to keep callers from mutating the cache.
    """
    encode_wav = model.encode_wav

    @lru_cache(maxsize=2)
    def cached(wav_path, padding_mode, stamp):
        return np.array(encode_wav(wav_path, padding_mode), copy=True)

    def encode(wav_path, padding_mode="right"):
        # A restored/replaced reference may keep its path; do not reuse old audio.
        try:
            info = Path(wav_path).stat()
            stamp = (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        except OSError:
            stamp = None
        return cached(wav_path, padding_mode, stamp).copy()

    model.encode_wav = encode
    return model


def load_voxcpm_helper(path):
    expected = "942455d80931f5cc2b69fc37d4a0de39bf0d38fb6b0719398d05809ddc4b21af"
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError("VoxCPM2 OpenVINO helper does not match the reviewed upstream revision")
    spec = importlib.util.spec_from_file_location("voxcpm2_tts_helper", path)
    if spec is None or spec.loader is None:
        raise ValueError("Could not load the pinned VoxCPM2 adapter")
    helper = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = helper
    spec.loader.exec_module(helper)
    return helper
