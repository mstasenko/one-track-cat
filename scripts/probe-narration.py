"""Bounded B580-only narration probes; no application state is changed.

Feed the messages produced by src/narration-cleanup.ts as JSON on stdin.
Run in the isolated voice test environment; this is not the installed worker.
"""

import argparse
import importlib.util
import json
from pathlib import Path
import resource
import sys
import time
import wave
from narration_voice import load_voxcpm_helper


def report(**values):
    print(json.dumps(values, ensure_ascii=False), flush=True)


def cleanup(args, device, genai):
    payload = sys.stdin.read(64_001)
    if len(payload) > 64_000:
        raise ValueError("Cleanup input is too large")
    messages = json.loads(payload)
    if not isinstance(messages, list) or len(messages) != 2:
        raise ValueError("Expected system and user cleanup messages")
    for entry, role in zip(messages, ("system", "user")):
        if not isinstance(entry, dict) or entry.get("role") != role or not isinstance(entry.get("content"), str):
            raise ValueError("Invalid cleanup message")

    started = time.monotonic()
    # The official Qwen3.5 artifact takes inputs_embeds and multimodal RoPE.
    # Use its supported loader, but pass no images/video: only text is inferred.
    pipe = genai.VLMPipeline(args.model, device, PERFORMANCE_HINT="LATENCY")
    report(stage="compiled", seconds=time.monotonic() - started)
    prompt = pipe.get_tokenizer().apply_chat_template(
        messages, True, extra_context={"enable_thinking": False}
    )
    config = genai.GenerationConfig()
    config.max_new_tokens = 256
    config.do_sample = False
    config.apply_chat_template = False
    for iteration in range(args.repeats):
        started = time.monotonic()
        result = pipe.generate(prompt, generation_config=config)
        report(stage="generated", iteration=iteration, seconds=time.monotonic() - started,
               peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
               text=result.texts[0])
    # Normal process exit releases all infer requests and GPU resources.
    del pipe


def transcribe(args, device, genai):
    import numpy as np

    with wave.open(str(args.audio), "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
            raise ValueError("ASR fixture must be mono 16 kHz signed 16-bit PCM")
        if not 0 < audio.getnframes() <= 30 * 16000:
            raise ValueError("ASR probe supports up to 30 seconds")
        pcm = audio.readframes(audio.getnframes())
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
    started = time.monotonic()
    # Cross-attention scores must be exposed before compilation; enabling word
    # timestamps only on generate() is too late for the stateful decoder.
    pipe = genai.WhisperPipeline(args.model, device, PERFORMANCE_HINT="LATENCY", word_timestamps=True)
    report(stage="compiled", seconds=time.monotonic() - started)
    config = pipe.get_generation_config()
    config.language = f"<|{args.language}|>"
    config.task = "transcribe"
    config.return_timestamps = True
    config.word_timestamps = True
    config.max_new_tokens = 256
    started = time.monotonic()
    result = pipe.generate(samples, generation_config=config)
    report(stage="transcribed", seconds=time.monotonic() - started, text=result.texts,
           chunks=[dict(start=item.start_ts, end=item.end_ts, text=item.text) for item in result.chunks or []],
           words=[dict(start=item.start_ts, end=item.end_ts, text=item.word) for item in result.words or []],
           peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    del pipe


def convert(args):
    # Build-only CPU PyTorch; the separate inference environment stays torch-free.
    import torch

    if not torch.__version__.endswith("+cpu"):
        raise RuntimeError("Use the isolated CPU-only PyTorch conversion environment")
    helper = load_voxcpm_helper(args.helper)
    torch.set_num_threads(4)
    started = time.monotonic()
    report(stage="converting", hardware="CPU", torch=torch.__version__)
    helper.convert_voxcpm2_model(str(args.model), str(args.output))
    report(stage="converted", seconds=time.monotonic() - started,
           peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


def synthesize(args, device):
    import numpy as np
    import soundfile as sf

    if importlib.util.find_spec("torch") is not None:
        raise RuntimeError("Use the torch-free OpenVINO inference environment")
    payload = sys.stdin.read(4001)
    if len(payload) > 4000:
        raise ValueError("Synthesis probe input is too large")
    request = json.loads(payload)
    for name in ("text", "referenceTranscript"):
        if not isinstance(request.get(name), str) or not 0 < len(request[name]) <= 160:
            raise ValueError("Synthesis probe requires short text and referenceTranscript")
    helper = load_voxcpm_helper(args.helper)
    started = time.monotonic()
    model = helper.OVVoxCPM2Model(str(args.model), device=device)
    report(stage="compiled", seconds=time.monotonic() - started)
    for iteration in range(args.repeats):
        np.random.seed(42)
        started = time.monotonic()
        audio, rate = model.generate(
            request["text"], prompt_wav_path=str(args.audio), prompt_text=request["referenceTranscript"],
            inference_timesteps=10, max_len=100,
        )
        elapsed = time.monotonic() - started
        if audio.ndim != 1 or not audio.size or not np.isfinite(audio).all():
            raise ValueError("Synthesis produced invalid audio")
        output = args.output.with_name(f"{args.output.stem}-{iteration}{args.output.suffix}")
        sf.write(output, audio, rate, subtype="FLOAT")
        duration = audio.size / rate
        report(stage="synthesized", iteration=iteration, seconds=elapsed, audio_seconds=duration,
               real_time_factor=elapsed / duration, output=str(output),
               limit_reached=audio.size >= 100 * model.patch_size * model.decode_chunk_size,
               peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    del model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("cleanup", "transcribe", "convert", "synthesize"))
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--repeats", type=int, choices=range(1, 4), default=2)
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--language", choices=("en", "ru"), default="en")
    parser.add_argument("--helper", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.mode == "transcribe" and args.audio is None:
        parser.error("transcribe requires --audio")
    if args.mode == "synthesize" and (args.audio is None or args.helper is None or args.output is None):
        parser.error("synthesize requires --audio, --helper and --output")
    if args.mode == "convert":
        if args.helper is None or args.output is None:
            parser.error("convert requires --helper and --output")
        convert(args)
        return
    import openvino as ov
    import openvino_genai as genai

    core = ov.Core()
    # Discovery is Intel-only and selection explicit; never use AUTO/default.
    matches = [
        device for device in core.available_devices
        if device.startswith("GPU") and "B580" in str(core.get_property(device, "FULL_DEVICE_NAME"))
    ]
    if len(matches) != 1:
        raise RuntimeError("Exactly one accessible Intel Arc B580 is required")
    device = matches[0]
    report(stage="starting", mode=args.mode, device=device,
           name=str(core.get_property(device, "FULL_DEVICE_NAME")),
           openvino=ov.__version__, genai=genai.__version__)
    if args.mode == "cleanup":
        cleanup(args, device, genai)
    elif args.mode == "transcribe":
        transcribe(args, device, genai)
    else:
        synthesize(args, device)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        report(stage="failed", error=str(error))
        sys.exit(1)
