#!/usr/bin/env python3
"""Build or safely relocate the pinned OpenVINO reorder-cache GPU plugin."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
PATCH_PATH = ROOT / "assets/openvino/reorder-cache.patch"
PATCH_SHA256 = "2db5e19d91a111fe8d9803db7ad9eddc9a1a2957dc6d75e179ff47d74839e7c1"
QUALIFICATION_PATH = ROOT / "native/ai-enhance/flash-assets/flash_attention_provenance.json"
DEFAULT_SOURCE = ROOT / "dist/ai-pack-cache/openvino-source"
SOURCE_URL = "https://github.com/openvinotoolkit/openvino.git"
SOURCE_COMMIT = "7d81aad55a539c827049ac9628ba4f8d5abb4539"
CI_BUILD_NUMBER = "2026.5.0-23457-7d81aad55a5"
PLUGIN_NAME = "libopenvino_intel_gpu_plugin.so"
PLUGIN_RELATIVE_PATH = Path("bin/intel64/Release") / PLUGIN_NAME
PATCH_TARGET = "src/plugins/intel_gpu/src/graph/impls/onednn/reorder_onednn.cpp"
RPATH = "$ORIGIN"
JOBS = 2
REQUIRED_SUBMODULES = (
    "src/plugins/intel_gpu/thirdparty/onednn_gpu",
    "thirdparty/ocl/cl_headers",
    "thirdparty/ocl/clhpp_headers",
    "thirdparty/ocl/icd_loader",
    "thirdparty/xbyak",
    "thirdparty/json/nlohmann_json",
    "thirdparty/pugixml",
)

# Keep this tuple public: the CPU contract tests and release review inspect it
# as the complete GPU-only configure policy.
_GPU_ON = (
    "BUILD_SHARED_LIBS ENABLE_LIBRARY_VERSIONING ENABLE_INTEL_GPU ENABLE_ONEDNN_FOR_GPU ENABLE_CM_FOR_GPU "
    "USE_BUILD_TYPE_SUBFOLDER "
    "ENABLE_SYSTEM_OPENCL ENABLE_SYSTEM_TBB ENABLE_GIL_PYTHON_API"
).split()
_GPU_OFF = (
    "ENABLE_INTEL_CPU ENABLE_INTEL_NPU ENABLE_PROXY ENABLE_AUTO ENABLE_AUTO_BATCH "
    "ENABLE_HETERO ENABLE_MULTI ENABLE_TEMPLATE ENABLE_TESTS ENABLE_FUNCTIONAL_TESTS "
    "ENABLE_SAMPLES ENABLE_DOCS ENABLE_PYTHON ENABLE_PYTHON_PACKAGING "
    "ENABLE_WHEEL ENABLE_PKGCONFIG_GEN ENABLE_JS ENABLE_PLUGINS_XML ENABLE_TBBBIND_2_5 "
    "ENABLE_PROFILING_ITT ENABLE_DEBUG_CAPS ENABLE_OV_ONNX_FRONTEND "
    "ENABLE_OV_PADDLE_FRONTEND ENABLE_OV_IR_FRONTEND ENABLE_OV_PYTORCH_FRONTEND "
    "ENABLE_OV_JAX_FRONTEND ENABLE_OV_TF_FRONTEND ENABLE_OV_TF_LITE_FRONTEND "
    "ENABLE_OV_GGUF_FRONTEND ENABLE_SYSTEM_PUGIXML ENABLE_SYSTEM_FLATBUFFERS "
    "ENABLE_SYSTEM_PROTOBUF ENABLE_SYSTEM_SNAPPY ENABLE_SYSTEM_LEVEL_ZERO OS_FOLDER"
).split()
# GIL=OFF requests Python 3.13+ even when bindings are disabled. Keep it ON
# for the build-only Python 3.11 interpreter; ENABLE_PYTHON remains OFF.
GPU_CMAKE_OPTIONS = tuple((name, "ON") for name in _GPU_ON) + (
    ("GPU_RT_TYPE", "OCL"), ("THREADING", "TBB"), ("CMAKE_BUILD_TYPE", "Release"),
    ("CMAKE_BUILD_RPATH_USE_ORIGIN", "ON"), ("CMAKE_INSTALL_RPATH", RPATH),
    ("CMAKE_INSTALL_RPATH_USE_LINK_PATH", "OFF"), ("CMAKE_BUILD_WITH_INSTALL_RPATH", "ON"),
    ("CMAKE_SKIP_RPATH", "OFF"), ("CMAKE_SKIP_INSTALL_RPATH", "OFF"),
    ("CI_BUILD_NUMBER", CI_BUILD_NUMBER),
) + tuple((name, "OFF") for name in _GPU_OFF)


class BuildError(RuntimeError):
    """A checked input, source, tool, or output violated the recipe."""


def _run(command: list[str], *, cwd: Path | None = None,
         env: dict[str, str] | None = None, capture: bool = False) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            env=env,
            check=True,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", None) or getattr(exc, "stdout", None) or str(exc)
        raise BuildError(f"command failed: {' '.join(command)}: {detail}") from exc


def _output(command: list[str], *, cwd: Path | None = None) -> str:
    return _run(command, cwd=cwd, capture=True).stdout or ""


def _git(source: Path, *arguments: str) -> str:
    return _output(["git", "-C", str(source), *arguments])


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _patch_bytes() -> bytes:
    try:
        data = PATCH_PATH.read_bytes()
    except OSError as exc:
        raise BuildError(f"reviewed source patch is unavailable: {PATCH_PATH}") from exc
    if hashlib.sha256(data).hexdigest() != PATCH_SHA256:
        raise BuildError("checked-in OpenVINO source patch has an unexpected SHA")
    return data


def _regular(path: Path, label: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise BuildError(f"{label} must be a regular file: {path}")


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _source_state(source: Path) -> tuple[str, dict[str, str]]:
    if source.is_symlink() or not source.is_dir():
        raise BuildError(f"source must be a real directory: {source}")
    if _git(source, "rev-parse", "HEAD").strip() != SOURCE_COMMIT:
        raise BuildError(f"source HEAD is not pinned to {SOURCE_COMMIT}")

    patch = _patch_bytes()
    diff = _git(source, "-c", "diff.external=", "diff", "--binary",
                "--no-ext-diff", "HEAD", "--").encode()
    if not diff:
        state = "pristine"
    elif diff == patch:
        state = "already-patched"
    else:
        raise BuildError("source has tracked changes other than the reviewed patch")

    status = [line for line in _git(source, "status", "--porcelain=v1").splitlines() if line]
    for line in status:
        code, name = line[:2], line[3:]
        if name != PATCH_TARGET or code not in {" M", "M ", "MM"}:
            raise BuildError(f"source has unexpected dirty or untracked entry: {line}")
    if state == "pristine" and status:
        raise BuildError("pristine source has unexpected status entries")
    if state == "already-patched" and not status:
        raise BuildError("patched source diff is not represented by a tracked status entry")

    submodules: dict[str, str] = {}
    for relative in REQUIRED_SUBMODULES:
        tree = _git(source, "ls-tree", "HEAD", "--", relative).strip().split()
        if len(tree) < 3 or tree[0] != "160000" or tree[1] != "commit":
            raise BuildError(f"required source gitlink is missing or not a commit: {relative}")
        path = source / relative
        if path.is_symlink() or not path.is_dir():
            raise BuildError(f"required submodule is not initialized: {relative}")
        revision = _git(path, "rev-parse", "HEAD").strip()
        if revision != tree[2]:
            raise BuildError(f"submodule revision differs from source gitlink: {relative}")
        if _git(path, "status", "--porcelain=v1").strip():
            raise BuildError(f"required submodule is dirty: {relative}")
        submodules[relative] = revision
    return state, submodules


def _fetch_source(destination: Path) -> Path:
    if destination.exists() or destination.is_symlink():
        raise BuildError(f"canonical source destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    _run(["git", "clone", "--filter=blob:none", "--no-checkout", "--no-tags",
          SOURCE_URL, str(destination)])
    _run(["git", "-C", str(destination), "fetch", "--depth=1", "origin", SOURCE_COMMIT])
    _run(["git", "-C", str(destination), "checkout", "--detach", SOURCE_COMMIT])
    _run(["git", "-C", str(destination), "-c", "submodule.fetchJobs=1", "submodule",
          "update", "--init", "--recursive", "--depth=1", "--", *REQUIRED_SUBMODULES])
    return destination


def _ensure_source(argument: Path | None) -> tuple[Path, bool]:
    if argument is not None:
        candidate = argument.expanduser()
        if candidate.is_symlink():
            raise BuildError(f"explicit source path must not be a symlink: {candidate}")
        return candidate.resolve(), False
    if DEFAULT_SOURCE.exists():
        if DEFAULT_SOURCE.is_symlink() or not DEFAULT_SOURCE.is_dir():
            raise BuildError(f"canonical source path is not a real directory: {DEFAULT_SOURCE}")
        remote = _git(DEFAULT_SOURCE, "remote", "get-url", "origin").strip().rstrip("/")
        if remote != SOURCE_URL:
            raise BuildError(f"canonical source remote is not {SOURCE_URL}")
        return DEFAULT_SOURCE.resolve(), False
    return _fetch_source(DEFAULT_SOURCE), True


def _ignore_source(directory: str, names: list[str]) -> set[str]:
    # Build products are deliberately not copied; source symlinks are retained
    # and checked below so a build cannot silently consume a private path.
    return {name for name in names if name in {".git", "bin", "build", "_build", "temp",
                                                "__pycache__", ".pytest_cache"}}


def _check_internal_links(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_symlink() and not _inside(path.resolve(strict=False), root):
            raise BuildError(f"source contains an external symlink: {path}")


def _prepare_source(source: Path, build: Path, state: str) -> Path:
    staged = build / "source"
    shutil.copytree(source, staged, symlinks=True, ignore=_ignore_source)
    _check_internal_links(staged)
    target = staged / PATCH_TARGET
    _regular(target, "staged reorder source")
    tool = shutil.which("patch")
    if not tool:
        raise BuildError("GNU patch is required to stage the reviewed source patch")

    def apply(reverse: bool, dry_run: bool) -> None:
        command = [tool, "--batch", "--fuzz=0"]
        if dry_run:
            command.append("--dry-run")
        if reverse:
            command.append("--reverse")
        command.extend(["-p1", "-i", str(PATCH_PATH)])
        _run(command, cwd=staged)

    try:
        if state == "already-patched":
            apply(True, True)
            apply(True, False)
        apply(False, True)
        apply(False, False)
    except BuildError as exc:
        raise BuildError(f"could not apply the reviewed source patch: {exc}") from exc
    return staged


def _runtime_pin() -> dict[str, str]:
    expression = "import('./scripts/ai-pack-pins.mjs').then(m => process.stdout.write(JSON.stringify(m.releasePins.runtime)))"
    try:
        value = json.loads(_output(["node", "--input-type=module", "-e", expression], cwd=ROOT))
    except (BuildError, json.JSONDecodeError) as exc:
        raise BuildError("could not read scripts/ai-pack-pins.mjs runtime pin") from exc
    required = {"version", "wheelVersion", "artifact", "artifactSha256"}
    if (not isinstance(value, dict) or not required.issubset(value) or
            not isinstance(value["artifactSha256"], str) or
            not re.fullmatch(r"[0-9a-f]{64}", value["artifactSha256"])):
        raise BuildError("runtime pin is incomplete or has an invalid wheel SHA")
    if value["version"] != CI_BUILD_NUMBER or value.get("gpuSourceRevision") != SOURCE_COMMIT:
        raise BuildError("runtime pin does not match the pinned OpenVINO source/build")
    return value


def _historical_plugin_sha() -> str:
    try:
        record = json.loads(QUALIFICATION_PATH.read_text(encoding="utf-8"))
        value = record["accepted_a770_1050"]["patched_plugin_sha256"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise BuildError("historical qualified plugin SHA is unavailable") from exc
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise BuildError("historical qualified plugin SHA is invalid")
    return value


def _readelf_dynamic(path: Path) -> tuple[str, list[str], list[str]]:
    tool = shutil.which("readelf")
    if not tool:
        raise BuildError("readelf is required to verify the generated plugin")
    dynamic = _output([tool, "-dW", str(path)])
    header = _output([tool, "-hW", str(path)])
    if not re.search(r"Type:\s+DYN\s+\(Shared object file\)", header):
        raise BuildError("generated plugin is not an ELF shared object")
    entries = re.findall(r"\((?:RPATH|RUNPATH)\).*?\[([^]]*)\]", dynamic)
    if entries != [RPATH]:
        raise BuildError("generated plugin must have only $ORIGIN RPATH/RUNPATH")
    needed = re.findall(r"\(NEEDED\).*?\[([^]]+)\]", dynamic)
    if any("/" in name for name in needed):
        raise BuildError("generated plugin has an absolute or relative-path NEEDED entry")
    return dynamic, entries, needed


def _set_rpath(path: Path) -> None:
    tool = shutil.which("patchelf")
    if not tool:
        raise BuildError("patchelf is required to normalize the generated plugin")
    _run([tool, "--set-rpath", RPATH, str(path)])


def _publish(staged: Path, output: Path) -> tuple[list[str], list[str]]:
    _regular(staged, "generated plugin")
    if output.exists() or output.is_symlink():
        raise BuildError(f"refusing to overwrite output: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(staged, output)
    _regular(output, "published plugin")
    _, rpaths, needed = _readelf_dynamic(output)
    return rpaths, needed


def _relocate_plugin(source: Path, build: Path, output: Path) -> dict[str, object]:
    _regular(source, "historical qualified plugin")
    input_sha = _sha256(source)
    expected = _historical_plugin_sha()
    if input_sha != expected:
        raise BuildError("--from-plugin is not the historically qualified plugin SHA")
    build.mkdir(parents=True, exist_ok=True)
    staged = build / PLUGIN_NAME
    if staged.exists() or staged.is_symlink():
        raise BuildError(f"refusing to overwrite relocation staging file: {staged}")
    shutil.copy2(source, staged)
    _set_rpath(staged)
    published_rpaths, published_needed = _publish(staged, output)
    return {
        "mode": "relocate",
        "input": {"name": source.name, "bytes": source.stat().st_size, "sha256": input_sha},
        "plugin": {"rpath": published_rpaths, "needed": published_needed},
    }


def _cmake_flags(source: Path, sdk: Path | None) -> list[str]:
    flags = ["-G", "Ninja"]
    flags.extend(f"-D{name}={value}" for name, value in GPU_CMAKE_OPTIONS)
    flags.extend([
        f"-DCMAKE_C_FLAGS=-ffile-prefix-map={source}=/openvino-source",
        f"-DCMAKE_CXX_FLAGS=-ffile-prefix-map={source}=/openvino-source",
    ])
    if sdk is not None:
        cmake = sdk / "openvino" / "cmake"
        if not cmake.is_dir():
            raise BuildError(f"SDK root lacks openvino/cmake: {sdk}")
        flags.extend([f"-DCMAKE_PREFIX_PATH={cmake}", f"-DTBB_DIR={cmake}"])
    return flags


def _build(source: Path, build: Path, output: Path, sdk: Path | None,
           state: str, submodules: dict[str, str]) -> dict[str, object]:
    staged = _prepare_source(source, build, state)
    cmake_build = build / "cmake"
    flags = _cmake_flags(staged, sdk)
    env = dict(os.environ)
    env.update({"CI_BUILD_NUMBER": CI_BUILD_NUMBER, "CMAKE_BUILD_PARALLEL_LEVEL": str(JOBS)})
    if sdk is not None:
        env["TBB_DIR"] = str(sdk / "openvino" / "cmake")
    _run(["cmake", "-S", str(staged), "-B", str(cmake_build), *flags], env=env)
    _run(["cmake", "--build", str(cmake_build), "--target", "openvino_intel_gpu_plugin",
          "--parallel", str(JOBS)], env=env)
    plugin = staged / PLUGIN_RELATIVE_PATH
    _regular(plugin, "generated GPU plugin")
    _set_rpath(plugin)
    published_rpaths, published_needed = _publish(plugin, output)
    sanitized = [flag.replace(str(staged), "<staged-source>") for flag in flags]
    if sdk is not None:
        sanitized = [flag.replace(str(sdk), "<sdk-root>") for flag in sanitized]
    return {
        "mode": "source",
        "source": {
            "patchState": state,
            "patchMaterializedInBuildTree": True,
            "submodules": submodules,
        },
        "buildFlags": sanitized + [f"CMAKE_BUILD_PARALLEL_LEVEL={JOBS}"],
        "plugin": {"rpath": published_rpaths, "needed": published_needed},
    }


def _version(command: str) -> str:
    tool = shutil.which(command)
    if not tool:
        return "unavailable"
    try:
        result = subprocess.run([tool, "--version"], check=True, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except (OSError, subprocess.CalledProcessError):
        return "unavailable"
    return (result.stdout or "").splitlines()[0][:240] or "unknown"


def _receipt(output: Path, details: dict[str, object], runtime: dict[str, str]) -> dict[str, object]:
    _patch_bytes()
    return {
        "format": 1,
        "artifact": {"name": output.name, "bytes": output.stat().st_size,
                      "sha256": _sha256(output)},
        "sourceRevision": SOURCE_COMMIT,
        "patchSha256": PATCH_SHA256,
        "build": details,
        "runtimeWheel": {
            "runtimeVersion": runtime["version"], "version": runtime["wheelVersion"],
            "artifact": runtime["artifact"], "sha256": runtime["artifactSha256"],
        },
        "compiler": {name: _version(tool) for name, tool in {
            "cmake": "cmake", "ninja": "ninja", "c": os.environ.get("CC", "cc"),
            "cxx": os.environ.get("CXX", "c++"), "patchelf": "patchelf",
        }.items()},
    }


def _write_receipt(output: Path, receipt: dict[str, object]) -> Path:
    path = output.with_name(output.name + ".buildreceipt.json")
    if path.exists() or path.is_symlink():
        raise BuildError(f"refusing to overwrite build receipt: {path}")
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--source", type=Path, help="prepared OpenVINO checkout; defaults to the pinned cache checkout")
    source.add_argument("--from-plugin", type=Path, help="historically qualified plugin to relocate")
    parser.add_argument("--sdk-root", type=Path, help="extracted authenticated pinned wheel SDK")
    parser.add_argument("--build", type=Path, required=True, help="empty disposable build directory")
    parser.add_argument("--out", type=Path, required=True, help="new plugin output path")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parse_args(argv)
        build = args.build.expanduser().resolve()
        output = args.out.expanduser().resolve()
        if output.exists() or output.is_symlink():
            raise BuildError(f"refusing to overwrite output: {output}")
        if build.is_symlink() or (build.exists() and not build.is_dir()):
            raise BuildError(f"build path must be a directory: {build}")
        if build.exists() and any(build.iterdir()):
            raise BuildError(f"build directory must be empty: {build}")
        if _inside(output, build):
            raise BuildError("output must not be inside the build directory")
        build.mkdir(parents=True, exist_ok=True)
        runtime = _runtime_pin()
        if args.from_plugin:
            candidate = args.from_plugin.expanduser()
            if candidate.is_symlink():
                raise BuildError(f"--from-plugin must not be a symlink: {candidate}")
            source = candidate.resolve()
            details = _relocate_plugin(source, build, output)
        else:
            source, fetched = _ensure_source(args.source)
            sdk = args.sdk_root.expanduser().resolve() if args.sdk_root else None
            if _inside(build, source) or _inside(source, build):
                raise BuildError("source and build directories must not contain one another")
            if _inside(output, source) or _inside(output, build):
                raise BuildError("output must not be inside source or build directories")
            state, submodules = _source_state(source)
            details = _build(source, build, output, sdk, state, submodules)
            details["source"]["fetchedByRecipe"] = fetched
        receipt = _receipt(output, details, runtime)
        receipt_path = _write_receipt(output, receipt)
        print(json.dumps({"artifact": str(output), "sha256": receipt["artifact"]["sha256"],
                          "receipt": str(receipt_path)}, sort_keys=True))
        return 0
    except BuildError as exc:
        print(f"build-openvino-gpu: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
