"""Small torch-free Silero VAD wrapper for bounded narration transcription."""

from dataclasses import dataclass
from pathlib import Path

import numpy as np


SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512
CONTEXT_SAMPLES = 64
DEFAULT_THRESHOLD = 0.5
DEFAULT_NEGATIVE_THRESHOLD = 0.35
DEFAULT_MIN_SPEECH_SECONDS = 0.25
DEFAULT_MIN_SILENCE_SECONDS = 0.1
DEFAULT_SPEECH_PAD_SECONDS = 0.5
DEFAULT_MERGE_GAP_SECONDS = 1.5
# Keep VAD blocks and Whisper crops within the same bounded working set.
MAX_REGION_SECONDS = 30


@dataclass(frozen=True)
class SpeechSpan:
    """A VAD-confirmed speech interval in the original audio timeline."""

    start: float
    end: float


def resample_mono(samples, source_rate):
    """Downmix and resample one bounded audio block to Silero's 16 kHz input."""
    values = np.asarray(samples, dtype=np.float32)
    if values.ndim == 2:
        values = values.mean(axis=1, dtype=np.float32)
    if values.ndim != 1 or not np.isfinite(values).all():
        raise ValueError("audio block must be finite mono or finite multi-channel samples")
    if source_rate == SAMPLE_RATE:
        return values
    if not isinstance(source_rate, (int, np.integer)) or source_rate <= 0:
        raise ValueError("audio sample rate must be positive")
    from scipy.signal import resample_poly
    return resample_poly(values, SAMPLE_RATE, source_rate).astype(np.float32)


def _compile_model(path):
    import openvino as ov

    core = ov.Core()
    model = core.read_model(str(path))
    inputs = [tuple(port.shape) for port in model.inputs]
    outputs = [tuple(port.shape) for port in model.outputs]
    if inputs != [(1, FRAME_SAMPLES + CONTEXT_SAMPLES), (2, 1, 128)]:
        raise ValueError(f"unexpected VAD inputs: {inputs}")
    if outputs != [(1, 1), (2, 1, 128)]:
        raise ValueError(f"unexpected VAD outputs: {outputs}")
    return core.compile_model(model, "CPU", {
        "PERFORMANCE_HINT": "LATENCY",
        "INFERENCE_PRECISION_HINT": "f32",
        "INFERENCE_NUM_THREADS": 1,
    })


class StreamVAD:
    """Stateful 512-sample Silero inference with bounded input blocks.

    ``feed`` accepts consecutive 16 kHz blocks (normally at most 30 seconds)
    and emits only intervals that have passed the minimum-silence rule.  Audio
    is never retained after a block; only the recurrent state and 64-sample
    context cross block boundaries.
    """

    def __init__(self, model_path=None, *, compiled_model=None,
                 threshold=DEFAULT_THRESHOLD,
                 negative_threshold=None,
                 min_speech_seconds=DEFAULT_MIN_SPEECH_SECONDS,
                 min_silence_seconds=DEFAULT_MIN_SILENCE_SECONDS):
        if negative_threshold is None:
            negative_threshold = max(float(threshold) - 0.15, 0.01)
        if not 0 < threshold <= 1 or not 0 <= negative_threshold < threshold:
            raise ValueError("VAD thresholds must satisfy 0 <= negative < threshold <= 1")
        self.threshold = float(threshold)
        self.negative_threshold = float(negative_threshold)
        self.min_speech_samples = round(float(min_speech_seconds) * SAMPLE_RATE)
        self.min_silence_samples = round(float(min_silence_seconds) * SAMPLE_RATE)
        if self.min_speech_samples <= 0 or self.min_silence_samples <= 0:
            raise ValueError("VAD durations must be positive")
        self.compiled = compiled_model if compiled_model is not None else _compile_model(Path(model_path))
        self.input_port, self.state_port = self.compiled.inputs
        self.output_port, self.next_state_port = self.compiled.outputs
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros(CONTEXT_SAMPLES, dtype=np.float32)
        self.pending = np.empty(0, dtype=np.float32)
        self.next_sample = None
        self.active_start = None
        self.silence_start = None

    def _infer(self, frame):
        model_input = np.concatenate((self.context, frame), dtype=np.float32)[None, :]
        outputs = self.compiled({self.input_port: model_input, self.state_port: self.state})
        probability = float(np.asarray(outputs[self.output_port]).reshape(-1)[0])
        next_state = np.asarray(outputs[self.next_state_port], dtype=np.float32)
        self.context = model_input[0, -CONTEXT_SAMPLES:].copy()
        if (not np.isfinite(probability) or not 0 <= probability <= 1 or
                next_state.shape != (2, 1, 128) or not np.isfinite(next_state).all()):
            raise ValueError("VAD returned invalid output state")
        self.state = next_state.copy()
        return probability

    def _process_frame(self, frame, valid):
        frame_start = self.next_sample / SAMPLE_RATE
        self.next_sample += valid
        frame_end = self.next_sample / SAMPLE_RATE
        return self._consume(self._infer(frame), frame_start, frame_end)

    def _consume(self, probability, frame_start, frame_end):
        if probability >= self.threshold:
            if self.active_start is None:
                self.active_start = frame_start
            self.silence_start = None
            return None
        if self.active_start is None or probability >= self.negative_threshold:
            return None
        if self.silence_start is None:
            self.silence_start = frame_start
        if frame_end - self.silence_start < self.min_silence_samples / SAMPLE_RATE:
            return None
        span = SpeechSpan(self.active_start, self.silence_start)
        self.active_start = None
        self.silence_start = None
        return span if span.end - span.start >= self.min_speech_samples / SAMPLE_RATE else None

    def feed(self, samples, start_seconds=None, *, cancelled=None):
        values = np.asarray(samples, dtype=np.float32)
        if values.ndim != 1 or not np.isfinite(values).all():
            raise ValueError("VAD input must be finite mono samples")
        if cancelled is not None and cancelled():
            raise InterruptedError("Narration cancelled")
        if self.next_sample is None:
            self.next_sample = round(0 if start_seconds is None else float(start_seconds) * SAMPLE_RATE)
        elif start_seconds is not None and abs((self.next_sample + self.pending.size) / SAMPLE_RATE -
                                               float(start_seconds)) > 0.002:
            raise ValueError("VAD blocks are not consecutive")
        if self.pending.size:
            values = np.concatenate((self.pending, values), dtype=np.float32)
        spans = []
        full = len(values) - len(values) % FRAME_SAMPLES
        body, self.pending = values[:full], values[full:].copy()
        for offset in range(0, len(body), FRAME_SAMPLES):
            if cancelled is not None and cancelled():
                raise InterruptedError("Narration cancelled")
            span = self._process_frame(body[offset:offset + FRAME_SAMPLES], FRAME_SAMPLES)
            if span is not None:
                spans.append(span)
        return spans

    def finish(self, end_seconds=None):
        spans = []
        if self.pending.size:
            valid = len(self.pending)
            frame = np.pad(self.pending, (0, FRAME_SAMPLES - valid))
            span = self._process_frame(frame, valid)
            self.pending = np.empty(0, dtype=np.float32)
            if span is not None:
                spans.append(span)
        if self.active_start is not None:
            end = self.next_sample / SAMPLE_RATE if end_seconds is None else float(end_seconds)
            span = SpeechSpan(self.active_start, end)
            if span.end - span.start >= self.min_speech_samples / SAMPLE_RATE:
                spans.append(span)
        self.active_start = None
        self.silence_start = None
        return spans


def merge_speech_regions(spans, duration, *, pad_seconds=DEFAULT_SPEECH_PAD_SECONDS,
                         merge_gap_seconds=DEFAULT_MERGE_GAP_SECONDS,
                         max_seconds=MAX_REGION_SECONDS):
    """Merge nearby VAD spans and add bounded Whisper context around them.

    The returned ``speech`` intervals remain unpadded for ownership at a
    padded-crop overlap. ``start`` and ``end`` define the Whisper input crop.
    """
    ordered = sorted((SpeechSpan(float(span.start), float(span.end)) if hasattr(span, "start")
                      else SpeechSpan(float(span["start"]), float(span["end"])) for span in spans),
                     key=lambda span: span.start)
    if duration <= 0 or pad_seconds < 0 or max_seconds <= 2 * pad_seconds:
        raise ValueError("invalid VAD region bounds")
    limit = max_seconds - 2 * pad_seconds
    pieces = []
    for span in ordered:
        if span.end <= span.start:
            continue
        start = span.start
        while span.end - start > limit:
            pieces.append(SpeechSpan(start, start + limit))
            start += limit
        pieces.append(SpeechSpan(start, span.end))
    merged = []
    for span in pieces:
        if (merged and span.start - merged[-1][-1].end <= merge_gap_seconds and
                span.end - merged[-1][0].start <= limit):
            merged[-1].append(span)
        else:
            merged.append([span])
    result = []
    for group in merged:
        speech = [(span.start, span.end) for span in group]
        start = max(0.0, speech[0][0] - pad_seconds)
        end = min(float(duration), speech[-1][1] + pad_seconds)
        result.append({"start": start, "end": end, "speech": speech})
    return result
