"""Build-only FlashVSR+ pack recipe; no Python, Torch, or bulk checkpoint payload ships."""
import argparse
from contextlib import nullcontext
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets/flashvsr-plus"
RIFE_ASSETS = ROOT / "assets/rife"  # existing reviewed RIFE/notices source only
RIFE_WARP_ASSETS = ROOT / "native/upscale/rife-assets"
NATIVE_ASSETS = ROOT / "native/upscale/flash-assets"
CATALOG_SHA256 = "58359ac7e061107de34983e2c0de26232c9fbd8f81987fd65a89ab380a8f8184"
WHEEL = (
    "openvino-2026.5.0.dev20261014-23457-cp311-cp311-manylinux_2_28_x86_64.whl",
    0,  # checked from the authenticated response before publication
    "1eb7d70fa7228cf50abcf73ea52d09fd0b5f53c316ae7bdfe1016bf211bf911d",
    "https://storage.openvinotoolkit.org/wheels/nightly/openvino/"
    "openvino-2026.5.0.dev20261014-23457-cp311-cp311-manylinux_2_28_x86_64.whl",
)
# The wheel hash is the authority; this is only a bounded download guard
# because the historical receipt did not record the exact wheel byte count.
WHEEL_MAX_BYTES = 256 * 1024**2
DEBS = [
    ("libssl3t64_3.5.5-1ubuntu3.7_amd64.deb", 2368026,
     "3ff73e121f6cd4f19e80ab4329dfd914108b3936c9db3708200203a9b245b34d"),
    ("libssl-dev_3.5.5-1ubuntu3.7_amd64.deb", 2936724,
     "d1cf6cafb141490b7020e392964b1f901835d60cb88c3a68ef0f95ef5e930de4"),
]
RIFE_ARCHIVE = (21210600, "912fea8a9a405799cbe122605da12d6e4b5330aec83a0e026910651cb34d39fa")
NOTICES_ARCHIVE = (64876, "21b9b99d79af32fe66800fc68efb104367e1e93bf4092b6e6395eed4b48d5578")
FLASH_STRUCTURAL = [
    "flash_pre_4096_bf16.xml", "flash_pre_4096_bf16.bin",
    "flash_post_4096_bf16.xml", "flash_post_4096_bf16.bin",
    "flash_cross_kv_bf16.xml", "flash_cross_kv_bf16.bin",
    "flash_lq_projection_startup_bf16.xml", "flash_lq_projection_startup_bf16.bin",
    "flash_lq_projection_stage1_bf16.xml", "flash_lq_projection_stage1_bf16.bin",
    "flash_lq_projection_stage2_bf16.xml", "flash_lq_projection_stage2_bf16.bin",
    "flash_edges_prefix_bf16.xml", "flash_edges_prefix_bf16.bin",
    "flash_edges_suffix_bf16.xml", "flash_edges_suffix_bf16.bin",
    "flash_text_bf16.xml", "flash_text_bf16.bin",
    "flash_decoder_phased_front_bf16.xml", "flash_decoder_phased_front_bf16.bin",
    "flash_decoder_phased_grow_memory_bf16.xml", "flash_decoder_phased_grow_memory_bf16.bin",
    "flash_decoder_phased_remote_frame_child_bf16.xml",
    "flash_decoder_phased_remote_frame_child_bf16.bin",
    "plus_split_key.xml", "plus_split_key_dg2.xml",
    "bf16_cross_bridge_custom_layers.xml", "bf16_cross_bridge_20261017.cl",
    "plus_sparse_xmx.cl", "flash_fixed_conditioning_bf16_turbo.bin",
    "flash_fixed_conditioning_bf16_base.bin",
]
FLASH_COMPLEMENTS = [
    "flash_pre_4096_bf16.bin", "flash_post_4096_bf16.bin", "flash_cross_kv_bf16.bin",
    "flash_lq_projection_startup_bf16.bin", "flash_lq_projection_stage1_bf16.bin",
    "flash_lq_projection_stage2_bf16.bin", "flash_edges_prefix_bf16.bin",
    "flash_edges_suffix_bf16.bin", "flash_text_bf16.bin",
    "flash_decoder_phased_front_bf16.bin", "flash_decoder_phased_grow_memory_bf16.bin",
    "flash_decoder_phased_remote_frame_child_bf16.bin", "empty-complement",
]
FLASH_NOTICE_FILES = {
    "LICENSE-FLASHVSR-APACHE.txt": "LICENSE-FLASHVSR-APACHE.txt",
    "NOTICE-FLASHVSR.txt": "NOTICE-FLASHVSR.txt",
    "NOTICE-FLASHVSR-PROVENANCE.json": "flash_fixed_provenance.json",
}


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def check(path, size=None, sha=None, allow_empty=False):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or (not allow_empty and info.st_size == 0):
        raise ValueError("nonregular/empty source: " + str(path))
    if size is not None and info.st_size != size:
        raise ValueError("fixed size differs: " + str(path))
    actual = digest(path)
    if sha is not None and actual != sha:
        raise ValueError("fixed hash differs: " + str(path))
    return {"bytes": info.st_size, "sha256": actual}


def fetch(cache, name, size, sha, url):
    path = cache / name
    if not path.exists():
        fd, temporary = tempfile.mkstemp(prefix=name + ".part-", dir=cache)
        partial = Path(temporary)
        try:
            with os.fdopen(fd, "wb") as stream, urllib.request.urlopen(url) as response:
                total = 0
                while block := response.read(1024 * 1024):
                    total += len(block)
                    if total > (size or WHEEL_MAX_BYTES):
                        raise ValueError("download exceeds fixed/maximum size")
                    stream.write(block)
            check(partial, size or None, sha)
            try:
                os.link(partial, path)
            except FileExistsError:
                check(path, size or None, sha)
        finally:
            partial.unlink(missing_ok=True)
    check(path, size or None, sha)
    return path


def safe(name):
    return bool(name) and not name.startswith("/") and "\\" not in name and all(
        part not in ("", ".", "..") for part in name.split("/")
    )


def write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)


def copy_fixed(source, destination, allow_empty=False):
    check(source, allow_empty=allow_empty)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Path(source).open("rb") as source_stream, destination.open("xb") as target:
        shutil.copyfileobj(source_stream, target, 1024 * 1024)


def unpack_fixed(path, directory, rows):
    expected = {row["path"]: row for row in rows}
    if len(expected) != len(rows):
        raise ValueError("duplicate expected archive entry")
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) != len(expected) or len({item.filename for item in infos}) != len(infos):
            raise ValueError("archive inventory differs")
        for info in infos:
            if (not safe(info.filename) or info.filename not in expected or info.is_dir() or
                    not stat.S_ISREG(info.external_attr >> 16)):
                raise ValueError("unsafe/unexpected archive entry")
            row = expected[info.filename]
            if info.file_size != row["bytes"] or info.file_size > 32 * 1024**2:
                raise ValueError("archive member bound differs")
            data = archive.read(info)
            if hashlib.sha256(data).hexdigest() != row["sha256"]:
                raise ValueError("member hash differs")
            write(Path(directory) / info.filename, data)


def target(path, parent, directory):
    path = Path(os.path.abspath(path))
    parent = Path(parent)
    if path == parent or parent not in path.parents or path.is_symlink():
        raise ValueError("output target is outside generated root or a symlink")
    for ancestor in path.parents:
        if ancestor == ROOT:
            break
        if ancestor.is_symlink():
            raise ValueError("output target has a symlink ancestor")
    if path.exists() and (not path.is_dir() if directory else not path.is_file()):
        raise ValueError("existing output target has unexpected type")
    return path


def publish(staged, destination, directory):
    destination = target(destination, ROOT / ("dist" if directory else "release"), directory)
    destination.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if destination.exists():
        holder = Path(tempfile.mkdtemp(prefix=destination.name + ".previous-", dir=destination.parent))
        backup = holder / "previous"
        destination.rename(backup)
    try:
        if directory:
            Path(staged).rename(destination)
        else:
            os.link(staged, destination)
            Path(staged).unlink()
    except Exception:
        if backup is not None and not destination.exists() and not destination.is_symlink():
            backup.rename(destination)
        raise
    return str(backup) if backup else None


def node_pins():
    expression = ("import {releasePins,payloadPins,gpuPluginPath,gpuPluginPin,runtimeLibraryNames} "
                  "from './scripts/upscale-pack-pins.mjs'; "
                  "console.log(JSON.stringify({releasePins,payloadPins,gpuPluginPath,gpuPluginPin,runtimeLibraryNames}))")
    return json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e", expression], cwd=ROOT
    ))


def gpu_plugin_provenance(pins, path, mode):
    """Fingerprint one selected plugin and attach its authenticated build mode."""
    if mode not in ("qualified-relocation", "source"):
        raise ValueError("unsupported GPU plugin provenance mode")
    runtime = pins["releasePins"]["runtime"]
    source_revision = runtime.get("gpuSourceRevision")
    patch_sha = runtime.get("gpuPatchSha256")
    if not isinstance(source_revision, str) or not isinstance(patch_sha, str):
        raise ValueError("GPU source provenance is incomplete")
    actual = check(path)
    known = pins["gpuPluginPin"]
    if mode == "qualified-relocation" and (
            actual["bytes"] != known["bytes"] or actual["sha256"] != known["sha256"]):
        raise ValueError("qualified GPU plugin differs from the known fast path")
    return {
        "bytes": actual["bytes"], "sha256": actual["sha256"],
        "sourceRevision": source_revision, "patchSha256": patch_sha, "mode": mode,
    }


def _verify_source_receipt(plugin, receipt_path, pins):
    try:
        receipt = json.loads(Path(receipt_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("fresh GPU source build receipt is unavailable") from exc
    if not isinstance(receipt, dict):
        raise ValueError("fresh GPU source build receipt is not an object")
    actual = check(plugin)
    artifact = receipt.get("artifact")
    if (not isinstance(artifact, dict) or artifact.get("name") != Path(plugin).name or
            artifact.get("bytes") != actual["bytes"] or artifact.get("sha256") != actual["sha256"]):
        raise ValueError("fresh GPU source build receipt does not match its artifact")
    runtime = pins["releasePins"]["runtime"]
    if (receipt.get("format") != 1 or receipt.get("sourceRevision") != runtime.get("gpuSourceRevision") or
            receipt.get("patchSha256") != runtime.get("gpuPatchSha256")):
        raise ValueError("fresh GPU source build receipt source pin differs")
    wheel = receipt.get("runtimeWheel")
    if (not isinstance(wheel, dict) or wheel.get("runtimeVersion") != runtime.get("version") or
            wheel.get("version") != runtime.get("wheelVersion") or
            wheel.get("artifact") != runtime.get("artifact") or
            wheel.get("sha256") != runtime.get("artifactSha256")):
        raise ValueError("fresh GPU source build receipt runtime wheel differs")
    build = receipt.get("build")
    source = build.get("source") if isinstance(build, dict) else None
    if (not isinstance(build, dict) or build.get("mode") != "source" or
            not isinstance(source, dict) or source.get("patchMaterializedInBuildTree") is not True):
        raise ValueError("fresh GPU build was not a complete source build")
    return actual


def _build_source_gpu_plugin(work, sdk, pins):
    plugin = Path(work) / "gpu-plugin.so"
    build = Path(work) / "gpu-plugin-build"
    subprocess.run([
        sys.executable, str(ROOT / "scripts/build-openvino-gpu.py"),
        "--sdk-root", str(sdk), "--build", str(build), "--out", str(plugin),
    ], check=True)
    actual = _verify_source_receipt(plugin, Path(str(plugin) + ".buildreceipt.json"), pins)
    return plugin, actual


def select_gpu_plugin(explicit, work, sdk, pins, prepare_only=False):
    """Select only the known relocation or a freshly receipt-verified source build."""
    fastpath = ROOT / "dist/upscale-pack-cache/artifacts/libopenvino_intel_gpu_plugin-otc-reorder-cache.so"
    if explicit is not None:
        path = Path(explicit)
        gpu_plugin_provenance(pins, path, "qualified-relocation")
        return path, "qualified-relocation"
    if fastpath.exists() or fastpath.is_symlink():
        gpu_plugin_provenance(pins, fastpath, "qualified-relocation")
        return fastpath, "qualified-relocation"
    if prepare_only:
        raise ValueError("known GPU plugin is missing; --prepare-only will not run a source build")
    plugin, _ = _build_source_gpu_plugin(work, sdk, pins)
    return plugin, "source"


def load_catalog():
    catalog_path = ASSETS / "sources.json"
    check(catalog_path, 1880, CATALOG_SHA256)
    catalog = json.loads(catalog_path.read_text())
    if catalog.get("format") != 1 or catalog.get("modelId") != "flashvsr-plus":
        raise ValueError("unsupported FlashVSR+ source catalog")
    artifacts = catalog.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 6:
        raise ValueError("FlashVSR+ source catalog inventory differs")
    paths = {item.get("path") for item in artifacts}
    expected = {"turbo/dit.safetensors", "turbo/lq_proj_in.safetensors",
                "base/dit.safetensors", "base/lq_proj_in.safetensors",
                "shared/TCDecoder.ckpt", "shared/posi_prompt.pth"}
    if paths != expected or any(not isinstance(item.get("bytes"), int) or item["bytes"] <= 0 or
                                not isinstance(item.get("sha256"), str) or
                                len(item["sha256"]) != 64 or not item.get("url", "").startswith("https://")
                                for item in artifacts):
        raise ValueError("invalid FlashVSR+ source catalog entries")
    return catalog


def materialize_structural(work):
    models = Path(work) / "structure" / "flash"
    complements = Path(work) / "structure" / "flash-complements"
    for name in FLASH_STRUCTURAL:
        copy_fixed(NATIVE_ASSETS / name, models / name, allow_empty=name.endswith("flash_text_bf16.bin"))
    for name in FLASH_COMPLEMENTS:
        if name == "empty-complement":
            write(complements / name, b"")
        else:
            copy_fixed(NATIVE_ASSETS / name, complements / name,
                       allow_empty=name.endswith("flash_text_bf16.bin"))
    return models, complements


def materialize_flash_notices(work, pins):
    licenses = Path(work) / "licenses"
    for name, source_name in FLASH_NOTICE_FILES.items():
        pin = pins["payloadPins"].get(name)
        if pin is None:
            raise ValueError("missing Flash notice pin: " + name)
        source = ASSETS / source_name
        check(source, pin["bytes"], pin["sha256"])
        copy_fixed(source, licenses / name)
        check(licenses / name, pin["bytes"], pin["sha256"])


def materialize_runtime_notice(work, wheel, pins):
    runtime = pins["releasePins"]["runtime"]
    member = runtime.get("runtimeNoticeMember")
    expected_member = ("openvino-" + runtime["wheelVersion"] +
                       ".dist-info/licenses/licensing/runtime-third-party-programs.txt")
    if member != expected_member or not safe(member):
        raise ValueError("runtime notice member differs from pinned wheel")
    pin = pins["payloadPins"].get("NOTICE-OPENVINO-RUNTIME.txt")
    if pin is None:
        raise ValueError("missing OpenVINO runtime notice pin")
    with zipfile.ZipFile(wheel) as archive:
        matches = [info for info in archive.infolist() if info.filename == member]
        if len(matches) != 1:
            raise ValueError("authenticated wheel runtime notice inventory differs")
        info = matches[0]
        if info.is_dir() or not stat.S_ISREG(info.external_attr >> 16):
            raise ValueError("authenticated wheel runtime notice is not a regular file")
        data = archive.read(info)
    if len(data) != pin["bytes"] or hashlib.sha256(data).hexdigest() != pin["sha256"]:
        raise ValueError("authenticated wheel runtime notice pin differs")
    destination = Path(work) / "licenses" / "NOTICE-OPENVINO-RUNTIME.txt"
    if not destination.exists() or not stat.S_ISREG(destination.lstat().st_mode):
        raise ValueError("legacy runtime notice was not materialized")
    destination.unlink()
    write(destination, data)
    check(destination, pin["bytes"], pin["sha256"])


def check_rife_warp_assets(pins):
    for name in ("rife_warp.cl", "rife_warp.xml"):
        pin = pins["payloadPins"].get(name)
        if pin is None:
            raise ValueError("missing RIFE warp payload pin: " + name)
        check(RIFE_WARP_ASSETS / name, pin["bytes"], pin["sha256"])


def write_provenance(path, pins, catalog, structural, gpu_plugin=None):
    data = {
        "runtime": pins["releasePins"]["runtime"],
        "flash": pins["releasePins"]["flash"],
        "rife": pins["releasePins"]["rife"],
        "openssl": pins["releasePins"]["openssl"],
        "catalog": {"path": "sources.json", "bytes": 1880, "sha256": CATALOG_SHA256,
                    "modelId": catalog["modelId"], "artifacts": len(catalog["artifacts"])},
        "structural": structural,
        "bulk_learned_checkpoint_payload": "external_download_and_native_preparation",
        "derived_fixed_assets": "pinned_small_bf16_conditioning",
        "source_hashes_are_provenance_only": True,
    }
    if gpu_plugin is not None:
        if not isinstance(gpu_plugin, dict) or "path" not in gpu_plugin or "mode" not in gpu_plugin:
            raise ValueError("GPU plugin selection is incomplete")
        data["gpuPlugin"] = gpu_plugin_provenance(pins, gpu_plugin["path"], gpu_plugin["mode"])
    write(path, (json.dumps(data, indent=2) + "\n").encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true", help="validate build inputs without building or publishing")
    parser.add_argument("--native-root", type=Path, default=ROOT / "native/upscale")
    parser.add_argument("--out", type=Path, default=ROOT / "dist/upscale-pack")
    parser.add_argument("--archive", type=Path, default=ROOT / "release/otc-upscale-pack.zip")
    parser.add_argument("--gpu-plugin", type=Path, default=None,
                        help="explicitly select the known pinned relocatable GPU plugin")
    args = parser.parse_args()
    output = target(args.out, ROOT / "dist", True)
    archive_output = target(args.archive, ROOT / "release", False)
    cache = ROOT / "dist/upscale-pack-cache/artifacts"
    cache.mkdir(parents=True, exist_ok=True)
    catalog = load_catalog()
    pins = node_pins()
    check_rife_warp_assets(pins)
    with (nullcontext(tempfile.mkdtemp(prefix="prepared-", dir=cache.parent)) if args.prepare_only
          else tempfile.TemporaryDirectory(prefix="prepared-", dir=cache.parent)) as staging:
        work = Path(staging)
        models, complements = materialize_structural(work)
        assets_json = json.loads((RIFE_ASSETS / "assets.json").read_text())
        rife_path = RIFE_ASSETS / "rife-ir.zip"
        notices_path = RIFE_ASSETS / "notices.zip"
        check(rife_path, *RIFE_ARCHIVE)
        check(notices_path, *NOTICES_ARCHIVE)
        unpack_fixed(rife_path, work / "rife", assets_json["rife-ir.zip"]["files"])
        unpack_fixed(notices_path, work / "licenses", assets_json["notices.zip"]["files"])
        materialize_flash_notices(work, pins)
        wheel = fetch(cache, WHEEL[0], WHEEL[1] or None, WHEEL[2], WHEEL[3])
        materialize_runtime_notice(work, wheel, pins)
        sdk = work / "sdk"
        with zipfile.ZipFile(wheel) as archive:
            seen = set()
            for info in archive.infolist():
                if not info.filename.startswith(("openvino/include/", "openvino/cmake/", "openvino/libs/")) or info.is_dir():
                    continue
                if (not safe(info.filename) or info.filename in seen or
                        stat.S_ISLNK(info.external_attr >> 16) or info.file_size > 128 * 1024**2):
                    raise ValueError("invalid authenticated SDK entry")
                seen.add(info.filename)
                write(sdk / info.filename, archive.read(info))
        selected_gpu, gpu_mode = select_gpu_plugin(
            args.gpu_plugin, work, sdk, pins, prepare_only=args.prepare_only)
        crypto = work / "openssl"
        for name, size, sha in DEBS:
            package = fetch(cache, name, size, sha,
                            "https://us.archive.ubuntu.com/ubuntu/pool/main/o/openssl/" + name)
            subprocess.run(["dpkg-deb", "-x", str(package), str(crypto)], check=True)
        runtime = work / "runtime" / "lib"
        runtime.mkdir(parents=True)
        gpu_path = pins["gpuPluginPath"]
        gpu_name = gpu_path[4:] if gpu_path.startswith("lib/") else None
        if not gpu_name:
            raise ValueError("GPU plugin pin path must be under lib/")
        for name, pin in pins["payloadPins"].items():
            if not name.startswith("lib/"):
                continue
            basename = name[4:]
            if basename == gpu_name:
                raise ValueError("GPU plugin must be selected separately from fixed runtime pins")
            if basename == "plugins.xml":
                source = ROOT / "assets/openvino/plugins.xml"
            else:
                source = crypto / "usr/lib/x86_64-linux-gnu/libcrypto.so.3" if basename == "libcrypto.so.3" else sdk / "openvino/libs" / basename
            check(source, pin["bytes"], pin["sha256"])
            copy_fixed(source, runtime / basename)
        copy_fixed(selected_gpu, runtime / gpu_name)
        structural = [{"path": "flash/" + name, **check(models / name, allow_empty=name.endswith("flash_text_bf16.bin"))}
                      for name in FLASH_STRUCTURAL]
        structural += [{"path": "flash-complements/" + name, **check(complements / name, allow_empty=name.endswith("flash_text_bf16.bin") or name == "empty-complement")}
                       for name in FLASH_COMPLEMENTS]
        copy_fixed(ASSETS / "sources.json", work / "catalog" / "sources.json")
        write_provenance(work / "flash-provenance.json", pins, catalog, structural,
                         {"path": selected_gpu, "mode": gpu_mode})
        if args.prepare_only:
            print("PASS Flash catalog + structural assets + Flash notices + RIFE + pinned OV2026.5 SDK/runtime; bulk_learned_checkpoint_bytes=0 GPU_queries=0 staging=" + str(work))
            return
        build = work / "native-build"
        env = {**os.environ, "LD_LIBRARY_PATH": str(runtime) + ":" + str(sdk / "openvino/libs"),
               "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "1", "otc_CPU_ONLY": "1"}
        subprocess.run(["cmake", "-S", str(args.native_root), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release",
                        "-DUPSCALE_EXECUTABLE_CACHE=ON",
                        "-DUPSCALE_GPU_PLUGIN=" + str(runtime / gpu_name),
                        "-DUPSCALE_BUILD_TESTS=ON", "-DOpenVINO_DIR=" + str(sdk / "openvino/cmake"),
                        "-DOPENSSL_INCLUDE_DIR=" + str(crypto / "usr/include"),
                        "-DOPENSSL_CRYPTO_LIBRARY=" + str(runtime / "libcrypto.so.3"),
                        "-DCMAKE_CXX_FLAGS=-I" + str(crypto / "usr/include/x86_64-linux-gnu")], check=True, env=env)
        subprocess.run(["cmake", "--build", str(build), "--parallel", "2"], check=True, env=env)
        subprocess.run(["ctest", "--test-dir", str(build), "--output-on-failure"], check=True, env=env)
        subprocess.run(["node", str(ROOT / "scripts/build-upscale-pack-assemble.mjs"),
                        "--runtime", str(work / "runtime"), "--worker", str(build / "otc-upscale"),
                        "--gpu-plugin", str(runtime / gpu_name),
                        "--models", str(models), "--complements", str(complements), "--rife", str(work / "rife"),
                        "--licenses", str(work / "licenses"), "--catalog", str(work / "catalog/sources.json"),
                        "--provenance", str(work / "flash-provenance.json"), "--out", str(work / "pack"),
                        "--archive", str(work / "pack.zip")], check=True, env=env)
        subprocess.run(["node", str(ROOT / "scripts/verify-upscale-pack.mjs"), "--root", str(work / "pack"),
                        "--archive", str(work / "pack.zip")], check=True, env=env)
        backups = {"directory": publish(work / "pack", output, True),
                   "archive": publish(work / "pack.zip", archive_output, False)}
        print(json.dumps({"published": str(output), "archive": str(archive_output), "preserved_backups": backups}))


if __name__ == "__main__":
    main()
