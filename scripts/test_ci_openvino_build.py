#!/usr/bin/env python3
"""CPU-only contract and tiny toolchain tests for ci-openvino-build.py."""

from __future__ import annotations

import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

from test_output import run_tests


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("ci_openvino_build_test_target",
                                              ROOT / "scripts/ci-openvino-build.py")
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CiOpenvinoBuildTests(unittest.TestCase):
    def test_four_shards_are_deterministic_and_disjoint(self):
        objects = [f"obj/{index:02d}.o" for index in range(13)]
        shards = [MODULE._shard_objects(objects, index) for index in range(MODULE.SHARDS)]
        self.assertEqual(set().union(*map(set, shards)), set(objects))
        self.assertEqual(sum(map(len, shards)), len(objects))
        self.assertEqual(shards, [MODULE._shard_objects(objects, index) for index in range(4)])
        self.assertTrue(all(set(left).isdisjoint(right)
                            for left, right in zip(shards, shards[1:])))

    def test_graph_parser_excludes_unsafe_or_non_object_labels(self):
        graph = "\n".join([
            '"x" [label="src/a.o"]', '"y" [label="../private.o"]',
            '"z" [label="/tmp/private.o"]', '"q" [label="src/a.cc"]'])
        self.assertEqual(MODULE._objects(graph), ["src/a.o"])

    def test_workspace_leaves_source_and_sdk_for_authenticated_helpers(self):
        with tempfile.TemporaryDirectory(prefix="ci-openvino-workspace-") as directory:
            root = Path(directory) / "upscale-pack-ci"
            with mock.patch.object(MODULE, "CI_ROOT", root):
                paths = MODULE._workspace("shard")
            self.assertFalse(paths["source"].exists())
            self.assertFalse(paths["sdk"].exists())
            self.assertTrue(paths["build"].is_dir())
            self.assertTrue(paths["ccache"].is_dir())

    def test_workspace_refuses_stale_source_or_build_tree(self):
        with tempfile.TemporaryDirectory(prefix="ci-openvino-stale-") as directory:
            root = Path(directory) / "upscale-pack-ci"
            (root / "source").mkdir(parents=True)
            with mock.patch.object(MODULE, "CI_ROOT", root), \
                    self.assertRaisesRegex(MODULE.BuildError, "stale CI root"):
                MODULE._workspace("shard")
            (root / "source").rename(root / "inputs")
            (root / "build").mkdir()
            with mock.patch.object(MODULE, "CI_ROOT", root), \
                    self.assertRaisesRegex(MODULE.BuildError, "stale CI tree"):
                MODULE._workspace("link")

    def _write_tar(self, path: Path, entries: list[tarfile.TarInfo | tuple[str, bytes]]) -> None:
        with tarfile.open(path, "w") as archive:
            for entry in entries:
                if isinstance(entry, tuple):
                    name, data = entry
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
                else:
                    archive.addfile(entry)

    def _cache_archives(self, inputs: Path) -> None:
        inputs.mkdir(parents=True)
        for index in range(MODULE.SHARDS):
            root = tarfile.TarInfo("./")
            root.type = tarfile.DIRTYPE
            directory = tarfile.TarInfo(f"./{index}/")
            directory.type = tarfile.DIRTYPE
            self._write_tar(inputs / f"ccache-shard-{index}.tar", [
                root, directory, (f"./{index}/object", f"object-{index}".encode())])

    def test_fixed_cache_archives_merge_with_bounded_regular_members(self):
        with tempfile.TemporaryDirectory(prefix="ci-openvino-cache-") as directory:
            root = Path(directory) / "upscale-pack-ci"
            self._cache_archives(root / "inputs")
            with mock.patch.object(MODULE, "CI_ROOT", root):
                cache = MODULE._merge_cache_archives()
            self.assertEqual((cache / "0/object").read_bytes(), b"object-0")
            self.assertEqual((cache / "3/object").read_bytes(), b"object-3")

    def test_cache_archive_rejects_traversal_and_symlink(self):
        with tempfile.TemporaryDirectory(prefix="ci-openvino-unsafe-cache-") as directory:
            root = Path(directory) / "upscale-pack-ci"
            inputs = root / "inputs"
            inputs.mkdir(parents=True)
            self._write_tar(inputs / "ccache-shard-0.tar", [("../escape", b"no")])
            with mock.patch.object(MODULE, "CI_ROOT", root), \
                    self.assertRaisesRegex(MODULE.BuildError, "unsafe cache archive"):
                MODULE._merge_cache_archives()

            root = Path(directory) / "other-ci"
            inputs = root / "inputs"
            inputs.mkdir(parents=True)
            link = tarfile.TarInfo("link")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            self._write_tar(inputs / "ccache-shard-0.tar", [link])
            with mock.patch.object(MODULE, "CI_ROOT", root), \
                    self.assertRaisesRegex(MODULE.BuildError, "not regular"):
                MODULE._merge_cache_archives()

    def test_link_gate_rejects_misses_and_partial_object_coverage(self):
        before = {"direct_cache_hit": 0, "preprocessed_cache_hit": 0,
                  "cache_miss": 0}
        with self.assertRaisesRegex(MODULE.BuildError, "compiler cache misses"):
            MODULE._cache_gate(before, {**before, "cache_miss": 1}, 1)
        with self.assertRaisesRegex(MODULE.BuildError, "cover 2 of 3"):
            MODULE._cache_gate(before, {**before, "direct_cache_hit": 2}, 3)
        MODULE._cache_gate(before, {**before, "direct_cache_hit": 3}, 3)
        MODULE._cache_gate(before, {**before, "preprocessed_cache_hit": 3,
                                    "direct_cache_miss": 3}, 3)

    def test_configure_forces_pch_off_and_pins_stats_log(self):
        with tempfile.TemporaryDirectory(prefix="ci-openvino-configure-") as directory:
            root = Path(directory) / "ci"
            paths = MODULE._paths(root)
            for path in paths.values():
                path.mkdir(parents=True)
            with mock.patch.object(MODULE.gpu, "_cmake_flags",
                                   return_value=["-G", "Ninja", "-DENABLE_FASTER_BUILD=ON"]), \
                    mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/ccache"), \
                    mock.patch.object(MODULE, "_run") as run:
                environment, flags = MODULE._configure(root / "source", root / "sdk", paths)
            self.assertIn("-DENABLE_FASTER_BUILD=OFF", flags)
            self.assertNotIn("-DENABLE_FASTER_BUILD=ON", flags)
            self.assertEqual(environment["CCACHE_STATSLOG"], str(root / "ccache/stats.log"))
            run.assert_called_once()

    def test_tiny_cmake_ninja_ccache_hit_lifecycle(self):
        run = MODULE.gpu._run

        def capture_run(command, **kwargs):
            return run(command, **{**kwargs, "capture": True})

        with tempfile.TemporaryDirectory(prefix="ci-openvino-toolchain-") as directory, \
                mock.patch.object(MODULE.gpu, "_run", side_effect=capture_run):
            root = Path(directory) / "ci"
            paths = MODULE._paths(root)
            for name in ("source", "build", "sdk", "ccache", "artifacts", "downloads"):
                paths[name].mkdir(parents=True)
            paths["source"].joinpath("CMakeLists.txt").write_text(
                "cmake_minimum_required(VERSION 3.20)\nproject(fixture C)\n"
                "add_library(fixture SHARED fixture.c)\n", encoding="utf-8")
            paths["source"].joinpath("fixture.c").write_text(
                "int fixture_value(void) { return 7; }\n", encoding="utf-8")
            with mock.patch.object(MODULE.gpu, "_cmake_flags",
                                   return_value=["-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release"]):
                environment, flags = MODULE._configure(paths["source"], paths["sdk"], paths)
            self.assertIn("-DENABLE_FASTER_BUILD=OFF", flags)
            cmake = paths["build"] / "cmake"
            graph = MODULE._run(["ninja", "-C", str(cmake), "-t", "graph", "fixture"],
                                env=environment, capture=True)
            objects = MODULE._objects(graph)
            self.assertEqual(len(objects), 1)
            MODULE._run(["ninja", "-C", str(cmake), "-j", "4", "fixture"], env=environment)
            MODULE._run(["ninja", "-C", str(cmake), "-t", "clean"], env=environment)
            before = MODULE._stats(environment)
            MODULE._run(["ninja", "-C", str(cmake), "-j", "4", "fixture"], env=environment)
            after = MODULE._stats(environment)
            MODULE._cache_gate(before, after, len(objects))


if __name__ == "__main__":
    raise SystemExit(run_tests())
