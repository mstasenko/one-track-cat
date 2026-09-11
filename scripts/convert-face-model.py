#!/usr/bin/env python3
"""Convert the pinned OMZ RetinaFace model with CPU-only build tooling."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
from typing import NoReturn


MODEL_NAME = "retinaface-resnet50-pytorch"


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"face model conversion failed: {message}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--download-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main(args: argparse.Namespace) -> None:
    if sys.version_info[:2] != (3, 11):
        fail(f"Python 3.11 is required, got {sys.version_info.major}.{sys.version_info.minor}")

    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["otc_CPU_ONLY"] = "1"
    os.environ["OMP_NUM_THREADS"] = "4"
    os.environ["MKL_NUM_THREADS"] = "4"
    try:
        import torch
        import openvino.tools.mo
    except ImportError as error:
        fail(f"PyTorch is unavailable in the build venv: {error}")
    if torch.cuda.is_available():
        fail("CUDA is visible during conversion; use the pinned CPU wheel")
    torch.set_num_threads(4)

    model_dir = args.download_dir / "public" / MODEL_NAME
    source = model_dir / "models" / "retinaface.py"
    if not source.is_file() or "pretrained=False" not in source.read_text(encoding="utf-8"):
        fail("OMZ postprocessing did not force pretrained=False")

    command = [
        sys.executable,
        "-m",
        "omz_tools.omz_converter",
        "--name",
        MODEL_NAME,
        "--precisions",
        "FP32",
        "--download_dir",
        str(args.download_dir),
        "--output_dir",
        str(args.output_dir),
        "--jobs",
        "1",
        "--python",
        sys.executable,
        "--mo",
        str(Path(openvino.tools.mo.__file__).with_name("mo.py")),
    ]
    result = subprocess.run(command, env=os.environ.copy(), check=False)
    if result.returncode:
        fail(f"OMZ converter exited with status {result.returncode}")


if __name__ == "__main__":
    args = parse_args()
    main(args)
