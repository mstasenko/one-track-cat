#!/usr/bin/env python3
"""CPU-only consistency checks for the immutable FlashVSR+ source catalog."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "assets/flashvsr-plus/sources.json"
ASSETS = ROOT / "native/ai-enhance/flash-assets"
POST_PATH = ROOT / "scripts/prepare-flash-post.py"
DECODER_PATH = ROOT / "scripts/prepare-flash-decoder.py"


def _load(name: str, path: Path):
    sys.path.insert(0, str(path.parent))
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


POST = _load("flash_model_source_post_pins", POST_PATH)
DECODER = _load("flash_model_source_decoder_pins", DECODER_PATH)

MODEL_REPO = "ruchangyao/FlashVSR_plus"
MODEL_REVISION = POST.MODEL_REPO_REVISION
SOURCE_REPO = "OpenImagingLab/FlashVSR_Plus"
SOURCE_COMMIT = POST.SOURCE_COMMIT
EXPECTED_PATHS = (
    "turbo/dit.safetensors",
    "turbo/lq_proj_in.safetensors",
    "base/dit.safetensors",
    "base/lq_proj_in.safetensors",
    "shared/TCDecoder.ckpt",
    "shared/posi_prompt.pth",
)


def _read_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise AssertionError(f"{path} is not a JSON object")
    return value


class FlashModelSourceCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = _read_json(CATALOG)
        cls.artifacts = cls.catalog.get("artifacts")
        cls.by_path = {
            item["path"]: item
            for item in cls.artifacts
            if isinstance(item, dict) and isinstance(item.get("path"), str)
        }
        cls.provenance = _read_json(ASSETS / "flash_fixed_provenance.json")

    def test_manifest_is_exact_strict_model_manifest(self):
        self.assertEqual(set(self.catalog), {"format", "modelId", "artifacts"})
        self.assertEqual(self.catalog["format"], 1)
        self.assertEqual(self.catalog["modelId"], "flashvsr-plus")
        self.assertIsInstance(self.artifacts, list)
        self.assertEqual(len(self.artifacts), len(EXPECTED_PATHS))
        self.assertEqual(tuple(item["path"] for item in self.artifacts), EXPECTED_PATHS)
        for item in self.artifacts:
            self.assertEqual(set(item), {"path", "url", "bytes", "sha256"})
            self.assertIs(type(item["path"]), str)
            self.assertGreater(item["bytes"], 0)
            self.assertRegex(item["sha256"], r"^[0-9a-f]{64}$")
            parsed = urlparse(item["url"])
            self.assertEqual(parsed.scheme, "https")
            self.assertFalse(parsed.username or parsed.password or parsed.query or parsed.fragment)
            self.assertNotIn("..", item["path"].split("/"))
            self.assertNotIn("\\", item["path"])

    def test_urls_are_immutable_official_endpoints(self):
        for mode in ("turbo", "base"):
            for name in ("dit", "lq"):
                path = f"{mode}/{'dit.safetensors' if name == 'dit' else 'lq_proj_in.safetensors'}"
                expected = (
                    f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{path}"
                )
                self.assertEqual(self.by_path[path]["url"], expected)
        self.assertEqual(
            self.by_path["shared/TCDecoder.ckpt"]["url"],
            f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/TCDecoder.ckpt",
        )
        self.assertEqual(
            self.by_path["shared/posi_prompt.pth"]["url"],
            f"https://raw.githubusercontent.com/{SOURCE_REPO}/{SOURCE_COMMIT}/prompt_tensor/posi_prompt.pth",
        )

    def test_mode_and_shared_pins_match_existing_generator_and_provenance(self):
        for mode in ("turbo", "base"):
            for key, filename in (("dit", "dit.safetensors"), ("lq", "lq_proj_in.safetensors")):
                item = self.by_path[f"{mode}/{filename}"]
                bytes_, digest = POST.MODE_PINS[mode][key]
                self.assertEqual((item["bytes"], item["sha256"]), (bytes_, digest))
                if key == "dit":
                    source_record = self.provenance["modes"][mode][key]
                    self.assertEqual(source_record["bytes"], bytes_)
                    self.assertEqual(source_record["sha256"], digest)
                    self.assertEqual(source_record["model_revision"], MODEL_REVISION)
                    self.assertEqual(source_record["source_commit"], SOURCE_COMMIT)

        decoder = self.by_path["shared/TCDecoder.ckpt"]
        self.assertEqual(decoder["bytes"], DECODER.CHECKPOINT_BYTES)
        self.assertEqual(decoder["sha256"], DECODER.CHECKPOINT_SHA256)

        prompt = self.by_path["shared/posi_prompt.pth"]
        prompt_pin = self.provenance["prompt"]["outer"]
        self.assertEqual(prompt["bytes"], prompt_pin["bytes"])
        self.assertEqual(prompt["sha256"], prompt_pin["sha256"])

    def test_catalog_total_and_revision_pins_are_consistent(self):
        self.assertEqual(sum(item["bytes"] for item in self.artifacts), 13_848_123_165)
        self.assertEqual(MODEL_REVISION, "46b79520946ac67dec94d1566490690953c7debc")
        self.assertEqual(SOURCE_COMMIT, "b548a2cc2c929d3d4676f2973abe27876ec4dee7")
        self.assertEqual(DECODER.SOURCE_COMMIT, SOURCE_COMMIT)


if __name__ == "__main__":
    from test_output import run_tests
    raise SystemExit(run_tests())
