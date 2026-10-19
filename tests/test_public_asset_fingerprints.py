"""Public CSS/JS fingerprints belong to the derived artifact and keep aliases intact."""
import hashlib
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import public_asset_fingerprints as fingerprints


class PublicAssetFingerprintTests(unittest.TestCase):
    def write_fixture(self, source: Path, destination: Path, *, changed_theme=False, changed_script=False):
        contents = {
            'styles.css': b'@import "theme.css?v=old#palette"; @import url("theme.css?v=url#scope"); body{background:url("/assets/banner.webp")}',
            'theme.css': (b'body{color:#123}' if not changed_theme else b'body{color:#456}'),
            'site.js': b"import './theme.js?version=old#module'; const child=new URL('./theme.js?v=old&mode=light#panel',document.currentScript.src);",
            'theme.js': (b'window.fixtureTheme = false;' if changed_script
                         else b'window.fixtureTheme = true;'),
        }
        for root in (source, destination):
            for relative, payload in contents.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(payload)
        html = ('<!doctype html><html><head><link rel="stylesheet" '
                'href="styles.css?v=old#main"></head><body>'
                '<script src="site.js?v=old&lang=zh#entry"></script></body></html>')
        nested = ('<html><head><link rel="stylesheet" href="../styles.css?v=old">'
                  '<script src="../site.js?v=old"></script></head></html>')
        for root in (source, destination):
            (root / 'index.html').write_text(html, encoding='utf-8')
            (root / 'preview').mkdir(parents=True, exist_ok=True)
            (root / 'preview/case.html').write_text(nested, encoding='utf-8')
        return contents

    def test_hash_identity_is_stable_and_changes_with_bytes(self):
        payload = b'body{color:#123}'
        first = fingerprints.fingerprinted_path('styles.css', payload)
        self.assertEqual(first, fingerprints.fingerprinted_path('styles.css', payload))
        self.assertNotEqual(first, fingerprints.fingerprinted_path('styles.css', payload + b' '))
        self.assertRegex(first, r'^styles\.[a-f0-9]{64}\.css$')

    def test_derived_closure_rewrites_html_css_js_and_keeps_mutable_aliases(self):
        source, output = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(source))
        self.addCleanup(lambda: shutil.rmtree(output))
        original = self.write_fixture(source, output)
        allowed = {'styles.css', 'theme.css', 'site.js', 'theme.js'}
        with patch.object(fingerprints, 'public_asset_source_paths', return_value=allowed):
            result = fingerprints.derive_public_asset_fingerprints(output, source, allowed)
            self.assertEqual(result['dependencies']['styles.css'], {'theme.css'})
            self.assertEqual(result['dependencies']['site.js'], {'theme.js'})

            for relative, payload in original.items():
                self.assertEqual((output / relative).read_bytes(), payload,
                                 'the unfingerprinted rollback alias must remain byte-identical')
            style_path = result['paths']['styles.css']
            theme_style_path = result['paths']['theme.css']
            script_path = result['paths']['site.js']
            theme_script_path = result['paths']['theme.js']
            self.assertIn(f'@import "{Path(theme_style_path).name}#palette"',
                          (output / style_path).read_text())
            self.assertIn(f'url("{Path(theme_style_path).name}#scope")',
                          (output / style_path).read_text())
            self.assertIn("new URL('./" + Path(theme_script_path).name +
                          "?mode=light#panel'", (output / script_path).read_text())
            self.assertIn("import './" + Path(theme_script_path).name +
                          "?version=old#module'", (output / script_path).read_text())
            index = (output / 'index.html').read_text()
            self.assertIn(f'href="{Path(style_path).name}#main"', index)
            self.assertIn(f'src="{Path(script_path).name}?lang=zh#entry"', index)
            nested = (output / 'preview/case.html').read_text()
            self.assertIn(f'href="../{Path(style_path).name}"', nested)
            self.assertIn(f'src="../{Path(script_path).name}"', nested)

            files = {}
            for path in output.rglob('*'):
                if path.is_file():
                    relative = path.relative_to(output).as_posix()
                    files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
            records = fingerprints.validate_public_asset_fingerprints(
                output, {'files': files}, require_complete=True,
            )
            self.assertEqual({path for path, _ in records}, set(result['paths'].values()))

        source2, output2 = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(source2))
        self.addCleanup(lambda: shutil.rmtree(output2))
        self.write_fixture(source2, output2, changed_theme=True)
        with patch.object(fingerprints, 'public_asset_source_paths', return_value=allowed):
            changed = fingerprints.derive_public_asset_fingerprints(output2, source2, allowed)
        self.assertNotEqual(result['paths']['theme.css'], changed['paths']['theme.css'])
        self.assertNotEqual(result['paths']['styles.css'], changed['paths']['styles.css'])
        self.assertEqual(result['paths']['site.js'], changed['paths']['site.js'])

        source3, output3 = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(source3))
        self.addCleanup(lambda: shutil.rmtree(output3))
        self.write_fixture(source3, output3, changed_script=True)
        with patch.object(fingerprints, 'public_asset_source_paths', return_value=allowed):
            changed_script = fingerprints.derive_public_asset_fingerprints(output3, source3, allowed)
        self.assertNotEqual(result['paths']['theme.js'], changed_script['paths']['theme.js'])
        self.assertNotEqual(result['paths']['site.js'], changed_script['paths']['site.js'])

    def test_current_runtime_asset_references_are_closed_by_specific_rules(self):
        allowed = fingerprints.public_asset_source_paths()
        expected = {
            'site.js': {'digital.css', 'digital.js'},
            'small-q.js': {'small-q.css'},
            'map.js': {'assets/vendor/leaflet.css', 'assets/vendor/leaflet.js'},
            'assets/vendor/leaflet.js': {'assets/vendor/leaflet.css'},
        }
        for owner, dependencies in expected.items():
            with self.subTest(owner=owner):
                self.assertEqual(
                    fingerprints._local_dependencies(owner, (ROOT / owner).read_bytes(), allowed),
                    dependencies,
                )
        mapping = {
            path: fingerprints.fingerprinted_path(path, (ROOT / path).read_bytes())
            for paths in expected.values() for path in paths
        }
        site = fingerprints._rewrite_js('site.js', (ROOT / 'site.js').read_text(), mapping, allowed)
        self.assertIn(Path(mapping['digital.js']).name, site)
        self.assertIn(Path(mapping['digital.css']).name, site)
        self.assertNotIn('digital.js?v=${DIGITAL_SCRIPT_VERSION}', site)
        self.assertNotIn('digital.css?v=${DIGITAL_STYLE_VERSION}', site)
        small_q = fingerprints._rewrite_js('small-q.js', (ROOT / 'small-q.js').read_text(), mapping, allowed)
        self.assertIn(Path(mapping['small-q.css']).name, small_q)
        map_script = fingerprints._rewrite_js('map.js', (ROOT / 'map.js').read_text(), mapping, allowed)
        self.assertIn(Path(mapping['assets/vendor/leaflet.css']).name, map_script)
        self.assertIn(Path(mapping['assets/vendor/leaflet.js']).name, map_script)
        leaflet = fingerprints._rewrite_js(
            'assets/vendor/leaflet.js', (ROOT / 'assets/vendor/leaflet.js').read_text(), mapping, allowed,
        )
        self.assertEqual(leaflet.count(Path(mapping['assets/vendor/leaflet.css']).name), 2)

    def test_cycle_and_unowned_private_dependency_fail_closed(self):
        allowed = {'a.css', 'b.css'}
        for contents, expected in [
            ({'a.css': b'@import "b.css";', 'b.css': b'@import "a.css";'},
             'dependency cycle'),
            ({'a.css': b'@import "draft.css";', 'b.css': b'body{}'}, 'Unowned local CSS/JS reference'),
        ]:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as source_dir, \
                    tempfile.TemporaryDirectory() as output_dir:
                source, output = Path(source_dir), Path(output_dir)
                for relative, payload in contents.items():
                    for root in (source, output):
                        (root / relative).write_bytes(payload)
                with patch.object(fingerprints, 'public_asset_source_paths', return_value=allowed):
                    with self.assertRaisesRegex(ValueError, expected):
                        fingerprints.derive_public_asset_fingerprints(output, source, allowed)

    def test_unknown_hashed_private_css_path_is_not_granted_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = b'private draft css'
            digest = hashlib.sha256(payload).hexdigest()
            path = root / f'drafts/private.{digest}.css'
            path.parent.mkdir()
            path.write_bytes(payload)
            with patch.object(fingerprints, 'public_asset_source_paths', return_value={'styles.css'}):
                with self.assertRaisesRegex(ValueError, 'Unowned public CSS/JS artifact path'):
                    fingerprints.validate_public_asset_fingerprints(
                        root, {'files': {path.relative_to(root).as_posix(): digest}},
                    )
                with self.assertRaisesRegex(ValueError, 'complete exact allowlist'):
                    fingerprints.validate_public_asset_fingerprints(
                        root, {'files': {}}, require_complete=True,
                    )


if __name__ == '__main__':
    unittest.main()
