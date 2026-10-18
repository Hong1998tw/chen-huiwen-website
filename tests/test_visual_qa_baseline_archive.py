import base64
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'scripts'
MODULE_PATH = ROOT / 'scripts/verify_visual_qa_baseline_archive.py'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location('visual_qa_baseline_archive', MODULE_PATH)
archive_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = archive_module
SPEC.loader.exec_module(archive_module)

PNG_1X1 = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p70AAAAASUVORK5CYII='
)


class VisualQaBaselineArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='a05-baseline-archive-')
        self.root = Path(self.temp.name)
        self.policy_path = ROOT / 'tests/donation/visual-qa-policy.json'
        policy = json.loads(self.policy_path.read_text(encoding='utf-8'))
        source_sha = 'a' * 40
        captures = []
        files = {}
        for route in policy['routes']:
            for viewport in policy['viewports']:
                capture_id = f"{route['id']}-{viewport['width']}"
                png_bytes = PNG_1X1
                png_sha = hashlib.sha256(png_bytes).hexdigest()
                metadata = {
                    'id': capture_id,
                    'checkoutSHA': source_sha,
                    'sourceSHA': source_sha,
                    'screenshotSha256': png_sha,
                    'environmentLabel': 'local-http-identity',
                    'measurementScope': 'initial-navigation-through-visible-image-decode; same-origin-resource-transfer-size; viewport-screenshot'
                }
                metadata_bytes = (json.dumps(metadata, sort_keys=True) + '\n').encode()
                captures.append({
                    'id': capture_id,
                    'screenshotPath': f'{capture_id}.png',
                    'metadataPath': f'{capture_id}.json',
                    'screenshotSha256': png_sha,
                    'metadataSha256': hashlib.sha256(metadata_bytes).hexdigest(),
                    'checkoutSHA': source_sha,
                    'sourceSHA': source_sha,
                    'environmentLabel': metadata['environmentLabel'],
                    'measurementScope': metadata['measurementScope']
                })
                files[f'{capture_id}.png'] = png_bytes
                files[f'{capture_id}.json'] = metadata_bytes
        manifest = {
            'schemaVersion': 2,
            'status': 'APPROVED',
            'sourceSHA': source_sha,
            'checkoutSHA': source_sha,
            'approval': {'reviewedBy': 'independent-reviewer', 'reviewedAt': '2026-10-18T00:00:00+08:00', 'note': 'reviewed'},
            'comparisonPolicy': {'pixelThreshold': 0.1, 'maxDiffRatio': 0.005},
            'exceptions': [],
            'captures': captures
        }
        manifest_bytes = (json.dumps(manifest, sort_keys=True) + '\n').encode()
        files['manifest.json'] = manifest_bytes
        files['manifest.sha256'] = f"{hashlib.sha256(manifest_bytes).hexdigest()}  manifest.json\n".encode()
        self.files = files

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, name, files=None):
        path = self.root / name
        with ZipFile(path, 'w', ZIP_DEFLATED) as output:
            for filename, payload in (files or self.files).items():
                output.writestr(filename, payload)
        return path

    def verify(self, archive_path, output_name='unpacked', **kwargs):
        return archive_module.verify_and_extract(
            archive_path,
            self.root / output_name,
            policy_path=self.policy_path,
            **kwargs
        )

    def test_exact_approved_30_png_and_metadata_archive_extracts(self):
        archive = self.archive('approved.zip')
        result = self.verify(archive)
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertEqual((result['captureCount'], result['pngCount'], result['metadataCount']), (30, 30, 30))
        self.assertEqual(len(list((self.root / 'unpacked').iterdir())), 62)

    def test_cli_parses_and_verifies_archive_on_supported_python(self):
        archive = self.archive('cli-approved.zip')
        output = self.root / 'cli-unpacked'
        result = subprocess.run(
            [sys.executable, str(MODULE_PATH), str(archive), str(output), '--policy', str(self.policy_path)],
            cwd=ROOT, capture_output=True, text=True,
            env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=60
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt['status'], 'VERIFIED')
        self.assertEqual((receipt['captureCount'], receipt['pngCount'], receipt['metadataCount']), (30, 30, 30))
        self.assertEqual(len(list(output.iterdir())), 62)

    def test_import_does_not_write_files(self):
        with tempfile.TemporaryDirectory(prefix='a05-archive-import-') as temp:
            scripts = Path(temp) / 'scripts'
            scripts.mkdir()
            module_path = scripts / MODULE_PATH.name
            shutil.copy2(MODULE_PATH, module_path)
            shutil.copy2(SCRIPTS / 'python_guard.py', scripts / 'python_guard.py')
            before = sorted(
                (('dir', path.relative_to(temp).as_posix()) if path.is_dir()
                 else ('file', path.relative_to(temp).as_posix(), path.read_bytes()))
                for path in Path(temp).rglob('*')
            )
            code = (
                'import importlib.util, sys; from pathlib import Path; '
                'module_path = Path(sys.argv[1]); sys.path.insert(0, str(module_path.parent)); '
                'spec = importlib.util.spec_from_file_location("archive_import_probe", module_path); '
                'module = importlib.util.module_from_spec(spec); sys.modules[spec.name] = module; '
                'spec.loader.exec_module(module)'
            )
            result = subprocess.run(
                [sys.executable, '-c', code, str(module_path)], cwd=temp,
                capture_output=True, text=True,
                env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=30
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '')
            after = sorted(
                (('dir', path.relative_to(temp).as_posix()) if path.is_dir()
                 else ('file', path.relative_to(temp).as_posix(), path.read_bytes()))
                for path in Path(temp).rglob('*')
            )
            self.assertEqual(after, before)

    def test_zip_path_traversal_is_rejected(self):
        files = dict(self.files)
        files['../escape.png'] = PNG_1X1
        with self.assertRaisesRegex(ValueError, 'BASELINE_ARCHIVE_PATH_INVALID'):
            self.verify(self.archive('path-traversal.zip', files))

    def test_oversized_archive_is_rejected_before_extraction(self):
        archive = self.archive('too-large.zip')
        with self.assertRaisesRegex(ValueError, 'BASELINE_ARCHIVE_SIZE_INVALID'):
            self.verify(archive, max_archive_bytes=1)
        with self.assertRaisesRegex(ValueError, 'BASELINE_ARCHIVE_EXPANSION_TOO_LARGE'):
            self.verify(archive, max_uncompressed_bytes=1)

    def test_manifest_bytes_must_match_its_sha256_sidecar(self):
        files = dict(self.files)
        files['manifest.json'] += b' '
        with self.assertRaisesRegex(ValueError, 'BASELINE_ARCHIVE_MANIFEST_HASH_MISMATCH'):
            self.verify(self.archive('manifest-tamper.zip', files))

    def test_each_png_must_match_the_manifest_hash(self):
        files = dict(self.files)
        capture_path = next(name for name in files if name.endswith('.png'))
        files[capture_path] = files[capture_path] + b'tampered'
        with self.assertRaisesRegex(ValueError, 'BASELINE_ARCHIVE_PNG_HASH_MISMATCH'):
            self.verify(self.archive('png-tamper.zip', files))

    def test_missing_capture_file_and_invalid_png_format_are_rejected(self):
        missing = dict(self.files)
        capture_path = next(name for name in missing if name.endswith('.png'))
        del missing[capture_path]
        with self.assertRaisesRegex(ValueError, 'BASELINE_ARCHIVE_ENTRY_COUNT_INVALID'):
            self.verify(self.archive('missing-capture.zip', missing))

        invalid = dict(self.files)
        invalid[capture_path] = b'not a png'
        with self.assertRaisesRegex(ValueError, 'BASELINE_ARCHIVE_PNG_INVALID'):
            self.verify(self.archive('invalid-png.zip', invalid))


if __name__ == '__main__':
    unittest.main()
