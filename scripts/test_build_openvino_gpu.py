"""CPU-only contract tests for the OpenVINO GPU plugin recipe."""

from __future__ import annotations

import hashlib
import importlib.util
import io
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "build_openvino_gpu", Path(__file__).with_name("build-openvino-gpu.py"))
recipe = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(recipe)


def fixture_original_from_patch() -> str:
    """Create a tiny old-file fixture from the reviewed unified diff."""
    lines = recipe.PATCH_PATH.read_text(encoding="utf-8").splitlines()
    original: list[str] = []
    index = 0
    while index < len(lines):
        match = re.match(r"@@ -(\d+),(\d+) \+\d+,\d+ @@", lines[index])
        if not match:
            index += 1
            continue
        start = int(match.group(1))
        index += 1
        while len(original) < start - 1:
            original.append(f"fixture filler line {len(original) + 1}\n")
        while index < len(lines) and not lines[index].startswith("@@"):
            line = lines[index]
            if line.startswith((" ", "-")):
                original.append(line[1:] + "\n")
            index += 1
    return "".join(original)


class OpenVinoGpuRecipeTests(unittest.TestCase):
    def test_gpu_only_configure_keeps_python_311_compatible_without_bindings(self):
        options = dict(recipe.GPU_CMAKE_OPTIONS)
        self.assertEqual(options["ENABLE_GIL_PYTHON_API"], "ON")
        self.assertEqual(options["ENABLE_PYTHON"], "OFF")
        self.assertEqual(options["ENABLE_PYTHON_PACKAGING"], "OFF")

    def test_gpu_only_fetch_includes_unconditional_and_opencl_fallback_dependencies(self):
        # Root CMake configures xbyak even with CPU disabled; missing system
        # OpenCL development files select the pinned ICD-loader fallback.
        self.assertIn("thirdparty/xbyak", recipe.REQUIRED_SUBMODULES)
        self.assertIn("thirdparty/ocl/icd_loader", recipe.REQUIRED_SUBMODULES)

    def test_patch_is_reviewed_and_has_no_research_path(self):
        patch = recipe.PATCH_PATH.read_text(encoding="utf-8")
        self.assertEqual(
            hashlib.sha256(patch.encode()).hexdigest(),
            "2db5e19d91a111fe8d9803db7ad9eddc9a1a2957dc6d75e179ff47d74839e7c1",
        )
        self.assertIn(recipe.PATCH_TARGET, patch)
        self.assertNotIn("/cache/one-track-cat/", patch)

    def test_source_state_accepts_pristine_fixture(self):
        with tempfile.TemporaryDirectory(prefix="openvino-source-fixture-") as directory:
            source = Path(directory)
            for relative in recipe.REQUIRED_SUBMODULES:
                (source / relative).mkdir(parents=True)

            def fake_git(path, *arguments, capture=True):
                command = tuple(arguments)
                if command == ("rev-parse", "HEAD"):
                    return recipe.SOURCE_COMMIT + "\n" if path == source else "deadbeef\n"
                if command[:3] == ("-c", "diff.external=", "diff"):
                    return ""
                if command[:2] == ("status", "--porcelain=v1"):
                    return ""
                if command[:2] == ("ls-tree", "HEAD"):
                    relative = command[-1]
                    return f"160000 commit deadbeef {relative}\n"
                raise AssertionError(command)

            with mock.patch.object(recipe, "_git", side_effect=fake_git):
                state, submodules = recipe._source_state(source)
            self.assertEqual(state, "pristine")
            self.assertEqual(set(submodules), set(recipe.REQUIRED_SUBMODULES))

    def test_source_state_accepts_exact_existing_patch(self):
        with tempfile.TemporaryDirectory(prefix="openvino-patched-fixture-") as directory:
            source = Path(directory)
            for relative in recipe.REQUIRED_SUBMODULES:
                (source / relative).mkdir(parents=True)
            patch = recipe.PATCH_PATH.read_text(encoding="utf-8")

            def fake_git(path, *arguments, capture=True):
                command = tuple(arguments)
                if command == ("rev-parse", "HEAD"):
                    return recipe.SOURCE_COMMIT + "\n" if path == source else "deadbeef\n"
                if command[:3] == ("-c", "diff.external=", "diff"):
                    return patch
                if command[:2] == ("status", "--porcelain=v1"):
                    return " M " + recipe.PATCH_TARGET + "\n" if path == source else ""
                if command[:2] == ("ls-tree", "HEAD"):
                    relative = command[-1]
                    return f"160000 commit deadbeef {relative}\n"
                raise AssertionError(command)

            with mock.patch.object(recipe, "_git", side_effect=fake_git):
                state, _ = recipe._source_state(source)
            self.assertEqual(state, "already-patched")

    def test_source_state_rejects_unreviewed_diff(self):
        with tempfile.TemporaryDirectory(prefix="openvino-dirty-fixture-") as directory:
            source = Path(directory)

            def fake_git(path, *arguments, capture=True):
                command = tuple(arguments)
                if command == ("rev-parse", "HEAD"):
                    return recipe.SOURCE_COMMIT + "\n"
                if command[:3] == ("-c", "diff.external=", "diff"):
                    return "unreviewed diff"
                raise AssertionError(command)

            with mock.patch.object(recipe, "_git", side_effect=fake_git):
                with self.assertRaisesRegex(recipe.BuildError, "tracked changes"):
                    recipe._source_state(source)

    def test_prepare_source_applies_patch_inside_parent_git_repo(self):
        with tempfile.TemporaryDirectory(prefix="openvino-stage-fixture-") as directory:
            root = Path(directory)
            subprocess.run(["git", "-c", "init.defaultBranch=fixture", "init", "--quiet", str(root)],
                           check=True)
            source = root / "checkout"
            target = source / recipe.PATCH_TARGET
            target.parent.mkdir(parents=True)
            target.write_text(fixture_original_from_patch(), encoding="utf-8")

            staged = recipe._prepare_source(source, root / "build", "pristine")
            staged_target = staged / recipe.PATCH_TARGET
            self.assertTrue(staged_target.is_file())
            self.assertEqual(recipe._sha256(staged_target),
                             "b3b90ea414fbab1e4fdf1e26931ddc3a7023d7ea70f06c5b91cc85ac59d49cc8")
            self.assertIn("get_reorder_memory_descs", staged_target.read_text(encoding="utf-8"))

    def test_fetch_uses_exact_commit_and_required_submodules(self):
        with tempfile.TemporaryDirectory(prefix="openvino-fetch-fixture-") as directory:
            destination = Path(directory) / "openvino-source"
            calls = []

            def fake_run(command, **kwargs):
                calls.append(command)
                return mock.Mock(returncode=0, stdout="", stderr="")

            with mock.patch.object(recipe, "_run", side_effect=fake_run):
                self.assertEqual(recipe._fetch_source(destination), destination)
            self.assertEqual(calls[0][:4], ["git", "clone", "--filter=blob:none", "--no-checkout"])
            self.assertIn(recipe.SOURCE_URL, calls[0])
            self.assertEqual(calls[1][-1], recipe.SOURCE_COMMIT)
            self.assertEqual(calls[2][-1], recipe.SOURCE_COMMIT)
            self.assertEqual(calls[3][-len(recipe.REQUIRED_SUBMODULES):], list(recipe.REQUIRED_SUBMODULES))

    def test_cmake_options_are_gpu_only_and_pinned(self):
        options = dict(recipe.GPU_CMAKE_OPTIONS)
        self.assertEqual(options["ENABLE_INTEL_GPU"], "ON")
        self.assertEqual(options["GPU_RT_TYPE"], "OCL")
        for name in ("ENABLE_INTEL_CPU", "ENABLE_INTEL_NPU", "ENABLE_PROXY", "ENABLE_TESTS",
                     "ENABLE_PYTHON", "ENABLE_JS", "ENABLE_AUTO", "ENABLE_HETERO",
                     "ENABLE_MULTI", "ENABLE_TEMPLATE"):
            self.assertEqual(options[name], "OFF", name)
        self.assertEqual(options["CI_BUILD_NUMBER"], recipe.CI_BUILD_NUMBER)
        self.assertEqual(options["CMAKE_INSTALL_RPATH"], "$ORIGIN")
        self.assertEqual(options["USE_BUILD_TYPE_SUBFOLDER"], "ON")
        self.assertEqual(options["OS_FOLDER"], "OFF")
        self.assertEqual(options["ENABLE_TBBBIND_2_5"], "OFF")
        self.assertEqual(recipe.PLUGIN_RELATIVE_PATH,
                         Path("bin/intel64/Release") / recipe.PLUGIN_NAME)

    def test_readelf_contract_rejects_absolute_runpath(self):
        dynamic = " 0x000000000000001d (RUNPATH)            Library runpath: [/private/build/lib]"
        header = "  Type:                              DYN (Shared object file)"
        with tempfile.TemporaryDirectory(prefix="openvino-elf-fixture-") as directory:
            path = Path(directory) / recipe.PLUGIN_NAME
            path.write_bytes(b"fixture")
            with mock.patch.object(recipe.shutil, "which", return_value="readelf"), \
                    mock.patch.object(recipe, "_output", side_effect=[dynamic, header]):
                with self.assertRaisesRegex(recipe.BuildError, r"only \$ORIGIN"):
                    recipe._readelf_dynamic(path)

    def test_readelf_contract_accepts_only_origin_runpath(self):
        dynamic = (
            " 0x0000000000000001 (NEEDED)             Shared library: [libopenvino.so.2650]\n"
            " 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN]"
        )
        header = "  Type:                              DYN (Shared object file)"
        with tempfile.TemporaryDirectory(prefix="openvino-elf-fixture-") as directory:
            path = Path(directory) / recipe.PLUGIN_NAME
            path.write_bytes(b"fixture")
            with mock.patch.object(recipe.shutil, "which", return_value="readelf"), \
                    mock.patch.object(recipe, "_output", side_effect=[dynamic, header]):
                _, rpaths, needed = recipe._readelf_dynamic(path)
            self.assertEqual(rpaths, ["$ORIGIN"])
            self.assertEqual(needed, ["libopenvino.so.2650"])

    def test_relocation_requires_historical_pin_and_records_input(self):
        with tempfile.TemporaryDirectory(prefix="openvino-relocate-fixture-") as directory:
            root = Path(directory)
            source = root / "qualified.so"
            source.write_bytes(b"qualified plugin fixture")
            build = root / "build"
            output = root / "out" / recipe.PLUGIN_NAME
            expected = hashlib.sha256(source.read_bytes()).hexdigest()
            details = {"needed": []}
            with mock.patch.object(recipe, "_historical_plugin_sha", return_value=expected), \
                    mock.patch.object(recipe.shutil, "which", return_value="patchelf"), \
                    mock.patch.object(recipe, "_run"), \
                    mock.patch.object(recipe, "_readelf_dynamic", return_value=("dynamic", ["$ORIGIN"], [])):
                result = recipe._relocate_plugin(source, build, output)
            self.assertEqual(result["mode"], "relocate")
            self.assertEqual(result["input"]["sha256"], expected)
            self.assertEqual(output.read_bytes(), source.read_bytes())

    def test_receipt_records_actual_artifact_and_wheel_pin(self):
        with tempfile.TemporaryDirectory(prefix="openvino-receipt-fixture-") as directory:
            output = Path(directory) / recipe.PLUGIN_NAME
            output.write_bytes(b"artifact")
            runtime = {
                "version": recipe.CI_BUILD_NUMBER,
                "wheelVersion": "2026.5.0.dev20261014",
                "artifact": "openvino.whl",
                "artifactSha256": "a" * 64,
            }
            with mock.patch.object(recipe, "_version", return_value="fixture-tool"):
                receipt = recipe._receipt(output, {"source": {"patchState": "fixture"}}, runtime)
            self.assertEqual(receipt["artifact"]["bytes"], len(b"artifact"))
            self.assertEqual(receipt["artifact"]["sha256"], hashlib.sha256(b"artifact").hexdigest())
            self.assertEqual(receipt["runtimeWheel"]["sha256"], "a" * 64)
            self.assertEqual(receipt["sourceRevision"], recipe.SOURCE_COMMIT)
            self.assertEqual(receipt["patchSha256"], recipe.PATCH_SHA256)

    def test_default_source_is_optional_but_from_plugin_is_exclusive(self):
        args = recipe._parse_args(["--build", "build", "--out", "plugin.so"])
        self.assertIsNone(args.source)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            recipe._parse_args(["--source", "src", "--from-plugin", "plugin",
                                "--build", "build", "--out", "out"])


if __name__ == "__main__":
    unittest.main()
