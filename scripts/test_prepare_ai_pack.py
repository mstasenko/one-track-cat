"""CPU-only contract tests for the FlashVSR+ pack recipe."""
import importlib.util
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile
from unittest import mock

spec = importlib.util.spec_from_file_location('prepare_ai_pack', Path(__file__).with_name('prepare-ai-pack.py'))
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)


class FlashPackRecipeTests(unittest.TestCase):
    def test_cache_runtime_cmake_policy_and_known_pin_registry_match_release(self):
        pins = recipe.node_pins()
        plugin = pins['gpuPluginPin']
        self.assertEqual(plugin, {
            'bytes': 44933800,
            'sha256': '10fd499296809c69a165e403a09fd2bd9bcdc6823c34e252c48e1295d2daab48'})
        self.assertEqual(pins['gpuPluginPath'], 'lib/libopenvino_intel_gpu_plugin.so')
        self.assertNotIn(pins['gpuPluginPath'], pins['payloadPins'])
        cmake = (recipe.ROOT / 'native/ai-enhance/CMakeLists.txt').read_text()
        self.assertIn('AI_ENHANCE_GPU_PLUGIN', cmake)
        self.assertIn('AI_ENHANCE_EXECUTABLE_CACHE', cmake)
        registry = recipe.ROOT / 'assets/openvino/plugins.xml'
        self.assertEqual(recipe.check(registry), pins['payloadPins']['lib/plugins.xml'])
        self.assertNotIn('/cache', registry.read_text())
        self.assertIn('-DAI_ENHANCE_EXECUTABLE_CACHE=ON', Path(recipe.__file__).read_text())

    def test_gpu_selection_uses_fastpath_or_fresh_source_only(self):
        pins = recipe.node_pins()
        plugin_bytes = b'known fast path'
        pins['gpuPluginPin'] = {
            'bytes': len(plugin_bytes),
            'sha256': hashlib.sha256(plugin_bytes).hexdigest()}
        with tempfile.TemporaryDirectory(prefix='flash-pack-gpu-select-') as directory:
            root = Path(directory)
            fastpath = root / 'dist/ai-pack-cache/artifacts/libopenvino_intel_gpu_plugin-otc-reorder-cache.so'
            fastpath.parent.mkdir(parents=True)
            fastpath.write_bytes(plugin_bytes)
            old_root = recipe.ROOT
            recipe.ROOT = root
            try:
                selected, mode = recipe.select_gpu_plugin(None, root / 'work', root / 'sdk', pins,
                                                          prepare_only=True)
            finally:
                recipe.ROOT = old_root
            self.assertEqual(selected, fastpath)
            self.assertEqual(mode, 'qualified-relocation')

        with tempfile.TemporaryDirectory(prefix='flash-pack-gpu-source-') as directory:
            root = Path(directory)
            plugin = root / 'work/gpu-plugin.so'
            plugin.parent.mkdir()
            plugin.write_bytes(b'fresh source build')
            old_root = recipe.ROOT
            recipe.ROOT = root
            try:
                with mock.patch.object(recipe, '_build_source_gpu_plugin', return_value=(plugin, recipe.check(plugin))) as builder:
                    selected, mode = recipe.select_gpu_plugin(None, root / 'work', root / 'sdk', pins)
            finally:
                recipe.ROOT = old_root
            self.assertEqual(selected, plugin)
            self.assertEqual(mode, 'source')
            builder.assert_called_once_with(root / 'work', root / 'sdk', pins)

    def test_invalid_known_fastpath_is_rejected(self):
        pins = recipe.node_pins()
        with tempfile.TemporaryDirectory(prefix='flash-pack-gpu-invalid-') as directory:
            root = Path(directory)
            fastpath = root / 'dist/ai-pack-cache/artifacts/libopenvino_intel_gpu_plugin-otc-reorder-cache.so'
            fastpath.parent.mkdir(parents=True)
            fastpath.write_bytes(b'not the qualified plugin')
            old_root = recipe.ROOT
            recipe.ROOT = root
            try:
                with self.assertRaisesRegex(ValueError, 'known fast path'):
                    recipe.select_gpu_plugin(None, root / 'work', root / 'sdk', pins, prepare_only=True)
            finally:
                recipe.ROOT = old_root

    def test_gpu_provenance_records_dynamic_source_fingerprint(self):
        pins = recipe.node_pins()
        with tempfile.TemporaryDirectory(prefix='flash-pack-gpu-provenance-') as directory:
            directory = Path(directory)
            plugin = directory / 'gpu-plugin.so'
            plugin.write_bytes(b'fresh source plugin')
            output = directory / 'flash-provenance.json'
            recipe.write_provenance(output, pins, recipe.load_catalog(), [],
                                    {'path': plugin, 'mode': 'source'})
            gpu = json.loads(output.read_text(encoding='utf-8'))['gpuPlugin']
            self.assertEqual(gpu['bytes'], plugin.stat().st_size)
            self.assertEqual(gpu['sha256'], hashlib.sha256(plugin.read_bytes()).hexdigest())
            self.assertEqual(gpu['sourceRevision'], pins['releasePins']['runtime']['gpuSourceRevision'])
            self.assertEqual(gpu['patchSha256'], pins['releasePins']['runtime']['gpuPatchSha256'])
            self.assertEqual(gpu['mode'], 'source')

    def test_source_receipt_must_match_fixed_source_patch_wheel_and_output(self):
        pins = recipe.node_pins()
        runtime = pins['releasePins']['runtime']
        with tempfile.TemporaryDirectory(prefix='flash-pack-gpu-receipt-') as directory:
            directory = Path(directory)
            plugin = directory / 'gpu-plugin.so'
            plugin.write_bytes(b'fresh source plugin')
            receipt_path = directory / 'gpu-plugin.so.buildreceipt.json'
            receipt_path.write_text(json.dumps({
                'format': 1,
                'artifact': {'name': plugin.name, **recipe.check(plugin)},
                'sourceRevision': runtime['gpuSourceRevision'],
                'patchSha256': runtime['gpuPatchSha256'],
                'runtimeWheel': {
                    'runtimeVersion': runtime['version'], 'version': runtime['wheelVersion'],
                    'artifact': runtime['artifact'], 'sha256': runtime['artifactSha256']},
                'build': {'mode': 'source', 'source': {'patchMaterializedInBuildTree': True}}
            }), encoding='utf-8')
            self.assertEqual(recipe._verify_source_receipt(plugin, receipt_path, pins), recipe.check(plugin))
            receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
            receipt['patchSha256'] = '0' * 64
            receipt_path.write_text(json.dumps(receipt), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'source pin'):
                recipe._verify_source_receipt(plugin, receipt_path, pins)

    def test_immutable_catalog_and_mode_inventory(self):
        catalog = recipe.load_catalog()
        self.assertEqual(catalog['modelId'], 'flashvsr-plus')
        self.assertEqual({item['path'] for item in catalog['artifacts']}, {
            'turbo/dit.safetensors', 'turbo/lq_proj_in.safetensors',
            'base/dit.safetensors', 'base/lq_proj_in.safetensors',
            'shared/TCDecoder.ckpt', 'shared/posi_prompt.pth'})

    def test_tampered_catalog_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='flash-pack-catalog-') as directory:
            directory = Path(directory)
            original_assets = recipe.ASSETS
            recipe.ASSETS = directory
            try:
                (directory / 'sources.json').write_bytes(b'{}')
                with self.assertRaisesRegex(ValueError, 'fixed size|fixed hash'):
                    recipe.load_catalog()
            finally:
                recipe.ASSETS = original_assets

    def test_structural_materialization_has_no_bulk_checkpoint_payload(self):
        with tempfile.TemporaryDirectory(prefix='flash-pack-structure-') as directory:
            directory = Path(directory)
            source = directory / 'native-assets'
            source.mkdir()
            # Exercise materialization with an isolated source fixture rather
            # than reaching into private cache artifacts. Fixed conditioning
            # BINs are checked against native provenance in the focused test.
            for name in recipe.FLASH_STRUCTURAL:
                source_path = recipe.NATIVE_ASSETS / name
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                self.assertTrue(source_path.is_file(), source_path)
                shutil.copyfile(source_path, target)
            old_assets = recipe.NATIVE_ASSETS
            recipe.NATIVE_ASSETS = source
            try:
                models, complements = recipe.materialize_structural(directory / 'output')
            finally:
                recipe.NATIVE_ASSETS = old_assets
            self.assertEqual({path.name for path in models.iterdir()}, set(recipe.FLASH_STRUCTURAL))
            self.assertEqual({path.name for path in complements.iterdir()}, set(recipe.FLASH_COMPLEMENTS))
            self.assertEqual((complements / 'empty-complement').stat().st_size, 0)
            self.assertFalse(any(path.suffix in {'.safetensors', '.ckpt', '.pth'}
                                 for path in models.rglob('*')))

    def test_runtime_notice_replaces_legacy_member_from_authenticated_wheel(self):
        with tempfile.TemporaryDirectory(prefix='flash-pack-runtime-notice-') as directory:
            directory = Path(directory)
            pins = recipe.node_pins()
            member = pins['releasePins']['runtime']['runtimeNoticeMember']
            data = b'authenticated runtime third-party notice\n'
            wheel = directory / 'runtime.whl'
            with zipfile.ZipFile(wheel, 'w') as archive:
                info = zipfile.ZipInfo(member)
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, data)
            licenses = directory / 'licenses'
            licenses.mkdir()
            (licenses / 'NOTICE-OPENVINO-RUNTIME.txt').write_bytes(b'legacy archive text')
            pins['payloadPins']['NOTICE-OPENVINO-RUNTIME.txt'] = {
                'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            recipe.materialize_runtime_notice(directory, wheel, pins)
            self.assertEqual((licenses / 'NOTICE-OPENVINO-RUNTIME.txt').read_bytes(), data)

    def test_fixed_assets_and_flash_notices_are_pinned(self):
        pins = recipe.node_pins()
        fixed = json.loads((recipe.NATIVE_ASSETS / 'flash_fixed_provenance.json').read_text())
        for mode in ('turbo', 'base'):
            artifact = fixed['modes'][mode]['artifact']
            self.assertEqual(recipe.check(recipe.NATIVE_ASSETS / artifact['name'],
                                           artifact['bytes'], artifact['sha256']),
                             {'bytes': artifact['bytes'], 'sha256': artifact['sha256']})
        self.assertEqual(json.loads((recipe.ASSETS / 'flash_fixed_provenance.json').read_text())['source_commit'],
                         pins['releasePins']['flash']['promptRevision'])
        for name, source_name in recipe.FLASH_NOTICE_FILES.items():
            pin = pins['payloadPins'][name]
            self.assertEqual(recipe.check(recipe.ASSETS / source_name,
                                           pin['bytes'], pin['sha256']), pin)
        notice = (recipe.ASSETS / 'NOTICE-FLASHVSR.txt').read_text(encoding='utf-8')
        self.assertRegex(notice, r'bulk\s+checkpoint payload')
        self.assertIn('learned-derived artifacts', notice)

    def test_pack_provenance_carries_license_and_fixed_notice_pin(self):
        pins = recipe.node_pins()
        with tempfile.TemporaryDirectory(prefix='flash-pack-provenance-') as directory:
            path = Path(directory) / 'flash-provenance.json'
            recipe.write_provenance(path, pins, recipe.load_catalog(), [])
            value = json.loads(path.read_text(encoding='utf-8'))
        flash = value['flash']
        self.assertEqual(flash['licenseSpdx'], 'Apache-2.0')
        self.assertEqual(flash['licenseSha256'], pins['releasePins']['flash']['licenseSha256'])
        self.assertEqual(flash['fixedProvenanceFile'], 'NOTICE-FLASHVSR-PROVENANCE.json')
        self.assertEqual(flash['fixedProvenanceSha256'], pins['releasePins']['flash']['fixedProvenanceSha256'])

    def test_flash_notices_materialize_under_pack_license_root(self):
        with tempfile.TemporaryDirectory(prefix='flash-pack-notices-') as directory:
            recipe.materialize_flash_notices(Path(directory), recipe.node_pins())
            for name in recipe.FLASH_NOTICE_FILES:
                self.assertTrue((Path(directory) / 'licenses' / name).is_file())

    def test_safe_rejects_archive_traversal(self):
        for name in ('', '/', '../x', 'a/../x', './x', 'a\\b'):
            self.assertFalse(recipe.safe(name), name)
        for name in ('rife.xml', 'flash/a.bin', 'sources.json'):
            self.assertTrue(recipe.safe(name), name)

    def test_target_rejects_symlink_output(self):
        with tempfile.TemporaryDirectory(prefix='flash-pack-target-') as directory:
            root = Path(directory)
            parent = root / 'dist'
            parent.mkdir()
            elsewhere = root / 'elsewhere'
            elsewhere.mkdir()
            link = parent / 'link'
            link.symlink_to(elsewhere, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'outside|symlink'):
                recipe.target(link, parent, True)

    def test_inventory_matches_js_and_typescript(self):
        expression = (
            "import {flashStructuralFiles,flashComplementFiles,runtimeLibraryNames} "
            "from './scripts/ai-pack-pins.mjs'; "
            "console.log(JSON.stringify({flashStructuralFiles,flashComplementFiles,"
            "runtime:runtimeLibraryNames}))"
        )
        raw = subprocess.check_output(
            ['node', '--input-type=module', '-e', expression],
            cwd=recipe.ROOT, text=True)
        js = json.loads(raw)
        self.assertEqual(recipe.FLASH_STRUCTURAL, js['flashStructuralFiles'])
        self.assertEqual(recipe.FLASH_COMPLEMENTS, js['flashComplementFiles'])
        self.assertEqual(len(js['runtime']), len(set(js['runtime'])))

        # The native pack can be built without the editor integration. Check
        # its consumer's inventory too when that source is present.
        consumer = recipe.ROOT / 'src/main/ai-pack.ts'
        if consumer.is_file():
            block = consumer.read_text(encoding='utf-8').split(
                'const fixedStructuralNames = [', 1)[1].split(
                ']\n\nexport function flashPreparedFileNames', 1)[0]
            self.assertEqual(recipe.FLASH_STRUCTURAL, re.findall(r"'([^']+)'", block))

    def test_deterministic_archive_order_and_timestamp(self):
        with tempfile.TemporaryDirectory(prefix='flash-pack-zip-') as directory:
            root = Path(directory)
            source = root / 'pack'
            (source / 'zdir').mkdir(parents=True)
            (source / 'zdir' / 'b.bin').write_bytes(b'b')
            (source / 'a.txt').write_bytes(b'a')
            archive_a = root / 'a.zip'
            archive_b = root / 'b.zip'
            command = ['node', str(recipe.ROOT / 'scripts/build-ai-pack-assemble.mjs'),
                       '--test-deterministic-archive', str(source), str(archive_a)]
            subprocess.run(command, cwd=recipe.ROOT, check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            (source / 'a.txt').touch()
            subprocess.run(command[:-1] + [str(archive_b)], cwd=recipe.ROOT,
                           check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           text=True)
            self.assertEqual(archive_a.read_bytes(), archive_b.read_bytes())
            with zipfile.ZipFile(archive_a) as archive:
                self.assertEqual(archive.namelist(),
                                 ['ai-pack/a.txt', 'ai-pack/zdir/b.bin'])
                self.assertTrue(all(info.date_time == (1980, 1, 1, 0, 0, 0)
                                    for info in archive.infolist()))

    def test_publish_backup_and_rollback(self):
        with tempfile.TemporaryDirectory(prefix='flash-pack-publish-') as directory:
            root = Path(directory)
            (root / 'dist').mkdir()
            (root / 'release').mkdir()
            old_root = recipe.ROOT
            recipe.ROOT = root
            try:
                destination = root / 'dist' / 'ai-pack'
                destination.mkdir()
                (destination / 'old.txt').write_text('old', encoding='utf-8')
                staged = root / 'dist' / 'staged'
                staged.mkdir()
                (staged / 'new.txt').write_text('new', encoding='utf-8')
                backup = recipe.publish(staged, destination, True)
                self.assertIsNotNone(backup)
                self.assertEqual((destination / 'new.txt').read_text(), 'new')
                self.assertEqual((Path(backup) / 'old.txt').read_text(), 'old')

                with self.assertRaises(FileNotFoundError):
                    recipe.publish(root / 'dist' / 'does-not-exist', destination, True)
                self.assertEqual((destination / 'new.txt').read_text(), 'new')
            finally:
                recipe.ROOT = old_root


if __name__ == '__main__':
    unittest.main()
