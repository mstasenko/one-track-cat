"""Prepare a fresh, torch-free optional voice-pack runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REQUIREMENTS = ROOT / "scripts/voice-pack-requirements.txt"
DIST = (ROOT / "dist").resolve()
DEV_CACHE = (ROOT / "dist/voice-pack-cache").resolve()
DEFAULT_OUTPUT = ROOT / "dist/voice-release-validation/cache"
CHUNK = 1024 * 1024
MAX_DOWNLOAD = 128 * 1024 * 1024
FILES = {
    "voxcpm2_tts_helper.py": {
        "url": "https://raw.githubusercontent.com/openvinotoolkit/openvino_notebooks/"
        "9e942df1f80bcf4e60154f78f20fafd728fc127e/notebooks/voxcpm2-tts/voxcpm2_tts_helper.py",
        "sha256": "942455d80931f5cc2b69fc37d4a0de39bf0d38fb6b0719398d05809ddc4b21af",
        "bytes": 51687,
    },
    "VoxCPM/LICENSE": {
        "url": "https://raw.githubusercontent.com/OpenBMB/VoxCPM/"
        "cce58a5b59303c9bd63d12f23afe6a49a4a80c59/LICENSE",
        "sha256": "4f10acc209addacfad28293315c74c4cd648f771ee1263a748f1781d1e0265e4",
        "bytes": 11298,
    },
    "ClearerVoice-Studio/LICENSE": {
        "url": "https://raw.githubusercontent.com/modelscope/ClearerVoice-Studio/"
        "6b3774dc79c46ae8bed2a4fa5f706f0ac8c75c61/LICENSE",
        "sha256": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
        "bytes": 11357,
    },
    "Python-LICENSE.txt": {
        "url": "https://raw.githubusercontent.com/python/cpython/v3.14.6/LICENSE",
        "sha256": "b0e25a78cffb43f4d92de8b61ccfa1f1f98ecbc22330b54b5251e7b6ba010231",
        "bytes": 13804,
    },
}
FORBIDDEN = ("torch", "nncf", "transformers", "vllm")


def fail(message: str) -> None:
    raise SystemExit(f"Voice runtime preparation failed: {message}")


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK), b""):
            hasher.update(block)
    return hasher.hexdigest()


def command(command: list[str], env: dict[str, str] | None = None, capture: bool = False) -> str:
    try:
        result = subprocess.run(command, check=True, text=True, env=env, capture_output=capture)
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or str(error)
        fail(f"command failed ({' '.join(command)}): {detail.strip()}")
    return result.stdout.strip() if capture else ""


def output_path(value: Path) -> Path:
    path = (ROOT / value if not value.is_absolute() else value).absolute()
    if ".." in path.parts:
        fail(f"output may not contain parent traversal: {path}")
    try:
        path.relative_to(DIST)
    except ValueError:
        fail(f"output must be inside dist/: {path}")
    current = path
    while current != DIST:
        if current.is_symlink():
            fail(f"output has a symlink ancestor: {current}")
        current = current.parent
    if path == DEV_CACHE or DEV_CACHE in path.parents:
        fail(f"output may not be inside the development voice cache: {path}")
    if path.exists() or path.is_symlink():
        fail(f"output already exists; choose a fresh directory: {path}")
    return path


def fetch(relative: str, record: dict[str, object], root: Path) -> None:
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix=f".{destination.name}.", suffix=".part",
                                         dir=destination.parent, delete=False) as stream:
            temporary = Path(stream.name)
            request = urllib.request.Request(record["url"], headers={"User-Agent": "OneTrackCat voice runtime"})
            try:
                response = urllib.request.urlopen(request, timeout=60)
            except OSError as error:
                fail(f"could not download {relative}: {error}")
            total = 0
            hasher = hashlib.sha256()
            with response:
                for block in iter(lambda: response.read(CHUNK), b""):
                    total += len(block)
                    if total > record["bytes"] or total > MAX_DOWNLOAD:
                        fail(f"downloaded {relative} exceeds its pinned size")
                    hasher.update(block)
                    stream.write(block)
            if total != record["bytes"] or hasher.hexdigest() != record["sha256"]:
                fail(f"downloaded {relative} checksum or size differs")
        os.replace(temporary, destination)
        temporary = None
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main() -> int:
    if sys.version_info < (3, 14):
        fail(f"voice runtime requires Python 3.14+, got {sys.version.split()[0]}")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    output = output_path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    env = os.environ.copy()
    env.update({"CUDA_VISIBLE_DEVICES": "", "PIP_DISABLE_PIP_VERSION_CHECK": "1",
                "PIP_NO_CACHE_DIR": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    try:
        for relative, record in FILES.items():
            fetch(relative, record, staging)
        command([sys.executable, "-m", "venv", str(staging / "venv")])
        runtime = staging / "venv/bin/python"
        if not runtime.exists():
            fail(f"venv did not create its Python executable: {runtime}")
        command([str(runtime), "-m", "pip", "install", "--disable-pip-version-check",
                 "--no-cache-dir", "--only-binary=:all:", "--no-deps",
                 "--index-url", "https://pypi.org/simple", "-r", str(REQUIREMENTS)], env)
        command([str(runtime), "-m", "pip", "check"], env)
        command([str(runtime), "-I", "-B", "-c",
                 "import importlib.util,librosa,numpy,openvino,openvino_genai,scipy,soundfile; "
                 "assert all(importlib.util.find_spec(name) is None for name in "
                 f"{FORBIDDEN!r})"], env)
        frozen = command([str(runtime), "-m", "pip", "freeze", "--all"], capture=True).splitlines()
        provenance = {
            "format": 1,
            "python": {"version": sys.version.split()[0], "runtime": "venv/bin/python"},
            "requirements": {"path": "scripts/voice-pack-requirements.txt", "sha256": digest(REQUIREMENTS),
                              "pipFreeze": frozen},
            "files": [{"path": relative, **record} for relative, record in FILES.items()],
            "models": "excluded; downloaded by the application",
        }
        (staging / "runtime-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
        if output.exists() or output.is_symlink():
            fail(f"output appeared while preparing; refusing to replace it: {output}")
        staging.rename(output)
    except BaseException:
        # Only this exact private staging directory is ever removed on failure.
        shutil.rmtree(staging, ignore_errors=True)
        raise
    print(f"Prepared fresh torch-free voice runtime in {output}")
    print(f"Python {sys.version.split()[0]}; no model weights")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
