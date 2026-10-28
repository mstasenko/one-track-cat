"""CPU-only contracts for the shipped encoded-reference cache."""

from pathlib import Path
import tempfile
import unittest

import numpy as np

from narration_voice import cache_encoded_wav
from test_output import run_tests


class FakeVoiceModel:
    def __init__(self, tag="model", failures=()):
        self.tag = tag
        self.failures = set(failures)
        self.calls = []
        self.buffer = np.zeros((2,), dtype=np.float32)

    def encode_wav(self, path, padding_mode="right"):
        self.calls.append((path, padding_mode))
        if path in self.failures:
            raise RuntimeError(f"cannot encode {path}")
        self.buffer.fill(len(self.calls) + (100 if self.tag == "second" else 0))
        return self.buffer


class NarrationVoiceTests(unittest.TestCase):
    def test_cache_is_private_keyed_and_two_entries_bounded(self):
        model = cache_encoded_wav(FakeVoiceModel())

        first = model.encode_wav("reference.wav", "right")
        first[...] = 99
        second = model.encode_wav("reference.wav", "right")
        self.assertIsNot(first, second)
        np.testing.assert_array_equal(second, [1, 1])
        self.assertEqual(model.calls, [("reference.wav", "right")])

        model.encode_wav("reference.wav", "left")
        model.encode_wav("other.wav", "right")
        # The two-entry LRU evicts the original right-padded key.
        model.encode_wav("reference.wav", "right")
        self.assertEqual(model.calls, [
            ("reference.wav", "right"), ("reference.wav", "left"),
            ("other.wav", "right"), ("reference.wav", "right"),
        ])

    def test_each_model_has_an_independent_cache_and_private_return(self):
        first = cache_encoded_wav(FakeVoiceModel("first"))
        second = cache_encoded_wav(FakeVoiceModel("second"))

        first_value = first.encode_wav("shared.wav")
        second_value = second.encode_wav("shared.wav")
        self.assertEqual(first.calls, [("shared.wav", "right")])
        self.assertEqual(second.calls, [("shared.wav", "right")])
        np.testing.assert_array_equal(first_value, [1, 1])
        np.testing.assert_array_equal(second_value, [101, 101])

    def test_same_path_with_changed_file_stamp_reencodes(self):
        with tempfile.TemporaryDirectory(prefix="otc-voice-cache-") as directory:
            path = Path(directory) / "reference.wav"
            path.write_bytes(b"first")
            model = cache_encoded_wav(FakeVoiceModel())
            model.encode_wav(path)
            model.encode_wav(path)
            self.assertEqual(len(model.calls), 1)

            # Keep the path constant but change its stat fingerprint.
            path.write_bytes(b"changed")
            model.encode_wav(path)
            self.assertEqual(len(model.calls), 2)

    def test_failed_encode_is_not_retained(self):
        model = cache_encoded_wav(FakeVoiceModel(failures={"broken.wav"}))
        with self.assertRaisesRegex(RuntimeError, "cannot encode"):
            model.encode_wav("broken.wav")

        model.failures.clear()
        value = model.encode_wav("broken.wav")
        self.assertEqual(len(model.calls), 2)
        np.testing.assert_array_equal(value, [2, 2])
        model.encode_wav("broken.wav")
        self.assertEqual(len(model.calls), 2)


if __name__ == "__main__":
    raise SystemExit(run_tests())
