"""Voice-runtime CPU contracts: no models, network, authorization or GPU use."""
import argparse
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
import scipy.signal  # Preload extensions before patch.dict restores sys.modules.
import soundfile as sf
import narration_worker as worker
from narration_voice import load_voxcpm_helper
from test_output import run_tests


class FakeVoiceModel:
    patch_size, decode_chunk_size = 1, 48000

    def encode_wav(self, wav_path, padding_mode="right"):
        return np.zeros((1, 1, 1), dtype=np.float32)


class NarrationWorkerTests(unittest.TestCase):
    def tearDown(self):
        worker.CANCELLED.clear()

    def test_auto_recognition_clears_forced_language_and_never_translates(self):
        configurations = []

        class Whisper:
            def __init__(self, *args, **kwargs):
                self.config = SimpleNamespace(language="<|en|>")

            def get_generation_config(self):
                return self.config

            def generate(self, samples, generation_config):
                configurations.append((generation_config.language, generation_config.task))
                return SimpleNamespace(words=[])

        with tempfile.TemporaryDirectory(prefix="otc-narration-auto-") as directory:
            source = Path(directory) / "audio.wav"
            sf.write(source, np.zeros(48000, np.float32), 48000)
            with patch.dict("sys.modules", openvino_genai=SimpleNamespace(WhisperPipeline=Whisper)), patch.object(worker, "progress"):
                for request in [dict(input=str(source), language="auto"), dict(input=str(source))]:
                    request["speechDetection"] = False
                    worker.transcribe(request, argparse.Namespace(pack=Path("pack")), "CPU")
        self.assertEqual(configurations, [(None, "transcribe"), (None, "transcribe")])

    def test_auto_recognition_locks_language_after_substantial_crop(self):
        configurations = []

        class Whisper:
            def __init__(self, *args, **kwargs):
                self.calls = 0
                self.config = SimpleNamespace(language="<|en|>", lang_to_id={"<|de|>": 1})

            def get_generation_config(self):
                return self.config

            def generate(self, samples, generation_config):
                configurations.append(generation_config.language)
                if self.calls == 0:
                    words = [SimpleNamespace(start_ts=index, end_ts=index + 0.5, word=f"word-{index}")
                             for index in range(4)]
                    result = SimpleNamespace(words=words, language="ru")
                else:
                    result = SimpleNamespace(words=[], language="en")
                self.calls += 1
                return result

        with tempfile.TemporaryDirectory(prefix="otc-narration-language-lock-") as directory:
            source = Path(directory) / "audio.wav"
            sf.write(source, np.zeros(35 * 48000, np.float32), 48000)
            fake = SimpleNamespace(WhisperPipeline=Whisper)
            with patch.dict("sys.modules", openvino_genai=fake), patch.object(worker, "progress"):
                worker.transcribe(dict(input=str(source), language="auto", speechDetection=False),
                                  argparse.Namespace(pack=Path("pack")), "CPU")
        self.assertEqual(configurations, [None, "<|ru|>"])

    def test_auto_language_lock_validates_detected_language_and_words(self):
        words = [SimpleNamespace(start_ts=index, end_ts=index + 0.5, word=f"word-{index}")
                 for index in range(4)]
        config = SimpleNamespace(language=None, lang_to_id={"<|de|>": 1})
        worker._maybe_lock_auto_language(config, "auto", SimpleNamespace(words=words, language="de"), 5)
        self.assertEqual(config.language, "<|de|>")

        for result in [SimpleNamespace(words=words, language="xx"), SimpleNamespace(words=words),
                        SimpleNamespace(words=words[:3], language="ru")]:
            config = SimpleNamespace(language=None, lang_to_id={"<|de|>": 1})
            worker._maybe_lock_auto_language(config, "auto", result, 5)
            self.assertIsNone(config.language)

        config = SimpleNamespace(language=None, lang_to_id={"<|de|>": 1})
        worker._maybe_lock_auto_language(config, "auto", SimpleNamespace(words=words, language="ru"), 4.99)
        self.assertIsNone(config.language)

    def test_rewrite_enables_native_json_constrained_decoding(self):
        generated_configs = []

        class GenerationConfig:
            pass

        class StructuredOutputConfig:
            def __init__(self, **kwargs):
                self.json_schema = kwargs["json_schema"]

        class Pipeline:
            def __init__(self, *args, **kwargs):
                self.tokenizer = SimpleNamespace(apply_chat_template=lambda messages, add_generation_prompt, **extra: "prompt")

            def get_tokenizer(self):
                return self.tokenizer

            def generate(self, prompt, generation_config):
                generated_configs.append(generation_config)
                return SimpleNamespace(texts=['{"segments":[]}'])

        fake = SimpleNamespace(GenerationConfig=GenerationConfig, StructuredOutputConfig=StructuredOutputConfig,
                               VLMPipeline=Pipeline)
        with patch.dict("sys.modules", openvino_genai=fake), patch.object(worker, "progress"):
            result = worker.rewrite(dict(batches=[[{"role": "user", "content": "{}"}]]),
                                    argparse.Namespace(pack=Path("pack")), "CPU")
        self.assertEqual(result, ['{"segments":[]}'])
        self.assertEqual(generated_configs[0].structured_output_config.json_schema, '{"type":"object"}')

    def test_vad_input_uses_voice_path_for_detection_but_original_for_whisper(self):
        detected_paths, decoded_means = [], []

        class Whisper:
            def __init__(self, *args, **kwargs):
                self.config = SimpleNamespace()

            def get_generation_config(self):
                return self.config

            def generate(self, samples, generation_config):
                decoded_means.append(float(np.mean(samples)))
                return SimpleNamespace(words=[])

        with tempfile.TemporaryDirectory(prefix="otc-narration-vad-input-") as directory:
            original = Path(directory) / "original.wav"
            voice = Path(directory) / "voice.wav"
            sf.write(original, np.full(4 * 48000, 0.8, np.float32), 48000)
            sf.write(voice, np.full(4 * 48000, 0.2, np.float32), 48000)
            with patch.dict("sys.modules", openvino_genai=SimpleNamespace(WhisperPipeline=Whisper)), \
                    patch.object(worker, "_detect_speech_regions",
                                 side_effect=lambda path, args, threshold: (detected_paths.append(path),
                                                                            [{"start": 1, "end": 2}])[1]), \
                    patch.object(worker, "progress"):
                worker.transcribe(dict(input=str(original), vadInput=str(voice), language="ru"),
                                  argparse.Namespace(pack=Path("pack")), "CPU")
        self.assertEqual(detected_paths, [str(voice)])
        self.assertAlmostEqual(decoded_means[0], 0.8, places=3)

    def test_vad_input_defaults_to_original_for_detection_and_whisper(self):
        detected_paths, decoded_means = [], []

        class Whisper:
            def __init__(self, *args, **kwargs):
                self.config = SimpleNamespace()

            def get_generation_config(self):
                return self.config

            def generate(self, samples, generation_config):
                decoded_means.append(float(np.mean(samples)))
                return SimpleNamespace(words=[])

        with tempfile.TemporaryDirectory(prefix="otc-narration-vad-default-") as directory:
            original = Path(directory) / "original.wav"
            sf.write(original, np.full(4 * 48000, 0.8, np.float32), 48000)
            with patch.dict("sys.modules", openvino_genai=SimpleNamespace(WhisperPipeline=Whisper)), \
                    patch.object(worker, "_detect_speech_regions",
                                 side_effect=lambda path, args, threshold: (detected_paths.append(path),
                                                                            [{"start": 1, "end": 2}])[1]), \
                    patch.object(worker, "progress"):
                worker.transcribe(dict(input=str(original), language="ru"),
                                  argparse.Namespace(pack=Path("pack")), "CPU")
        self.assertEqual(detected_paths, [str(original)])
        self.assertAlmostEqual(decoded_means[0], 0.8, places=3)

    def test_vad_input_rejects_duration_mismatch_before_detection(self):
        with tempfile.TemporaryDirectory(prefix="otc-narration-vad-duration-") as directory:
            original = Path(directory) / "original.wav"
            voice = Path(directory) / "voice.wav"
            sf.write(original, np.zeros(4 * 48000, np.float32), 48000)
            sf.write(voice, np.zeros(3 * 48000, np.float32), 48000)
            with patch.object(worker, "_detect_speech_regions") as detect:
                with self.assertRaisesRegex(ValueError, "vadInput duration mismatch"):
                    worker.transcribe(dict(input=str(original), vadInput=str(voice)),
                                      argparse.Namespace(pack=Path("pack")), "CPU")
                detect.assert_not_called()

    def test_vad_input_rejects_invalid_field_before_detection(self):
        with tempfile.TemporaryDirectory(prefix="otc-narration-vad-invalid-") as directory:
            original = Path(directory) / "original.wav"
            sf.write(original, np.zeros(4 * 48000, np.float32), 48000)
            with patch.object(worker, "_detect_speech_regions") as detect:
                for value in ("", "   ", None, 17):
                    with self.assertRaisesRegex(ValueError, "vadInput"):
                        worker.transcribe(dict(input=str(original), vadInput=value),
                                          argparse.Namespace(pack=Path("pack")), "CPU")
                detect.assert_not_called()

    def test_vad_input_is_rejected_when_detection_is_disabled(self):
        with tempfile.TemporaryDirectory(prefix="otc-narration-vad-disabled-") as directory:
            original = Path(directory) / "original.wav"
            sf.write(original, np.zeros(4 * 48000, np.float32), 48000)
            with patch.object(worker, "_detect_speech_regions") as detect:
                with self.assertRaisesRegex(ValueError, "vadInput requires speechDetection"):
                    worker.transcribe(dict(input=str(original), vadInput=str(original), speechDetection=False),
                                      argparse.Namespace(pack=Path("pack")), "CPU")
                detect.assert_not_called()

    def test_vad_threshold_options_are_bounded_even_when_detection_is_off(self):
        thresholds = []

        class VAD:
            def __init__(self, model_path, **kwargs):
                thresholds.append((kwargs["threshold"], kwargs["negative_threshold"]))

            def feed(self, samples, start, cancelled=None):
                return []

            def finish(self, end):
                return []

        class Whisper:
            def __init__(self, *args, **kwargs):
                self.config = SimpleNamespace()

            def get_generation_config(self):
                return self.config

            def generate(self, samples, generation_config):
                return SimpleNamespace(words=[])

        with tempfile.TemporaryDirectory(prefix="otc-narration-threshold-") as directory:
            source = Path(directory) / "audio.wav"
            sf.write(source, np.zeros(48000, np.float32), 48000)
            with patch.dict("sys.modules", openvino_genai=SimpleNamespace(WhisperPipeline=Whisper)), \
                    patch.object(worker, "StreamVAD", VAD), patch.object(worker, "progress"):
                worker.transcribe(dict(input=str(source), vadThreshold=0.7),
                                  argparse.Namespace(pack=Path("pack")), "CPU")
                worker.transcribe(dict(input=str(source), speechDetection=False, vadThreshold=0.35),
                                  argparse.Namespace(pack=Path("pack")), "CPU")
                for value in (0.1, 0.6, "0.5", True):
                    with self.assertRaisesRegex(ValueError, "vadThreshold"):
                        worker.transcribe(dict(input=str(source), speechDetection=False, vadThreshold=value),
                                          argparse.Namespace(pack=Path("pack")), "CPU")
        self.assertAlmostEqual(thresholds[0][0], 0.7)
        self.assertAlmostEqual(thresholds[0][1], 0.55)

    def test_long_transcription_is_chunked_without_duplicate_boundary_words(self):
        captures = []

        class Whisper:
            def __init__(self, *args, **kwargs):
                self.calls = 0
                self.configuration = SimpleNamespace()
                self.kwargs = kwargs
                self.assert_word_timestamps = kwargs["word_timestamps"]

            def get_generation_config(self):
                return self.configuration

            def generate(self, audio, **kwargs):
                captures.append((len(audio), kwargs["generation_config"].language, self.assert_word_timestamps))
                words = [(27.4, 28.0, "first"), ("bad", 28.5, "malformed"),
                         (29.1, 29.7, "boundary")] if self.calls == 0 else [
                    (0.2, 0.7, "first"), (1.1, np.nan, "nonfinite"),
                    (1.1, 1.7, "boundary"), (4, 6.9, "last")]
                self.calls += 1
                return SimpleNamespace(words=[SimpleNamespace(start_ts=start, end_ts=end, word=text) for start, end, text in words])

        with tempfile.TemporaryDirectory(prefix="otc-narration-asr-") as directory:
            source = Path(directory) / "input.wav"
            sf.write(source, np.zeros((35 * 48000, 2), np.float32), 48000)
            fake = SimpleNamespace(WhisperPipeline=Whisper)
            with patch.dict("sys.modules", openvino_genai=fake), patch.object(worker, "progress"):
                words = worker.transcribe(dict(input=str(source), language="ru", speechDetection=False),
                                          argparse.Namespace(pack=Path("pack")), "CPU")
        self.assertEqual([word["text"] for word in words], ["first", "boundary", "last"])
        self.assertAlmostEqual(words[1]["start"], 29.1)
        self.assertEqual(captures, [(30 * 16000, "<|ru|>", True), (7 * 16000, "<|ru|>", True)])

    def test_vad_crop_preserves_quiet_context_and_keeps_far_noise_out_of_decode(self):
        captures = []

        class VAD:
            def __init__(self, model_path, **kwargs):
                captures.append(("model", model_path))

            def feed(self, samples, start, cancelled=None):
                captures.append(("block", len(samples), start))
                return []

            def finish(self, end):
                return [SimpleNamespace(start=5.5, end=6.5)]

        class Whisper:
            def __init__(self, *args, **kwargs):
                self.config = SimpleNamespace()

            def get_generation_config(self):
                return self.config

            def generate(self, samples, generation_config):
                captures.append(("crop", len(samples)))
                return SimpleNamespace(words=[
                    SimpleNamespace(start_ts=0.0, end_ts=0.1, word="tool-noise-before"),
                    SimpleNamespace(start_ts=0.3, end_ts=0.7, word="real"),
                    SimpleNamespace(start_ts=1.31, end_ts=1.4, word="tool-noise-after"),
                ])

        with tempfile.TemporaryDirectory(prefix="otc-narration-vad-") as directory:
            source = Path(directory) / "input.wav"
            sf.write(source, np.zeros((12 * 48000, 2), np.float32), 48000)
            fake = SimpleNamespace(WhisperPipeline=Whisper)
            with patch.dict("sys.modules", openvino_genai=fake), patch.object(worker, "StreamVAD", VAD), \
                    patch.object(worker, "progress"):
                words = worker.transcribe(dict(input=str(source), language="ru"),
                                          argparse.Namespace(pack=Path("pack"), models=Path("models")), "CPU")
        self.assertEqual([word["text"] for word in words],
                         ["tool-noise-before", "real", "tool-noise-after"])
        self.assertAlmostEqual(words[0]["start"], 5.0)
        self.assertAlmostEqual(words[1]["start"], 5.3)
        self.assertAlmostEqual(words[1]["end"], 5.7)
        self.assertEqual(max(item[1] for item in captures if item[0] == "block"), 12 * 16000)
        self.assertEqual(sum(item[0] == "crop" for item in captures), 1)

    def test_vad_rejects_out_of_crop_words_and_owns_boundary_by_core_midpoint(self):
        words, seen = [], set()
        result = SimpleNamespace(words=[
            SimpleNamespace(start_ts=-0.1, end_ts=0.2, word="before"),
            SimpleNamespace(start_ts="not-a-time", end_ts=0.2, word="malformed"),
            SimpleNamespace(start_ts=np.nan, end_ts=0.2, word="nonfinite"),
            SimpleNamespace(start_ts=4.9, end_ts=5.2, word="boundary"),
            SimpleNamespace(start_ts=5.9, end_ts=6.2, word="after"),
            SimpleNamespace(start_ts=1.0, end_ts=1.2, word="inside"),
        ])
        worker._append_result_words(result, 0, 6, 20, (0, 5), words, seen)
        result2 = SimpleNamespace(words=[
            SimpleNamespace(start_ts=0.08, end_ts=0.38, word="boundary"),
        ])
        worker._append_result_words(result2, 4.85, 5.3, 20, (5, 10), words, seen)
        self.assertEqual([word["text"] for word in words], ["inside", "boundary"])
        self.assertAlmostEqual(words[-1]["start"], 4.93)
        self.assertAlmostEqual(words[-1]["end"], 5.23)

    def test_vad_detection_cancellation_stops_before_next_block(self):
        class VAD:
            def __init__(self, model_path, **kwargs):
                pass

            def feed(self, samples, start, cancelled=None):
                worker.CANCELLED.set()
                return []

            def finish(self, end):
                return []

        with tempfile.TemporaryDirectory(prefix="otc-narration-vad-cancel-") as directory:
            source = Path(directory) / "input.wav"
            sf.write(source, np.zeros((61 * 48000, 2), np.float32), 48000)
            with patch.object(worker, "StreamVAD", VAD), patch.object(worker, "progress") as progress:
                with self.assertRaises(InterruptedError):
                    worker.transcribe(dict(input=str(source)), argparse.Namespace(pack=Path("pack")), "CPU")
                self.assertGreaterEqual(progress.call_count, 1)

    def test_vad_and_whisper_work_are_bounded_to_thirty_seconds(self):
        blocks, crops = [], []

        class VAD:
            def __init__(self, model_path, **kwargs):
                pass

            def feed(self, samples, start, cancelled=None):
                blocks.append((len(samples), start))
                return []

            def finish(self, end):
                return [SimpleNamespace(start=1, end=2), SimpleNamespace(start=35, end=36)]

        class Whisper:
            def __init__(self, *args, **kwargs):
                self.config = SimpleNamespace()

            def get_generation_config(self):
                return self.config

            def generate(self, samples, generation_config):
                crops.append(len(samples))
                return SimpleNamespace(words=[])

        with tempfile.TemporaryDirectory(prefix="otc-narration-vad-memory-") as directory:
            source = Path(directory) / "input.wav"
            sf.write(source, np.zeros((61 * 48000, 2), np.float32), 48000)
            with patch.dict("sys.modules", openvino_genai=SimpleNamespace(WhisperPipeline=Whisper)), \
                    patch.object(worker, "StreamVAD", VAD), patch.object(worker, "progress"):
                worker.transcribe(dict(input=str(source)), argparse.Namespace(pack=Path("pack")), "CPU")
        self.assertLessEqual(max(length for length, _ in blocks), 30 * 16000)
        self.assertLessEqual(max(crops), 30 * 16000)

    def test_outer_padding_is_trimmed_but_internal_pauses_are_preserved(self):
        rate = 48000
        tone = (0.1 * np.sin(np.arange(rate // 4) * 2 * np.pi * 440 / rate)).astype(np.float32)
        audio = np.concatenate([np.zeros(int(rate * 0.3)), tone, np.zeros(int(rate * 0.3)), tone, np.zeros(int(rate * 0.4))])
        with tempfile.TemporaryDirectory(prefix="otc-voice-padding-") as directory:
            path = Path(directory) / "speech.wav"
            sf.write(path, audio, rate, subtype="FLOAT")
            args = SimpleNamespace(ffmpeg=str(Path(__file__).resolve().parent.parent / "node_modules/ffmpeg-static/ffmpeg"),
                                   uid=worker.os.getuid(), gid=worker.os.getgid())
            frames = worker.trim_generated_voice(path, args)
            result, actual_rate = sf.read(path)
            self.assertEqual(actual_rate, rate)
            self.assertEqual(len(result), frames)
            self.assertGreater(frames / rate, 0.8)
            self.assertLess(frames / rate, 1.02)
            active = np.flatnonzero(np.abs(result) > 0.001)
            self.assertGreater(float(np.max(np.diff(active))) / rate, 0.29)
            self.assertEqual(list(Path(directory).glob("*.trim.wav")), [])
            sf.write(path, np.zeros(rate), rate, subtype="FLOAT")
            with self.assertRaisesRegex(ValueError, "only silence"):
                worker.trim_generated_voice(path, args)

    def test_cached_utterances_do_not_even_load_the_voice_model(self):
        with tempfile.TemporaryDirectory(prefix="otc-narration-reuse-") as directory:
            output = Path(directory) / "utterance.wav"
            sf.write(output, np.zeros(48000, np.float32), 48000)
            with patch.object(worker, "load_voxcpm_helper", side_effect=AssertionError("Model should not load")), patch.object(worker, "progress"):
                durations = worker.synthesize(dict(phrases=[dict(text="Wait.", output=str(output))]), argparse.Namespace(pack=Path("pack")), "CPU")
            self.assertEqual(durations, [1])

    def test_cancellation_stops_between_finite_inferences(self):
        worker.CANCELLED.set()
        with self.assertRaises(InterruptedError):
            worker.progress("Transcribing", 0.5)

    def test_shared_reference_is_encoded_once_per_padding_mode(self):
        encode_calls = []

        class Model(FakeVoiceModel):
            def encode_wav(self, wav_path, padding_mode="right"):
                encode_calls.append((wav_path, padding_mode))
                return np.zeros((1, 1, 1), dtype=np.float32)

            def generate_streaming(self, text, **kwargs):
                self.encode_wav(kwargs["reference_wav_path"], "right")
                if "prompt_wav_path" in kwargs:
                    self.encode_wav(kwargs["prompt_wav_path"], "left")
                yield np.zeros(48000, np.float32)

        with tempfile.TemporaryDirectory(prefix="otc-narration-shared-reference-") as directory:
            phrases = [dict(text="First.", reference="shared.wav", referenceText="Original.",
                            output=str(Path(directory) / "first.wav")),
                       dict(text="Second.", reference="shared.wav", referenceText="Original.",
                            output=str(Path(directory) / "second.wav"))]
            constructor = unittest.mock.Mock(return_value=Model())
            with patch.object(worker, "load_voxcpm_helper", return_value=SimpleNamespace(OVVoxCPM2Model=constructor)), \
                    patch.object(worker, "AudioWriter"), patch.object(worker.os, "replace"), patch.object(worker, "progress"), \
                    patch.object(worker, "trim_generated_voice", return_value=48000):
                self.assertEqual(worker.synthesize(dict(phrases=phrases), argparse.Namespace(pack=Path("pack")), "CPU"), [1, 1])
        self.assertEqual(encode_calls, [("shared.wav", "right"), ("shared.wav", "left")])

    def test_each_phrase_uses_its_own_original_audio_for_both_cloning_inputs(self):
        calls = []

        class Model(FakeVoiceModel):

            def generate_streaming(self, text, **kwargs):
                calls.append((text, kwargs))
                yield np.zeros(48000, np.float32)

        with tempfile.TemporaryDirectory(prefix="otc-narration-emotion-") as directory:
            phrases = [dict(text="That's amazing!", reference="excited.wav", referenceText="Wow, that's amazing!", output=str(Path(directory) / "first.wav")),
                       dict(text="Please wait.", reference="calm.wav", referenceText="Uh, please wait.", output=str(Path(directory) / "second.wav"))]
            constructor = unittest.mock.Mock(return_value=Model())
            with patch.object(worker, "load_voxcpm_helper", return_value=SimpleNamespace(OVVoxCPM2Model=constructor)), \
                    patch.object(worker, "AudioWriter"), patch.object(worker.os, "replace"), patch.object(worker, "progress"), \
                    patch.object(worker, "trim_generated_voice", return_value=48000):
                durations = worker.synthesize(dict(phrases=phrases), argparse.Namespace(pack=Path("pack")), "CPU")
        self.assertEqual(durations, [1, 1])
        constructor.assert_called_once()
        for phrase, (text, kwargs) in zip(phrases, calls):
            self.assertEqual(text, phrase["text"])
            self.assertEqual(kwargs["reference_wav_path"], phrase["reference"])
            self.assertEqual(kwargs["prompt_wav_path"], phrase["reference"])
            self.assertEqual(kwargs["prompt_text"], phrase["referenceText"] + " ")
            self.assertEqual(kwargs["streaming_prefix_len"], 6)

    def test_delivery_styles_retain_speaker_reference_without_continuation(self):
        calls = []

        class Model(FakeVoiceModel):

            def generate_streaming(self, text, **kwargs):
                calls.append((text, kwargs))
                yield np.zeros(48000, np.float32)

        with tempfile.TemporaryDirectory(prefix="otc-narration-style-") as directory:
            style_prompts = {
                "conversational": "natural conversational narration, relaxed pacing and gently varied intonation",
                "cosy": "warm, cosy, gentle and reassuring tone",
                "calm": "calm, relaxed and steady delivery",
                "professional": "clear, confident professional narration",
                "energetic": "lively, enthusiastic and energetic delivery",
            }
            for style, prompt in style_prompts.items():
                phrase = dict(text="Please wait.", reference="original-speaker.wav", referenceText="Please wait.", output=str(Path(directory) / f"{style}.wav"))
                with patch.object(worker, "load_voxcpm_helper", return_value=SimpleNamespace(OVVoxCPM2Model=lambda *args, **kwargs: Model())), \
                        patch.object(worker, "AudioWriter"), patch.object(worker.os, "replace"), patch.object(worker, "progress"), \
                    patch.object(worker, "trim_generated_voice", return_value=48000):
                    worker.synthesize(dict(voiceStyle=style, phrases=[phrase]), argparse.Namespace(pack=Path("pack")), "CPU")
                text, kwargs = calls[-1]
                self.assertEqual(text, f"({prompt})Please wait.")
                self.assertEqual(kwargs["reference_wav_path"], "original-speaker.wav")
                self.assertNotIn("prompt_wav_path", kwargs)
                self.assertNotIn("prompt_text", kwargs)
                self.assertEqual(kwargs["streaming_prefix_len"], 6)
            with self.assertRaisesRegex(ValueError, "voice style"):
                worker.synthesize(dict(voiceStyle="unknown", phrases=[]), argparse.Namespace(pack=Path("pack")), "CPU")

    def test_long_sentences_stream_and_publish_only_after_completion(self):
        calls = []

        class Model(FakeVoiceModel):
            def generate_streaming(self, *args, **kwargs):
                calls.append(kwargs)
                for _ in range(30):
                    yield np.zeros(48000, np.float32)

        with tempfile.TemporaryDirectory(prefix="otc-narration-stream-") as directory:
            output = Path(directory) / "sentence.wav"
            phrase = dict(text="Long sentence.", reference="reference.wav", referenceText="Original.", output=str(output))
            model = unittest.mock.Mock(return_value=Model())
            with patch.object(worker, "load_voxcpm_helper", return_value=SimpleNamespace(OVVoxCPM2Model=model)), \
                    patch.object(worker, "AudioWriter") as writer, patch.object(worker.os, "replace") as publish, patch.object(worker, "progress"), \
                    patch.object(worker, "trim_generated_voice", return_value=30 * 48000):
                args = argparse.Namespace(pack=Path("runtime"), models=Path("models"))
                self.assertEqual(worker.synthesize(dict(phrases=[phrase]), args, "CPU"), [30])
                self.assertEqual(writer.return_value.__enter__.return_value.write.call_count, 30)
                model.assert_called_once_with("models/voice", device="CPU")
                publish.assert_called_once()
                self.assertEqual(publish.call_args.args[1], output)
        self.assertEqual(calls, [dict(reference_wav_path="reference.wav", prompt_wav_path="reference.wav",
                                     prompt_text="Original. ", inference_timesteps=10, max_len=1125,
                                     streaming_prefix_len=6)])

    def test_cancelled_stream_does_not_publish_partial_audio(self):
        class Model(FakeVoiceModel):
            def generate_streaming(self, *args, **kwargs):
                yield np.zeros(48000, np.float32)
                worker.CANCELLED.set()
                yield np.zeros(48000, np.float32)

        with tempfile.TemporaryDirectory(prefix="otc-narration-cancel-") as directory:
            phrase = dict(text="Wait.", reference="reference.wav", referenceText="Wait.", output=str(Path(directory) / "sentence.wav"))
            with patch.object(worker, "load_voxcpm_helper", return_value=SimpleNamespace(OVVoxCPM2Model=lambda *args, **kwargs: Model())), \
                    patch.object(worker, "AudioWriter"), patch.object(worker.os, "replace") as publish, patch.object(worker, "progress"):
                with self.assertRaises(InterruptedError):
                    worker.synthesize(dict(phrases=[phrase]), argparse.Namespace(pack=Path("pack")), "CPU")
                publish.assert_not_called()

    def test_privileged_audio_writer_drops_identity_before_opening_output(self):
        sink = io.BytesIO()
        process = SimpleNamespace(stdin=sink, wait=lambda: 0)
        args = argparse.Namespace(uid=1234, gid=5678, ffmpeg="/ffmpeg")
        with patch.object(worker.os, "geteuid", return_value=0), patch.object(worker.subprocess, "Popen", return_value=process) as spawn:
            writer = worker.AudioWriter("/private/output.wav", 2, args)
            writer.write(np.array([[0.1, 0.2]], dtype=np.float32))
            self.assertEqual(len(sink.getvalue()), 8)
            with self.assertRaises(ValueError):
                writer.write(np.array([np.nan]))
            writer.__exit__(None, None, None)
        self.assertEqual(spawn.call_args.kwargs["user"], 1234)
        self.assertEqual(spawn.call_args.kwargs["group"], 5678)
        self.assertEqual(spawn.call_args.kwargs["extra_groups"], [])
        self.assertEqual(spawn.call_args.kwargs["umask"], 0o077)

    def test_adapter_is_hash_checked_before_any_execution(self):
        with tempfile.TemporaryDirectory(prefix="otc-narration-helper-") as directory:
            path = Path(directory) / "helper.py"
            path.write_text("raise RuntimeError('must not execute')")
            with self.assertRaisesRegex(ValueError, "reviewed upstream"):
                load_voxcpm_helper(path)


if __name__ == "__main__":
    raise SystemExit(run_tests())
