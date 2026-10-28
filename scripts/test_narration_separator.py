"""CPU DSP contracts; no model, network, GPU, or PyTorch is needed."""

import io
import importlib.util
import unittest

import numpy as np
import soundfile as sf

import narration_separator as separator
from test_output import run_tests


class SeparatorDSPTests(unittest.TestCase):
    def test_features_are_bounded_finite_and_deterministic(self):
        samples = np.random.default_rng(17).normal(0, 0.05, separator.CHUNK).astype(np.float32)
        actual = separator.features(samples)
        self.assertEqual(actual.shape, (1, 496, 180))
        self.assertEqual(actual.dtype, np.float32)
        self.assertTrue(np.isfinite(actual).all())
        np.testing.assert_array_equal(actual, separator.features(samples))

    def test_deltas_preserve_constants(self):
        np.testing.assert_array_equal(separator.deltas(np.ones((10, 60), np.float32)), 0)

    def test_identity_mask_preserves_stereo_and_edges(self):
        samples = np.random.default_rng(7).normal(0, 0.05, (separator.CHUNK, 2)).astype(np.float32)
        actual = separator.masked_audio(samples, np.ones((496, 961), np.float32))
        np.testing.assert_allclose(actual, samples, rtol=0, atol=5e-7)

    def test_zero_mask_is_silence(self):
        actual = separator.masked_audio(np.ones((separator.CHUNK, 1), np.float32), np.zeros((496, 961)))
        np.testing.assert_array_equal(actual, 0)

    def test_bad_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            separator.features(np.ones(48000))
        with self.assertRaises(ValueError):
            separator.frames(np.full(separator.CHUNK, np.nan))
        with self.assertRaises(ValueError):
            separator.masked_audio(np.ones((separator.CHUNK, 1)), np.full((496, 961), np.inf))
        with self.assertRaises(ValueError):
            separator.masked_audio(np.ones((separator.CHUNK, 3)), np.ones((496, 961)))

    def test_stream_reconstruction_preserves_lengths_and_joins(self):
        for length in (1, 1919, 1920, 48000, separator.STRIDE, separator.CHUNK, separator.CHUNK * 2 + 73):
            with self.subTest(length=length):
                original = np.random.default_rng(12).normal(0, 0.05, (length, 2)).astype(np.float32)
                speech, background, progress = self.run_separation(original, mask_value=0.65)
                self.assertEqual(speech.shape, original.shape)
                self.assertEqual(background.shape, original.shape)
                np.testing.assert_allclose(speech, original * 0.65, atol=5e-7, rtol=0)
                np.testing.assert_allclose(speech + background, original, atol=2e-8, rtol=0)
                self.assertEqual(progress[-1], (length, length))

    def test_silence_does_not_invoke_model(self):
        def fail(_):
            self.fail("Silent audio should bypass the neural model")
        speech, background, _ = self.run_separation(np.zeros((1234, 1), np.float32), infer=fail)
        np.testing.assert_array_equal(speech, 0)
        np.testing.assert_array_equal(background, 0)

    def test_stream_rejects_wrong_sample_rate(self):
        with self.assertRaisesRegex(ValueError, "48 kHz"):
            self.run_separation(np.ones((100, 1), np.float32), rate=16000)

    @staticmethod
    def run_separation(original, mask_value=1, infer=None, rate=separator.RATE):
        buffers = [io.BytesIO() for _ in range(3)]
        sf.write(buffers[0], original, rate, format="WAV", subtype="FLOAT")
        buffers[0].seek(0)
        progress = []
        infer = infer if infer is not None else lambda _: np.full((496, 961), mask_value, np.float32)
        with sf.SoundFile(buffers[0]) as source, sf.SoundFile(
                buffers[1], mode="w", samplerate=rate, channels=original.shape[1], format="WAV", subtype="FLOAT"
        ) as speech, sf.SoundFile(
                buffers[2], mode="w", samplerate=rate, channels=original.shape[1], format="WAV", subtype="FLOAT"
        ) as background:
            separator.separate_audio(source, speech, background, infer,
                                     lambda done, total: progress.append((done, total)))
        outputs = []
        for buffer in buffers[1:]:
            buffer.seek(0)
            outputs.append(sf.read(buffer, dtype="float32", always_2d=True)[0])
        return *outputs, progress


@unittest.skipUnless(importlib.util.find_spec("torchaudio"), "Build-only TorchAudio reference not installed")
class UpstreamDSPTests(unittest.TestCase):
    def test_matches_kaldi_features_and_deltas(self):
        import torch
        import torchaudio
        torch.set_num_threads(4)
        samples = np.random.default_rng(9).normal(0, 0.05, separator.CHUNK).astype(np.float32)
        class ZeroDither:
            @staticmethod
            def standard_normal(shape, dtype):
                return np.zeros(shape, dtype=dtype)
        actual = separator.features(samples, ZeroDither())[0]
        bank = torchaudio.compliance.kaldi.fbank(
            torch.from_numpy(samples * 32768)[None], dither=0, frame_length=40,
            frame_shift=8, num_mel_bins=60, sample_frequency=48000, window_type="hamming")
        first = torchaudio.functional.compute_deltas(bank.T).T
        second = torchaudio.functional.compute_deltas(first.T).T
        expected = torch.cat((bank, first, second), dim=1).numpy()
        np.testing.assert_allclose(actual, expected, rtol=1e-5, atol=4e-5)

    def test_matches_upstream_stft_mask_istft(self):
        import torch
        torch.set_num_threads(4)
        rng = np.random.default_rng(42)
        samples = rng.normal(0, 0.05, separator.CHUNK).astype(np.float32)
        mask = rng.uniform(0, 1, (496, 961)).astype(np.float32)
        window = torch.hamming_window(separator.WINDOW, periodic=False)
        spectrum = torch.stft(torch.from_numpy(samples), n_fft=separator.WINDOW, hop_length=separator.HOP,
                              win_length=separator.WINDOW, window=window, center=False, return_complex=True)
        expected = torch.istft(spectrum * torch.from_numpy(mask.T), n_fft=separator.WINDOW,
                               hop_length=separator.HOP, win_length=separator.WINDOW,
                               window=window, center=False, length=separator.CHUNK).numpy()
        actual = separator.masked_audio(samples[:, None], mask)[:, 0]
        np.testing.assert_allclose(actual, expected, rtol=0, atol=5e-7)


if __name__ == "__main__":
    raise SystemExit(run_tests())
