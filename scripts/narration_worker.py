"""Sequential, torch-free OpenVINO narration worker. One authorization per action.

stdin/stdout carry bounded JSON lines; diagnostics go to stderr. Audio writers
drop privileges before opening files, even when inference needs root GPU access.
"""
import argparse
import contextlib
import gc
import json
import os
from pathlib import Path
import subprocess
import sys
import queue
import threading

import numpy as np
import soundfile as sf

from narration_separator import separate_audio
from narration_vad import MAX_REGION_SECONDS, StreamVAD, merge_speech_regions, resample_mono
from narration_voice import STREAMING_PREFIX_LEN, cache_encoded_wav, load_voxcpm_helper


# pkexec drops the parent environment. Scope OpenCL before OpenVINO imports so
# discovery itself never initializes unrelated NVIDIA/AMD drivers.
if sys.platform == "linux":
    os.environ["OCL_ICD_VENDORS"] = "/etc/OpenCL/vendors/intel.icd"
    os.environ["CUDA_VISIBLE_DEVICES"] = ""


PROTOCOL = sys.stdout
CANCELLED = threading.Event()


def emit(value):
    print(json.dumps(value, ensure_ascii=False), file=PROTOCOL, flush=True)


class AudioWriter:
    def __init__(self, path, channels, args):
        self.samplerate, self.channels = 48000, channels
        credentials = dict(user=args.uid, group=args.gid, extra_groups=[]) if os.geteuid() == 0 else {}
        self.process = subprocess.Popen([
            args.ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", "48000",
            "-ac", str(channels), "-i", "pipe:0", "-c:a", "pcm_f32le", "-map_metadata", "-1", "-n", path,
        ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, umask=0o077, **credentials)

    def write(self, samples):
        if not np.isfinite(samples).all():
            raise ValueError("Nonfinite generated audio")
        self.process.stdin.write(np.asarray(samples, dtype="<f4").tobytes())

    def __enter__(self):
        return self

    def __exit__(self, *error):
        self.process.stdin.close()
        code = self.process.wait()
        if code and not error[0]:
            raise RuntimeError("Could not write narration audio")


def progress(stage, fraction):
    if CANCELLED.is_set():
        raise InterruptedError("Narration cancelled")
    emit(dict(progress=dict(stage=stage, fraction=fraction)))


def separate(request, args, device):
    import openvino as ov
    progress("Separating speech", 0)
    # f16 execution has a measured large mask error for this model on B580.
    # Keep compact f16 weights, but accumulate/execute this separator in f32.
    model = ov.Core().compile_model(str(getattr(args, "models", args.pack) / "separator/model.xml"), device,
                                   {"PERFORMANCE_HINT": "LATENCY", "INFERENCE_PRECISION_HINT": "f32"})
    with sf.SoundFile(request["input"]) as source, AudioWriter(request["speech"], source.channels, args) as speech, \
            AudioWriter(request["background"], source.channels, args) as background:
        separate_audio(source, speech, background, lambda value: model([value])[0][0],
                       lambda done, total: progress("Separating speech", done / total))
    return dict(speechPath=request["speech"], backgroundPath=request["background"])


TRANSCRIBE_WINDOW_SECONDS = MAX_REGION_SECONDS
LEGACY_STEP_SECONDS = TRANSCRIBE_WINDOW_SECONDS - 2
AUTO_LANGUAGE_MIN_CROP_SECONDS = 5
AUTO_LANGUAGE_MIN_WORDS = 4
VAD_DURATION_TOLERANCE_SECONDS = 0.002


def _detect_speech_regions(path, args, threshold=0.5):
    """Scan at most one 30-second block at a time with the CPU VAD."""
    model_path = getattr(args, "models", args.pack) / "vad/model.onnx"
    spans = []
    with sf.SoundFile(path) as source:
        total = source.frames / source.samplerate
        block_frames = TRANSCRIBE_WINDOW_SECONDS * source.samplerate
        vad = StreamVAD(model_path, threshold=threshold,
                        negative_threshold=max(threshold - 0.15, 0.01))
        for start in range(0, source.frames, block_frames):
            progress("Detecting speech", start / max(1, source.frames))
            source.seek(start)
            raw = source.read(block_frames, dtype="float32", always_2d=True)
            samples = resample_mono(raw, source.samplerate)
            spans.extend(vad.feed(samples, start / source.samplerate, cancelled=CANCELLED.is_set))
            if CANCELLED.is_set():
                raise InterruptedError("Narration cancelled")
        spans.extend(vad.finish(total))
        progress("Detecting speech", 1)
    return merge_speech_regions(spans, total)


def _resolve_vad_input(request):
    if "vadInput" not in request:
        return request["input"]
    value = request["vadInput"]
    if not isinstance(value, str) or not value.strip():
        raise ValueError("vadInput must be a nonempty audio path")
    vad_path = value.strip()
    try:
        with sf.SoundFile(request["input"]) as asr_source, sf.SoundFile(vad_path) as vad_source:
            asr_duration = asr_source.frames / asr_source.samplerate
            vad_duration = vad_source.frames / vad_source.samplerate
            tolerance = max(VAD_DURATION_TOLERANCE_SECONDS,
                            1 / asr_source.samplerate, 1 / vad_source.samplerate)
    except Exception as error:
        raise ValueError(f"Could not read ASR or vadInput audio: {error}") from error
    if abs(asr_duration - vad_duration) > tolerance:
        raise ValueError(f"vadInput duration mismatch: ASR {asr_duration:.6f}s, VAD {vad_duration:.6f}s")
    return vad_path


def _valid_word_timing(word, crop_duration):
    """Return a model word's untouched timing, or ignore malformed output."""
    try:
        start, end = float(word.start_ts), float(word.end_ts)
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None
    if not np.isfinite(start) or not np.isfinite(end) or not 0 <= start < end <= crop_duration:
        return None
    return start, end


def _append_result_words(result, offset, crop_duration, audio_duration, ownership_core, words, seen):
    """Keep model timestamps verbatim, adding only the real crop offset."""
    for word in getattr(result, "words", None) or []:
        timing = _valid_word_timing(word, crop_duration)
        text = getattr(word, "word", None)
        if timing is None or not isinstance(text, str):
            continue
        start, end = timing
        absolute_start, absolute_end = offset + start, offset + end
        if absolute_start < 0 or absolute_end > audio_duration:
            continue
        if ownership_core is not None:
            middle = (absolute_start + absolute_end) / 2
            if middle < ownership_core[0] or middle >= ownership_core[1]:
                continue
        key = (round(absolute_start, 6), round(absolute_end, 6), text)
        if key in seen:
            continue
        seen.add(key)
        words.append(dict(start=absolute_start, end=absolute_end, text=text))


def _valid_result_word_count(result, crop_duration):
    count = 0
    for word in getattr(result, "words", None) or []:
        text = getattr(word, "word", None)
        if _valid_word_timing(word, crop_duration) is not None and isinstance(text, str) and text.strip():
            count += 1
    return count


def _detected_language_token(result, config):
    language = getattr(result, "language", None)
    if not isinstance(language, str):
        return None
    language = language.strip().lower()
    if language.startswith("<|") and language.endswith("|>"):
        language = language[2:-2]
    if not (2 <= len(language) <= 3 and language.isascii() and language.isalpha()):
        return None
    token = f"<|{language}|>"
    if language in {"en", "ru"}:
        return token
    try:
        lang_to_id = config.lang_to_id
    except AttributeError:
        return None
    if isinstance(lang_to_id, dict) and (language in lang_to_id or token in lang_to_id):
        return token
    return None


def _maybe_lock_auto_language(config, requested_language, result, crop_duration):
    if (requested_language != "auto" or getattr(config, "language", None) is not None or
            crop_duration < AUTO_LANGUAGE_MIN_CROP_SECONDS or
            _valid_result_word_count(result, crop_duration) < AUTO_LANGUAGE_MIN_WORDS):
        return
    token = _detected_language_token(result, config)
    if token is not None:
        config.language = token


def _configure_whisper(request, args, device):
    import openvino_genai as genai
    pipe = genai.WhisperPipeline(str(getattr(args, "models", args.pack) / "whisper"), device,
                                 word_timestamps=True, PERFORMANCE_HINT="LATENCY")
    config = pipe.get_generation_config()
    language = request.get("language", "auto")
    config.language = None if language == "auto" else f"<|{language}|>"
    config.task = "transcribe"
    config.return_timestamps, config.word_timestamps, config.max_new_tokens = True, True, 448
    return pipe, config


def _read_crop(source, start, end):
    first = max(0, min(source.frames, round(start * source.samplerate)))
    last = max(first, min(source.frames, round(end * source.samplerate)))
    source.seek(first)
    raw = source.read(last - first, dtype="float32", always_2d=True)
    return resample_mono(raw, source.samplerate), first / source.samplerate


def _crop_ownership(regions, index):
    current = regions[index]
    previous = regions[index - 1] if index else None
    following = regions[index + 1] if index + 1 < len(regions) else None
    overlaps_previous = previous is not None and current["start"] < previous["end"]
    overlaps_following = following is not None and following["start"] < current["end"]
    if not (overlaps_previous or overlaps_following):
        return None
    speech = current["speech"]
    return speech[0][0], speech[-1][1]


def transcribe(request, args, device):
    speech_detection = request.get("speechDetection", True)
    if not isinstance(speech_detection, bool):
        raise ValueError("speechDetection must be a boolean")
    if not speech_detection and "vadInput" in request:
        raise ValueError("vadInput requires speechDetection")
    vad_threshold = request.get("vadThreshold", 0.5)
    if (isinstance(vad_threshold, bool) or not isinstance(vad_threshold, (int, float)) or
            not np.isfinite(vad_threshold) or not any(abs(vad_threshold - allowed) < 1e-9
                                                      for allowed in (0.35, 0.5, 0.7))):
        raise ValueError("vadThreshold must be 0.35, 0.5, or 0.7")
    words, seen = [], set()
    if speech_detection:
        vad_input = _resolve_vad_input(request)
        regions = _detect_speech_regions(vad_input, args, float(vad_threshold))
        progress("Transcribing speech", 0)
        if not regions:
            progress("Transcribing speech", 1)
            return words
        pipe, config = _configure_whisper(request, args, device)
        requested_language = request.get("language", "auto")
        with sf.SoundFile(request["input"]) as source:
            total = source.frames / source.samplerate
            for index, region in enumerate(regions):
                if CANCELLED.is_set():
                    raise InterruptedError("Narration cancelled")
                samples, offset = _read_crop(source, region["start"], region["end"])
                result = pipe.generate(samples, generation_config=config)
                _maybe_lock_auto_language(config, requested_language, result, len(samples) / 16000)
                _append_result_words(result, offset, len(samples) / 16000, total,
                                     _crop_ownership(regions, index), words, seen)
                progress("Transcribing speech", (index + 1) / len(regions))
        return words

    # Legacy fixed-window decoding remains available for comparison, but it
    # deliberately performs no acoustic timestamp repair or singleton pruning.
    progress("Transcribing speech", 0)
    pipe, config = _configure_whisper(request, args, device)
    requested_language = request.get("language", "auto")
    with sf.SoundFile(request["input"]) as source:
        total = source.frames / source.samplerate
        for start in range(0, max(1, int(np.ceil(total))), LEGACY_STEP_SECONDS):
            source.seek(round(start * source.samplerate))
            raw = source.read(TRANSCRIBE_WINDOW_SECONDS * source.samplerate,
                              dtype="float32", always_2d=True)
            samples = resample_mono(raw, source.samplerate)
            result = pipe.generate(samples, generation_config=config)
            crop_duration = len(samples) / 16000
            _maybe_lock_auto_language(config, requested_language, result, crop_duration)
            for word in getattr(result, "words", None) or []:
                timing = _valid_word_timing(word, crop_duration)
                text = getattr(word, "word", None)
                if timing is None or not isinstance(text, str):
                    continue
                word_start, word_end = timing
                if start + word_start < 0 or start + word_end > total:
                    continue
                middle = (word_start + word_end) / 2
                if start and middle < 1:
                    continue
                if start + TRANSCRIBE_WINDOW_SECONDS < total and middle >= TRANSCRIBE_WINDOW_SECONDS - 1:
                    continue
                words.append(dict(start=start + word_start, end=start + word_end, text=text))
            progress("Transcribing speech", min(1, (start + LEGACY_STEP_SECONDS) / total))
    return words


def rewrite(request, args, device):
    import openvino_genai as genai
    progress("Improving transcript", 0)
    pipe = genai.VLMPipeline(str(getattr(args, "models", args.pack) / "cleanup"), device, PERFORMANCE_HINT="LATENCY")
    config = genai.GenerationConfig()
    config.max_new_tokens, config.do_sample, config.apply_chat_template = 2048, False, False
    # Constrain decoding to JSON; the TypeScript parser still enforces content and IDs.
    config.structured_output_config = genai.StructuredOutputConfig(json_schema='{"type":"object"}')
    results = []
    for index, messages in enumerate(request["batches"]):
        prompt = pipe.get_tokenizer().apply_chat_template(messages, True, extra_context={"enable_thinking": False})
        result = pipe.generate(prompt, generation_config=config)
        results.append(result.texts[0])
        progress("Improving transcript", (index + 1) / len(request["batches"]))
    return results


def trim_generated_voice(path, args):
    """Remove only outer model padding, retaining quiet consonants and all internal pauses."""
    trimmed = path.with_name(path.name + ".trim.wav")
    credentials = dict(user=args.uid, group=args.gid, extra_groups=[]) if os.geteuid() == 0 else {}
    edge = "silenceremove=start_periods=1:start_duration=0.01:start_threshold=-50dB:start_silence=0.04"
    try:
        subprocess.run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
                        "-af", f"{edge},areverse,{edge},areverse", "-c:a", "pcm_f32le", "-n", str(trimmed)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **credentials)
        frames = sf.info(trimmed).frames
        if not frames:
            raise ValueError("Voice model returned only silence")
        os.replace(trimmed, path)
        return frames
    finally:
        trimmed.unlink(missing_ok=True)


def synthesize(request, args, device):
    styles = {"original": "", "conversational": "natural conversational narration, relaxed pacing and gently varied intonation",
              "cosy": "warm, cosy, gentle and reassuring tone",
              "calm": "calm, relaxed and steady delivery", "professional": "clear, confident professional narration",
              "energetic": "lively, enthusiastic and energetic delivery"}
    style = request.get("voiceStyle", "original")
    if not isinstance(style, str) or style not in styles:
        raise ValueError("Invalid narration voice style")
    progress("Recreating narration", 0)
    model = None
    durations = []
    for index, phrase in enumerate(request["phrases"]):
        if CANCELLED.is_set():
            raise InterruptedError("Narration cancelled")
        output = Path(phrase["output"])
        if output.exists():
            cached = sf.info(output)
            if cached.samplerate == 48000 and 0 < cached.frames < 90 * 48000:
                durations.append(cached.frames / 48000)
                progress("Recreating narration", (index + 1) / len(request["phrases"]))
                continue
            raise ValueError("Incomplete cached narration; analyze the selection again")
        np.random.seed(42)
        if model is None:
            helper = load_voxcpm_helper(args.pack / "voxcpm2_tts_helper.py")
            model = cache_encoded_wav(helper.OVVoxCPM2Model(
                str(getattr(args, "models", args.pack) / "voice"), device=device))
        # Main selects the reviewed shared original-speaker reference. The
        # high-fidelity path uses that same clip as speaker and continuation prompt.
        # Explicit styles use the upstream controllable-cloning path: retain
        # speaker timbre without a continuation prompt overriding the requested tone.
        conditioning = {} if style != "original" else dict(prompt_wav_path=phrase["reference"],
                                                          prompt_text=phrase["referenceText"].rstrip() + " ")
        text = phrase["text"] if style == "original" else f"({styles[style]}){phrase['text']}"
        # Sentence length is independent of the short voice reference. Decode
        # bounded streaming chunks, not a full sentence-sized VAE activation.
        temporary = output.with_name(output.name + f".{os.getpid()}.part.wav")
        samples = 0
        try:
            with AudioWriter(str(temporary), 1, args) as sink:
                for chunk in model.generate_streaming(text, reference_wav_path=phrase["reference"], **conditioning,
                                                      inference_timesteps=10, max_len=1125,
                                                      streaming_prefix_len=STREAMING_PREFIX_LEN):
                    if CANCELLED.is_set():
                        raise InterruptedError("Narration cancelled")
                    samples += chunk.size
                    if samples >= 90 * 48000:
                        raise ValueError("A sentence exceeded the voice model's limit; shorten its reviewed text")
                    sink.write(chunk)
            if not samples:
                raise ValueError("Voice model returned empty audio")
            samples = trim_generated_voice(temporary, args)
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)
        durations.append(samples / 48000)
        progress("Recreating narration", (index + 1) / len(request["phrases"]))
    return durations


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--models", type=Path)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--uid", type=int, required=True)
    parser.add_argument("--gid", type=int, required=True)
    parser.add_argument("--cpu", action="store_true")
    args = parser.parse_args()
    args.models = args.models or args.pack
    import openvino as ov
    core = ov.Core()
    devices = [] if args.cpu else [name for name in core.available_devices if name.startswith("GPU") and
                                  "B580" in str(core.get_property(name, "FULL_DEVICE_NAME"))]
    device = devices[0] if len(devices) == 1 else "CPU"
    emit(dict(ready=True, hardware="dGPU" if device != "CPU" else "CPU"))
    actions = dict(separate=separate, transcribe=transcribe, rewrite=rewrite, synthesize=synthesize)
    requests = queue.Queue(maxsize=1)

    def receive():
        while True:
            line = sys.stdin.buffer.readline(4_000_001)
            if not line:
                CANCELLED.set()
                requests.put(None)
                return
            if len(line) > 4_000_000 or not line.endswith(b"\n"):
                CANCELLED.set()
                requests.put(None)
                return
            requests.put(line)

    threading.Thread(target=receive, daemon=True).start()
    while not CANCELLED.is_set():
        line = requests.get()
        if line is None:
            break
        request = json.loads(line)
        if request.get("action") == "close":
            break
        try:
            # Helpers may print compilation diagnostics: never mix those with
            # the machine-readable response channel.
            with contextlib.redirect_stdout(sys.stderr):
                action = actions[request["action"]]
                result = action(request, args, device)
            gc.collect()
            emit(dict(result=result))
        except Exception as error:
            gc.collect()
            emit(dict(error=str(error)))


if __name__ == "__main__":
    main()
