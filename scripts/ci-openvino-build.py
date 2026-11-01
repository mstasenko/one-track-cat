#!/usr/bin/env python3
"""Build the pinned GPU plugin in four disposable CI phases."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile


ROOT = Path(__file__).resolve().parents[1]
CI_ROOT = ROOT / "dist/upscale-pack-ci"
SHARDS = 4
JOBS = 4
MAX_ARCHIVE_BYTES = 512 * 1024**2
MAX_MEMBER_BYTES = 128 * 1024**2


def _load(filename: str, name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gpu = _load("build-openvino-gpu.py", "ci_openvino_gpu")
prepare = _load("prepare-upscale-pack.py", "ci_prepare_upscale")
BuildError = gpu.BuildError


def _run(command: list[str], *, env: dict[str, str] | None = None,
         capture: bool = False) -> str:
    return gpu._run(command, env=env, capture=capture).stdout or ""


def _paths(root: Path) -> dict[str, Path]:
    return {name: root / name for name in ("source", "build", "sdk", "ccache", "artifacts", "downloads")}


def _fresh_root(mode: str) -> None:
    if mode == "shard":
        if CI_ROOT.exists() or CI_ROOT.is_symlink():
            raise BuildError(f"refusing stale CI root: {CI_ROOT}")
        CI_ROOT.mkdir(parents=True)
        return
    if CI_ROOT.is_symlink() or not CI_ROOT.is_dir():
        raise BuildError(f"CI root is not a real directory: {CI_ROOT}")
    if {child.name for child in CI_ROOT.iterdir()} != {"inputs"}:
        raise BuildError(f"refusing stale CI tree: {CI_ROOT}")
    if (CI_ROOT / "inputs").is_symlink() or not (CI_ROOT / "inputs").is_dir():
        raise BuildError("CI inputs is not a real directory")


def _safe_member(name: str) -> Path:
    if not name or name.startswith("/") or "\\" in name or "\x00" in name:
        raise BuildError(f"unsafe cache archive member: {name!r}")
    if name in (".", "./"):
        return Path(".")
    if name.startswith("./"):
        name = name[2:]
    parts = name.rstrip("/").split("/")
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise BuildError(f"unsafe cache archive member: {name!r}")
    return Path(*parts)


def _merge_cache_archives() -> Path:
    cache = CI_ROOT / "ccache"
    if cache.exists() or cache.is_symlink():
        raise BuildError(f"refusing stale ccache directory: {cache}")
    cache.mkdir()
    for index in range(SHARDS):
        archive = CI_ROOT / "inputs" / f"ccache-shard-{index}.tar"
        if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > MAX_ARCHIVE_BYTES:
            raise BuildError(f"missing, non-regular, or oversized ccache archive: {archive}")
        try:
            with tarfile.open(archive, "r:*") as stream:
                members = stream.getmembers()
                total = 0
                for member in members:
                    relative = _safe_member(member.name)
                    if not (member.isdir() or member.isreg()):
                        raise BuildError(f"cache archive member is not regular: {member.name}")
                    if member.isreg():
                        if member.size < 0 or member.size > MAX_MEMBER_BYTES or total + member.size > MAX_ARCHIVE_BYTES:
                            raise BuildError(f"cache archive expands beyond its bound: {archive}")
                        total += member.size
                    target = (cache / relative).resolve()
                    if cache.resolve() not in (target, *target.parents):
                        raise BuildError(f"cache member escapes extraction root: {member.name}")
                stream.extractall(cache, members=members, filter="data")
        except (OSError, tarfile.TarError) as exc:
            raise BuildError(f"could not read ccache archive {archive}: {exc}") from exc
    return cache


def _workspace(mode: str) -> dict[str, Path]:
    _fresh_root(mode)
    paths = _paths(CI_ROOT)
    if mode == "link":
        _merge_cache_archives()
    else:
        paths["ccache"].mkdir()
    for name in ("build", "artifacts", "downloads"):
        paths[name].mkdir()
    return paths


def _objects(graph: str) -> list[str]:
    labels = set()
    for line in graph.splitlines():
        match = re.search(r'\[label="((?:\\.|[^"])*)"\]', line)
        if match:
            label = match.group(1).replace('\\"', '"').replace('\\\\', '\\')
            path = Path(label)
            if label.endswith(".o") and not path.is_absolute() and ".." not in path.parts:
                labels.add(label)
    return sorted(labels)


def _shard_objects(objects: list[str], index: int) -> list[str]:
    if not 0 <= index < SHARDS:
        raise BuildError(f"shard index must be in [0, {SHARDS})")
    return objects[index::SHARDS]


def _stats(env: dict[str, str]) -> dict[str, int]:
    try:
        raw = _run(["ccache", "--print-log-stats", "--format=json"], env=env, capture=True)
        value = json.loads(raw)
    except (BuildError, OSError, json.JSONDecodeError) as exc:
        raise BuildError("ccache 4 JSON statistics with CCACHE_STATSLOG are required") from exc
    required = {"direct_cache_hit", "preprocessed_cache_hit", "cache_miss"}
    if not isinstance(value, dict) or not required.issubset(value):
        raise BuildError("unsupported ccache JSON statistics schema")
    return {key: int(value[key]) for key in required}


def _cache_gate(before: dict[str, int], after: dict[str, int], expected: int) -> int:
    hits = sum(after[key] - before[key] for key in ("direct_cache_hit", "preprocessed_cache_hit"))
    misses = after["cache_miss"] - before["cache_miss"]
    if misses:
        raise BuildError(f"link had compiler cache misses: {misses}")
    if hits < expected:
        raise BuildError(f"link cache hits cover {hits} of {expected} object targets")
    return hits


def _configure(staged: Path, sdk: Path, paths: dict[str, Path]) -> tuple[dict[str, str], list[str]]:
    cmake = paths["build"] / "cmake"
    if cmake.exists():
        raise BuildError(f"refusing to reuse CMake directory: {cmake}")
    ccache = shutil.which("ccache")
    if not ccache:
        raise BuildError("ccache is required")
    flags = [flag for flag in gpu._cmake_flags(staged, sdk)
             if not flag.startswith("-DENABLE_FASTER_BUILD=")]
    flags += ["-DENABLE_FASTER_BUILD=OFF",
              f"-DCMAKE_C_COMPILER_LAUNCHER={ccache}",
              f"-DCMAKE_CXX_COMPILER_LAUNCHER={ccache}"]
    env = dict(os.environ)
    env.update({"CI_BUILD_NUMBER": gpu.CI_BUILD_NUMBER, "CCACHE_DIR": str(paths["ccache"]), "CCACHE_BASEDIR": str(ROOT),
                "CCACHE_STATSLOG": str(paths["ccache"] / "stats.log"),
                "CCACHE_COMPILERCHECK": "content", "CCACHE_COMPRESS": "true",
                "CMAKE_BUILD_PARALLEL_LEVEL": str(JOBS)})
    _run(["cmake", "-S", str(staged), "-B", str(cmake), *flags], env=env)
    return env, flags


def _build(mode: str, index: int, paths: dict[str, Path], output: Path | None) -> None:
    runtime = gpu._runtime_pin()
    sdk_pin = runtime.get("sdkCore")
    if not isinstance(sdk_pin, dict):
        raise BuildError("runtime pin has no authenticated SDK core")
    prepare.node_pins()  # Bind the wheel's name/hash to the release pin before fetching it.
    wheel = prepare.fetch(paths["downloads"], *prepare.WHEEL)
    prepare.extract_sdk(wheel, paths["sdk"])
    core = gpu._verify_sdk_core(paths["sdk"], sdk_pin)
    if mode == "link":
        output = (output or paths["artifacts"] / gpu.PLUGIN_NAME).expanduser().resolve()
        if any(output == path or path in output.parents
               for path in (paths["source"], paths["build"], paths["sdk"], paths["ccache"])):
            raise BuildError(f"plugin output must not be inside CI build inputs: {output}")
    gpu.DEFAULT_SOURCE = paths["source"]
    source, _ = gpu._ensure_source(None)
    state, submodules = gpu._source_state(source)
    staged = gpu._prepare_source(source, paths["build"], state)
    env, flags = _configure(staged, paths["sdk"], paths)
    cmake = paths["build"] / "cmake"
    graph = _run(["ninja", "-C", str(cmake), "-t", "graph",
                  "openvino_intel_gpu_plugin"], env=env, capture=True)
    objects = _objects(graph)
    if not objects or any("/openvino_core_obj.dir/" in name for name in objects):
        raise BuildError("GPU graph is empty or still rebuilds the SDK core")
    targets = _shard_objects(objects, index) if mode == "shard" else ["openvino_intel_gpu_plugin"]
    if mode == "shard" and not targets:
        raise BuildError(f"shard {index} has no object targets")
    before = _stats(env)
    _run(["ninja", "-C", str(cmake), "-j", str(JOBS), *targets], env=env)
    after = _stats(env)
    if mode == "link":
        cache_hits = _cache_gate(before, after, len(objects))
        plugin = staged / gpu.PLUGIN_RELATIVE_PATH
        gpu._regular(plugin, "generated GPU plugin")
        gpu._set_rpath(plugin)
        rpaths, needed = gpu._publish(plugin, output)
        details = {"mode": "source", "source": {"patchState": state,
            "patchMaterializedInBuildTree": True, "submodules": submodules},
            "buildFlags": [flag.replace(str(staged), "<staged-source>").replace(
                str(paths["sdk"]), "<sdk-root>") for flag in flags] +
            [f"CMAKE_BUILD_PARALLEL_LEVEL={JOBS}"], "sdkCore": core,
            "plugin": {"rpath": rpaths, "needed": needed}}
        receipt = gpu._receipt(output, details, runtime)
        receipt_path = gpu._write_receipt(output, receipt)
        prepare._verify_source_receipt(output, receipt_path, prepare.node_pins(), paths["sdk"])
        print(json.dumps({"artifact": str(output), "receipt": str(receipt_path),
                          "cacheHits": cache_hits, "cacheMisses": 0,
                          "mainObjects": len(objects)}, sort_keys=True))


def _args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("shard", "link"), required=True)
    parser.add_argument("--shard-index", type=int, choices=range(SHARDS))
    parser.add_argument("--out", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = _args(argv)
        if args.mode == "shard" and (args.shard_index is None or args.out):
            raise BuildError("shard mode requires --shard-index and forbids --out")
        if args.mode == "link" and args.shard_index is not None:
            raise BuildError("--shard-index is only valid in shard mode")
        _build(args.mode, args.shard_index or 0, _workspace(args.mode), args.out)
        return 0
    except (BuildError, ValueError, AttributeError, KeyError, OSError) as exc:
        print(f"ci-openvino-build: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
