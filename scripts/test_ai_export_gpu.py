#!/usr/bin/env python3
"""Bounded native AI-worker GPU validation; the caller owns GPU admission."""

from __future__ import annotations

import argparse
from array import array
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

CHUNK = 1 << 20
SOURCE_SEED = "testsrc2-fixed-20261019"
PROGRESS = re.compile(r"^otc-ai-enhance: progress=([^\s]+)$")
CASES = {
    "ranges": dict(width=3840, height=2160, fps=60.0, frames=30, out=30, output_width=3840,
                   output_height=2160, output_fps=60.0, ranges=((4, 10), (20, 26)), flash=True),
    "portrait": dict(width=1080, height=1920, fps=30.0, frames=15, out=30, output_width=2160,
                     output_height=3840, output_fps=60.0, ranges=(), flash=True),
    "rife": dict(width=64, height=64, fps=30.0, frames=2, out=4, output_width=64,
                 output_height=64, output_fps=60.0, ranges=(), flash=False),
    "near60": dict(width=64, height=64, fps=58.436707235803205, frames=59, out=60, output_width=64,
                   output_height=64, output_fps=60.0, ranges=(), flash=False, duration=1.0),
}


def die(message: str) -> None:
    raise RuntimeError(message)


def real_dir(path: Path, label: str) -> Path:
    if not path.is_dir() or path.is_symlink():
        die(f"{label} must be a real directory: {path}")
    return path


def new_work(path: Path) -> Path:
    if os.path.lexists(path):
        die(f"--work must be a new leaf, already exists: {path}")
    temporary = Path(tempfile.gettempdir()).resolve()
    destination = path.parent.resolve()
    if os.path.commonpath((str(destination), str(temporary))) == str(temporary):
        die(f"--work must be on the destination disk, not {temporary}: {path}")
    real_dir(path.parent, "work parent")
    os.mkdir(path, 0o700)
    os.chmod(path, 0o700)
    if path.is_symlink() or stat.S_IMODE(os.lstat(path).st_mode) != 0o700:
        die(f"work directory is not a private 0700 leaf: {path}")
    return path


def digest(path: Path, offset: int = 0, size: int | None = None) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        stream.seek(offset)
        if size is None:
            for chunk in iter(lambda: stream.read(CHUNK), b""):
                result.update(chunk)
        else:
            data = stream.read(size)
            if len(data) != size:
                die(f"short frame at offset {offset} in {path}")
            result.update(data)
    return result.hexdigest()


def tree_digest(path: Path) -> str:
    result = hashlib.sha256()
    for child in sorted(path.rglob("*")):
        if child.is_file() and not child.is_symlink():
            result.update(str(child.relative_to(path)).encode())
            result.update(bytes.fromhex(digest(child)))
    return result.hexdigest()


def terminate_owned(process: subprocess.Popen[bytes] | None) -> None:
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
    process.wait()


def stream(source_command: list[str], worker_command: list[str], source_path: Path,
           output_path: Path, source_log: Path, worker_log: Path,
           expected_source_bytes: int) -> tuple[int, float]:
    started = time.monotonic()
    source: subprocess.Popen[bytes] | None = None
    worker: subprocess.Popen[bytes] | None = None
    source_count = 0
    try:
        with source_log.open("wb") as source_errors, worker_log.open("wb") as worker_errors, \
                source_path.open("wb") as source_file, output_path.open("wb") as output_file:
            source = subprocess.Popen(source_command, stdout=subprocess.PIPE, stderr=source_errors)
            worker = subprocess.Popen(worker_command, stdin=subprocess.PIPE, stdout=output_file,
                                      stderr=worker_errors)
            if source.stdout is None or worker.stdin is None:
                die("failed to create the bounded RGB stream")
            try:
                while chunk := source.stdout.read(CHUNK):
                    source_file.write(chunk)
                    source_count += len(chunk)
                    worker.stdin.write(chunk)
            finally:
                source.stdout.close()
            if source_count != expected_source_bytes:
                die(f"source RGB byte count {source_count} != {expected_source_bytes}")
            worker.stdin.close()
            source_status, worker_status = source.wait(), worker.wait()
            if source_status != 0:
                die(f"ffmpeg source exited {source_status}; see {source_log}")
            if worker_status != 0:
                die(f"AI worker exited {worker_status}; see {worker_log}")
    except BaseException:
        if worker is not None and worker.stdin is not None:
            try:
                worker.stdin.close()
            except OSError:
                pass
        terminate_owned(worker)
        terminate_owned(source)
        raise
    return output_path.stat().st_size, time.monotonic() - started


def diagnostics(path: Path) -> tuple[list[str], list[str], list[str]]:
    lines = path.read_text(errors="replace").splitlines()
    return ([line for line in lines if line.startswith("otc-ai-enhance: flash-device=")],
            [line for line in lines if line.startswith("otc-ai-enhance: rife-device=")],
            [line for line in lines if PROGRESS.match(line)])


def check(case: str, config: dict, source: Path, output: Path, log: Path, output_size: int) -> dict:
    source_bytes = config["width"] * config["height"] * 3
    output_bytes = config["output_width"] * config["output_height"] * 3
    if output_size % output_bytes:
        die(f"output has a partial RGB frame: {output_size} bytes")
    output_frames = output_size // output_bytes
    if output_frames != config["out"]:
        die(f"output frame count {output_frames} != {config['out']}")
    flash, rife, progress = diagnostics(log)
    values = [float(PROGRESS.match(line).group(1)) for line in progress]
    if any(value < 0.0 or value > 1.0 for value in values):
        die("worker progress escaped [0,1]")
    if any(b + 1.0e-12 < a for a, b in zip(values, values[1:])):
        die("worker progress regressed")
    if case == "ranges":
        # Device markers also report later decoder ownership handoffs; they
        # are not a one-marker-per-range activation counter.
        if len([line for line in flash if "hardware=dGPU" in line]) < 2 or rife:
            die("ranges case did not report dGPU Flash handoffs and no RIFE")
        allowed = tuple((a / config["frames"], b / config["frames"]) for a, b in config["ranges"])
        if not values or any(not any(a - 1e-6 <= value <= b + 1e-6 for a, b in allowed) for value in values):
            die("range progress escaped the selected source intervals")
        if any(not any(abs(value - start) < 1e-6 for value in values) for start, _ in allowed):
            die("worker did not start both selected ranges")
        selected = {i for a, b in config["ranges"] for i in range(a, b)}
        changed = [i for i in range(output_frames) if i not in selected and
                   digest(source, i * source_bytes, source_bytes) != digest(output, i * output_bytes, output_bytes)]
        if changed:
            die(f"unselected landscape frames changed: {changed[:8]}")
    elif case == "portrait":
        if not any("hardware=dGPU" in line for line in flash):
            die("portrait case did not report dGPU Flash")
        if not any("hardware=dGPU" in line for line in rife):
            die("portrait 30->60 case did not report dGPU RIFE")
    elif case == "rife":
        if flash or not any("hardware=dGPU" in line for line in rife):
            die("RIFE-only case did not report only dGPU RIFE")
    else:
        if flash or rife:
            die("near-60 repeat case started Flash or RIFE")
        expected = array("Q", (min(config["frames"] - 1,
                                    int(i * config["fps"] / config["output_fps"] + 0.5))
                               for i in range(output_frames)))
        for i, source_index in enumerate(expected):
            if digest(source, source_index * source_bytes, source_bytes) != digest(output, i * output_bytes, output_bytes):
                die(f"near-60 frame {i} is not nearest source frame {source_index}")
        if "frame-rate-conversion=repeat" not in log.read_text(errors="replace"):
            die("near-60 worker did not report repeat conversion")
    return {"source_frame_count": config["frames"], "source_frame_bytes": source_bytes,
            "output_frame_bytes": output_bytes,
            "output_frame_count": output_frames, "flash_markers": flash,
            "rife_markers": rife, "progress_markers": progress}


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--models-root", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--mode", choices=("turbo", "base"), default="turbo")
    parser.add_argument("--case", choices=tuple(CASES), required=True)
    parser.add_argument("--device", default="GPU.1")
    return parser.parse_args()


def main() -> int:
    args = arguments()
    pack = real_dir(args.pack.resolve(), "pack")
    models = real_dir(args.models_root.resolve(), "models root")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        die("ffmpeg is not on PATH")
    worker, binary, rife, lib = (pack / "otc-ai-enhance", pack / "otc-ai-enhance.bin",
                                 pack / "rife.xml", pack / "lib")
    if not worker.is_file() or not os.access(worker, os.X_OK):
        die(f"AI worker is not executable: {worker}")
    if not binary.is_file():
        die(f"AI worker binary is missing: {binary}")
    if not rife.is_file():
        die(f"RIFE model is missing: {rife}")
    real_dir(lib, "pack lib")
    config = CASES[args.case]
    if config["flash"] and not (models / args.mode).is_dir():
        die(f"Flash model directory is missing: {models / args.mode}")
    work_path = args.work if args.work.is_absolute() else Path.cwd() / args.work
    work = new_work(work_path)
    scratch = Path(tempfile.mkdtemp(prefix="scratch-", dir=work))
    os.chmod(scratch, 0o700)
    if scratch.is_symlink() or stat.S_IMODE(os.lstat(scratch).st_mode) != 0o700:
        die("worker scratch is not a private 0700 directory")
    duration = config.get("duration", config["frames"] / config["fps"])
    duration_text = repr(duration)
    source_filter = f"testsrc2=size={config['width']}x{config['height']}:rate={config['fps']}:duration={duration_text}"
    source_command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1",
                      "-filter_threads", "1", "-filter_complex_threads", "1", "-f", "lavfi", "-i", source_filter,
                      "-frames:v", str(config["frames"]), "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]
    worker_command = [str(worker), "--rife", str(rife), "--width", str(config["width"]), "--height", str(config["height"]),
                      "--fps", str(config["fps"]), "--output-width", str(config["output_width"]),
                      "--output-height", str(config["output_height"]), "--output-fps", str(config["output_fps"]),
                      "--duration", duration_text, "--device", args.device]
    if config["flash"]:
        worker_command[1:1] = ["--mode", args.mode, "--models", str(models / args.mode), "--scratch", str(scratch)]
        for first, stop in config["ranges"]:
            worker_command.extend(("--spatial-range", f"{first}:{stop}"))
    source, output = work / "source.rgb", work / "worker-output.rgb"
    source_log, worker_log = work / "ffmpeg-source.stderr", work / "worker.stderr"
    expected_source_bytes = config["frames"] * config["width"] * config["height"] * 3
    started = time.monotonic()
    output_size, pipeline_elapsed = stream(source_command, worker_command, source, output, source_log, worker_log,
                                           expected_source_bytes)
    if any(scratch.iterdir()):
        die("worker left history files after successful exit")
    checks = check(args.case, config, source, output, worker_log, output_size)
    elapsed = time.monotonic() - started
    enhanced_frames = (sum(stop - first for first, stop in config['ranges'])
                       if config['ranges'] else config['frames']) if config['flash'] else 0
    report = {"case": args.case, "mode": args.mode, "device": args.device, "duration_sec": duration,
              "source_seed": SOURCE_SEED,
              "source_command": source_command, "worker_command": worker_command,
              "command_sha256": hashlib.sha256(json.dumps(worker_command, separators=(",", ":")).encode()).hexdigest(),
              "fingerprints": {"worker": digest(worker), "worker_binary": digest(binary),
                               "lib": tree_digest(lib)}, "source_sha256": digest(source),
              "output_sha256": digest(output), "elapsed_sec_wall": elapsed,
              "elapsed_sec_per_source_frame_wall": elapsed / config["frames"],
              "enhanced_source_frame_count": enhanced_frames,
              "elapsed_sec_per_enhanced_source_frame_wall": elapsed / enhanced_frames if enhanced_frames else None,
              "pipeline_elapsed_sec": pipeline_elapsed, "history_scratch_empty": True, **checks}
    (work / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
