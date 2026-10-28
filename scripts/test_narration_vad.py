"""CPU-only contracts for the bounded Silero VAD wrapper."""
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

import narration_vad as vad
from test_output import run_tests


class Port:
    def __init__(self, name, shape):
        self.name, self.shape = name, shape

    def __repr__(self):
        return self.name


class FakeCompiled:
    def __init__(self, probabilities):
        self.inputs = [Port("input", (1, 576)), Port("state", (2, 1, 128))]
        self.outputs = [Port("output", (1, 1)), Port("stateN", (2, 1, 128))]
        self.probabilities = iter(probabilities)
        self.calls = []

    def __call__(self, feeds):
        self.calls.append(feeds)
        state = feeds[self.inputs[1]]
        probability = next(self.probabilities, 0.0)
        return {self.outputs[0]: np.array([[probability]], dtype=np.float32),
                self.outputs[1]: state + 1}


class VadTests(unittest.TestCase):
    def test_stream_uses_64_sample_context_and_chained_state(self):
        compiled = FakeCompiled([0.9, 0.9])
        stream = vad.StreamVAD(compiled_model=compiled)
        stream.feed(np.zeros(1024, np.float32), 10)
        first = compiled.calls[0]
        second = compiled.calls[1]
        self.assertEqual(first[compiled.inputs[0]].shape, (1, 576))
        self.assertTrue(np.all(first[compiled.inputs[0]][0, :64] == 0))
        self.assertTrue(np.all(second[compiled.inputs[1]] == 1))
        self.assertEqual(stream.next_sample, 10 * vad.SAMPLE_RATE + 1024)

    def test_block_remainder_is_carried_until_the_next_block(self):
        compiled = FakeCompiled([0.0, 0.0])
        stream = vad.StreamVAD(compiled_model=compiled)
        block = np.zeros(480_000, np.float32)
        stream.feed(block, 0)
        self.assertEqual(len(compiled.calls), 937)
        self.assertEqual(stream.pending.size, 256)
        stream.feed(np.zeros(256, np.float32), 30)
        self.assertEqual(len(compiled.calls), 938)
        self.assertEqual(stream.pending.size, 0)

    def test_only_finish_pads_a_final_partial_frame(self):
        compiled = FakeCompiled([0.0])
        stream = vad.StreamVAD(compiled_model=compiled)
        stream.feed(np.zeros(256, np.float32), 0)
        self.assertEqual(len(compiled.calls), 0)
        stream.finish(256 / vad.SAMPLE_RATE)
        self.assertEqual(len(compiled.calls), 1)

    def test_hysteresis_requires_minimum_speech_and_silence(self):
        compiled = FakeCompiled([0.8] * 8 + [0.1] * 4)
        stream = vad.StreamVAD(compiled_model=compiled)
        spans = stream.feed(np.zeros(12 * vad.FRAME_SAMPLES, np.float32))
        self.assertEqual(spans, [vad.SpeechSpan(0, 8 * vad.FRAME_SAMPLES / vad.SAMPLE_RATE)])

        short = vad.StreamVAD(compiled_model=FakeCompiled([0.8] * 4 + [0.1] * 4))
        self.assertEqual(short.feed(np.zeros(8 * vad.FRAME_SAMPLES, np.float32)), [])

    def test_cancelled_stream_stops_without_retaining_audio(self):
        stream = vad.StreamVAD(compiled_model=FakeCompiled([0.8] * 100))
        with self.assertRaises(InterruptedError):
            stream.feed(np.zeros(100 * vad.FRAME_SAMPLES, np.float32), cancelled=lambda: True)
        self.assertFalse(any(isinstance(value, np.ndarray) and value.size > vad.FRAME_SAMPLES
                             for value in stream.__dict__.values()))

    def test_probability_and_state_outputs_are_finite_and_copied(self):
        class OutputCompiled(FakeCompiled):
            def __init__(self, probability, state):
                super().__init__([probability])
                self.output_state = state

            def __call__(self, feeds):
                self.calls.append(feeds)
                return {self.outputs[0]: np.array([[next(self.probabilities)]], dtype=np.float32),
                        self.outputs[1]: self.output_state}

        for probability, state in ((1.1, np.zeros((2, 1, 128), np.float32)),
                                   (0.5, np.full((2, 1, 128), np.nan, np.float32))):
            with self.assertRaisesRegex(ValueError, "invalid output"):
                vad.StreamVAD(compiled_model=OutputCompiled(probability, state)).feed(
                    np.zeros(vad.FRAME_SAMPLES, np.float32))
        state = np.ones((2, 1, 128), np.float32)
        compiled = OutputCompiled(0.5, state)
        stream = vad.StreamVAD(compiled_model=compiled)
        stream.feed(np.zeros(vad.FRAME_SAMPLES, np.float32))
        state.fill(9)
        self.assertEqual(float(stream.state[0, 0, 0]), 1)

    def test_merge_adds_context_but_keeps_unpadded_speech_intervals(self):
        spans = [vad.SpeechSpan(1, 2), vad.SpeechSpan(2.4, 3), vad.SpeechSpan(5, 6)]
        regions = vad.merge_speech_regions(spans, 10)
        self.assertEqual(regions[0]["speech"], [(1, 2), (2.4, 3)])
        self.assertAlmostEqual(regions[0]["start"], 0.5)
        self.assertAlmostEqual(regions[0]["end"], 3.5)
        self.assertEqual(regions[1]["speech"], [(5, 6)])

    def test_resampling_downmixes_without_unbounded_work(self):
        source = np.zeros((48_000, 2), dtype=np.float32)
        source[:, 0] = 1
        result = vad.resample_mono(source, 48_000)
        self.assertEqual(result.shape, (16_000,))
        self.assertAlmostEqual(float(result.mean()), 0.5, places=4)
        self.assertTrue(np.allclose(result[10:-10], 0.5, atol=0.01))

    def test_compile_forces_cpu_and_one_thread(self):
        compiled = FakeCompiled([0.0])
        calls = []

        class Core:
            def read_model(self, path):
                return SimpleNamespace(
                    inputs=[SimpleNamespace(shape=(1, 576)), SimpleNamespace(shape=(2, 1, 128))],
                    outputs=[SimpleNamespace(shape=(1, 1)), SimpleNamespace(shape=(2, 1, 128))],
                )

            def compile_model(self, model, device, config):
                calls.append((device, config))
                return compiled

        fake_openvino = SimpleNamespace(Core=Core)
        with patch.dict(sys.modules, openvino=fake_openvino):
            result = vad.StreamVAD("models/vad/model.onnx")
        self.assertIs(result.compiled, compiled)
        self.assertEqual(calls[0][0], "CPU")
        self.assertEqual(calls[0][1]["INFERENCE_NUM_THREADS"], 1)


if __name__ == "__main__":
    raise SystemExit(run_tests())
