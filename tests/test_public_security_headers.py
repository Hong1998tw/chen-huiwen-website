"""The public artifact ships a minimal, reviewed set of security headers and nothing more.

Tests build the real Cloudflare artifact and evaluate its `_headers` file the way
Cloudflare Static Assets does (every matching rule applies; repeated names combine).
"""
import hashlib
from http.client import HTTPMessage
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_cloudflare_public as cloudflare
import build_artifact_page_fonts as producer
import public_asset_fingerprints
import verify_security_headers as verifier
from public_artifact_fixture import prepare_cloudflare_test_artifact

FEATURES_DENIED = {'camera', 'microphone', 'geolocation', 'payment'}
FEATURE_API = re.compile(r'geolocation|getUserMedia|mediaDevices|PaymentRequest', re.I)


def parse_headers(text):
    """Return [(path_pattern, [(name, value), ...]), ...] from a `_headers` file."""
    rules = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if line[0] not in ' \t':
            rules.append((line.strip(), []))
        else:
            name, _, value = line.strip().partition(':')
            rules[-1][1].append((name.strip(), value.strip()))
    return rules


def response_headers(rules, path):
    """Headers Cloudflare would attach to `path`; duplicate names are comma-joined."""
    merged = {}
    for pattern, headers in rules:
        if re.fullmatch(re.escape(pattern).replace(r'\*', '.*'), path):
            for name, value in headers:
                key = name.lower()
                merged[key] = f'{merged[key]}, {value}' if key in merged else value
    return merged


def http_message(headers):
    """Build a real HTTPMessage so tests can retain duplicate field lines."""
    message = HTTPMessage()
    for name, value in headers.items():
        message.add_header(name, value)
    return message


class SecurityHeaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.site = prepare_cloudflare_test_artifact(ROOT, cls.temp.name, cloudflare, producer)
        cls.text = (cls.site / '_headers').read_text()
        cls.rules = parse_headers(cls.text)
        cls.publication = json.loads((cls.site / 'publication-manifest.json').read_text())
        files = ['/' + p.relative_to(cls.site).as_posix()
                 for p in cls.site.rglob('*') if p.is_file()]
        aliases = [line.split()[0] for line in (cls.site / '_redirects').read_text().splitlines()]
        cls.paths = sorted(set(files + aliases + ['/missing-page-for-404.html']))

    @classmethod
    def tearDownClass(cls):
        if cls.temp:
            cls.temp.cleanup()

    def test_catch_all_rule_matches_every_delivery_path(self):
        expected = {name.lower(): value for name, value in cloudflare.SECURITY_HEADERS}
        self.assertGreater(len(self.paths), 300)
        for required in ['/', '/index.html', '/mktexp26/', '/renwu-anju-social-housing/',
                         '/site.js', '/styles.css', '/data/search-index.json',
                         '/sw.js', '/manifest.webmanifest', '/publication-manifest.json',
                         '/missing-page-for-404.html']:
            self.assertIn(required, self.paths)
        for path in self.paths:
            headers = response_headers(self.rules, path)
            for name, value in expected.items():
                self.assertEqual(headers.get(name), value, f'{path}: {name}')

    def test_receipt_stays_no_store_and_only_hash_assets_get_immutable_cache_control(self):
        immutable = {'/' + path for path, _ in cloudflare.immutable_asset_records(self.site, self.publication)}
        namespaces = cloudflare.page_font_namespace_records(self.site, self.publication)
        immutable.update('/' + path for group in namespaces.values() for path, _ in group)
        for path in self.paths:
            cache = response_headers(self.rules, path).get('cache-control')
            expected = ('no-store' if path == '/deployment.json' else
                        'public, max-age=0, must-revalidate' if path == '/page-font-manifest.json' else
                        cloudflare.IMMUTABLE_CACHE_CONTROL if path in immutable else None)
            self.assertEqual(cache, expected, path)

    def test_immutable_rules_are_exact_and_merge_without_cache_conflicts(self):
        exact = {'/' + path for path, _ in cloudflare.immutable_asset_records(self.site, self.publication)}
        prefixes = {'/' + prefix + '/*' for prefix in cloudflare.page_font_namespace_records(self.site, self.publication)}
        actual = {pattern for pattern, headers in self.rules
                  if any(name.lower() == 'cache-control' and value == cloudflare.IMMUTABLE_CACHE_CONTROL
                         for name, value in headers)}
        self.assertTrue(exact)
        self.assertEqual(actual, exact | prefixes)
        self.assertEqual(prefixes, {
            '/assets/fonts/huiwen-site-sans/page-core/*',
            '/assets/fonts/huiwen-site-sans/page-delta/*',
        })
        for pattern in prefixes:
            sibling = pattern[:-2] + '-sidecar/font.woff2'
            self.assertFalse(re.fullmatch(re.escape(pattern).replace(r'\*', '.*'), sibling), sibling)
        for path in self.paths:
            values = [value for pattern, headers in self.rules
                      if re.fullmatch(re.escape(pattern).replace(r'\*', '.*'), path)
                      for name, value in headers if name.lower() == 'cache-control']
            if path == '/deployment.json':
                self.assertEqual(values, ['no-store'], path)
            elif path == '/page-font-manifest.json':
                self.assertEqual(values, ['public, max-age=0, must-revalidate'], path)
            elif path in exact or any(path.startswith(prefix[:-1]) for prefix in prefixes):
                self.assertEqual(values, [cloudflare.IMMUTABLE_CACHE_CONTROL], path)
            else:
                self.assertEqual(values, [], path)

    def test_header_file_fits_cloudflare_limits(self):
        self.assertLessEqual(len(self.rules), 100)
        self.assertTrue(all(len(line) <= 2000 for line in self.text.splitlines()))
        self.assertTrue(self.text.endswith('\n'))

    def test_cms_runtime_and_page_manifest_references_survive_artifact_rewrite(self):
        runtimes = sorted(self.site.glob('cms-page-editor.*.js'))
        self.assertEqual(len(runtimes), 1)
        runtime = runtimes[0]
        digest = hashlib.sha256(runtime.read_bytes()).hexdigest()
        self.assertEqual(runtime.name, f'cms-page-editor.{digest[:12]}.js')
        page = (self.site / 'achievements.html').read_text()
        loader = re.search(r'data-cms-editor-src="(/cms-page-editor\.[a-f0-9]{12}\.js)"', page)
        manifest = re.search(r'data-cms-manifest="(/cms-editor-manifests/achievements\.html\.[a-f0-9]{12}\.json)"', page)
        self.assertIsNotNone(loader)
        self.assertIsNotNone(manifest)
        self.assertEqual(loader.group(1), '/' + runtime.name)
        self.assertTrue((self.site / loader.group(1).lstrip('/')).is_file())
        self.assertTrue((self.site / manifest.group(1).lstrip('/')).is_file())

    def test_unhashed_and_unknown_paths_do_not_receive_immutable_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = ('assets/fonts/huiwen-site-sans/generated/unhashed.woff2',
                     '0', 'unknown/other-font.woff2')
            files = {}
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                payload = ('fixture:' + name).encode()
                path.write_bytes(payload)
                files[name] = hashlib.sha256(payload).hexdigest()
            nested = 'assets/fonts/huiwen-site-sans/generated/unknown/nested-font'
            payload = b'nested unknown font bytes'
            digest = hashlib.sha256(payload).hexdigest()
            nested_path = root / f'{nested}-{digest[:12]}.woff2'
            nested_path.parent.mkdir(parents=True, exist_ok=True)
            nested_path.write_bytes(payload)
            files[nested_path.relative_to(root).as_posix()] = digest
            publication = {'files': files}
            self.assertEqual(cloudflare.immutable_asset_records(root, publication), [])
            with self.assertRaisesRegex(ValueError, 'publication path is unsafe'):
                cloudflare.immutable_asset_records(root, {'files': {0: '0' * 64}})
            with self.assertRaisesRegex(ValueError, 'PAGE_FONT_MANIFEST_MISSING_OR_UNSAFE'):
                cloudflare.render_headers(root, publication)

            private = root / 'drafts' / ('private.' + 'a' * 64 + '.css')
            private.parent.mkdir()
            private.write_bytes(b'private draft CSS')
            private_hash = hashlib.sha256(private.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, 'Unowned public CSS/JS artifact path'):
                cloudflare.immutable_asset_records(root, {
                    'files': {private.relative_to(root).as_posix(): private_hash},
                })

    def test_wrong_filename_hash_and_tampered_bytes_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relative = 'assets/fonts/huiwen-site-sans/generated/font-' + 'f' * 12 + '.woff2'
            path = root / relative
            path.parent.mkdir(parents=True)
            payload = b'original font bytes'
            path.write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            wrong_prefix = 'f' * 12 if not digest.startswith('f' * 12) else 'e' * 12
            relative = 'assets/fonts/huiwen-site-sans/generated/font-' + wrong_prefix + '.woff2'
            path = root / relative
            path.write_bytes(payload)
            with self.assertRaisesRegex(ValueError, 'Filename hash'):
                cloudflare.immutable_asset_records(root, {'files': {relative: digest}})

            relative = 'assets/fonts/huiwen-site-sans/generated/font-' + digest[:12] + '.woff2'
            path = root / relative
            path.write_bytes(payload)
            publication = {'files': {relative: digest}}
            path.write_bytes(b'tampered bytes')
            with self.assertRaisesRegex(ValueError, 'Manifest SHA-256'):
                cloudflare.immutable_asset_records(root, publication)

    def test_header_policy_is_stable_and_hash_filename_rotation(self):
        self.assertEqual(cloudflare.render_headers(self.site, self.publication).encode(),
                         (self.site / '_headers').read_bytes())
        assets = cloudflare.immutable_asset_records(self.site, self.publication)
        relative, _ = assets[0]
        original = (self.site / relative).read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            tampered = Path(directory) / 'tampered'
            shutil.copytree(self.site, tampered)
            (tampered / relative).write_bytes(original + b'tampered')
            with self.assertRaisesRegex(ValueError, 'differs from bytes'):
                cloudflare.render_headers(tampered, self.publication)

        changed = original + b'changed bytes'
        digest = hashlib.sha256(changed).hexdigest()
        full_hash = re.search(r'\.[a-f0-9]{64}(\.(?:css|js))$', relative)
        if full_hash:
            new_relative = relative[:full_hash.start()] + '.' + digest + full_hash.group(1)
        else:
            new_relative = re.sub(r'[a-f0-9]{12}(\.woff2|\.js)$', digest[:12] + r'\1', relative)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rotated_files = {}
            for asset_path, asset_hash in self.publication['files'].items():
                if (asset_path == relative or asset_path == 'sw.js'
                        or Path(asset_path).suffix.lower() not in {'.css', '.js'}):
                    continue
                source = self.site / asset_path
                target = root / asset_path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                rotated_files[asset_path] = asset_hash
            path = root / new_relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(changed)
            rotated_files[new_relative] = digest
            rotated_records = cloudflare.immutable_asset_records(root, {'files': rotated_files})
            self.assertIn((new_relative, digest), rotated_records)

        immutable_paths = {'/' + path for path, _ in assets}
        self.assertNotIn('/site.js', immutable_paths)
        self.assertNotIn('/styles.css', immutable_paths)
        for alias in public_asset_fingerprints.public_asset_source_paths():
            self.assertNotIn('/' + alias, immutable_paths, alias)
        fingerprinted_code = {
            path for path in immutable_paths
            if path.endswith(('.css', '.js')) and re.search(r'\.[a-f0-9]{64}\.(?:css|js)$', path)
        }
        self.assertGreaterEqual(len(fingerprinted_code), 2)
        self.assertTrue(all(path.count('*') == 0 for path in fingerprinted_code))

    def test_too_many_immutable_paths_fail_instead_of_using_a_wildcard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {}
            for index in range(99):
                payload = f'font fixture {index}'.encode()
                digest = hashlib.sha256(payload).hexdigest()
                relative = f'assets/fonts/huiwen-site-sans/generated/font-{digest[:12]}.woff2'
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(payload)
                files[relative] = digest
            with self.assertRaisesRegex(ValueError, 'maximum is 100'):
                cloudflare.render_headers(root, {'files': files})

    def test_header_set_is_exactly_the_reviewed_minimum(self):
        self.assertEqual({name for name, _ in cloudflare.SECURITY_HEADERS}, {
            'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy',
            'X-Frame-Options', 'Content-Security-Policy'})
        # A fuller policy needs its own reviewed change: COEP/CORP would break the
        # admin thumbnails and Facebook/OSM embeds; HSTS is a Cloudflare zone setting.
        text = self.text.lower()
        for deferred in ['cross-origin-embedder-policy', 'cross-origin-resource-policy',
                         'strict-transport-security']:
            self.assertNotIn(deferred, text)
        csp = dict(cloudflare.SECURITY_HEADERS)['Content-Security-Policy']
        self.assertEqual([part.split()[0] for part in csp.split(';')], ['frame-ancestors'])
        self.assertNotIn('unsafe-', csp)

    def test_permissions_policy_denies_only_unused_features(self):
        policy = dict(cloudflare.SECURITY_HEADERS)['Permissions-Policy']
        denied = {part.split('=')[0].strip() for part in policy.split(',')}
        self.assertEqual(denied, FEATURES_DENIED)
        self.assertTrue(all(part.split('=')[1].strip() == '()' for part in policy.split(',')))
        for path in sorted(self.site.rglob('*')):
            if path.suffix == '.js' and 'vendor' not in path.parts:
                self.assertIsNone(FEATURE_API.search(path.read_text(errors='ignore')), path.name)
        for page in self.site.rglob('*.html'):
            for tag in re.findall(r'<iframe\b[^>]*>', page.read_text(errors='ignore')):
                allow = re.search(r'\ballow="([^"]*)"', tag)
                delegated = {token.split()[0] for token in (allow.group(1).split(';') if allow else []) if token.strip()}
                self.assertFalse(delegated & FEATURES_DENIED, (page.name, tag))

    def test_public_pages_embed_no_first_party_page(self):
        for page in self.site.rglob('*.html'):
            for src in re.findall(r'<iframe\b[^>]*\bsrc="([^"]+)"', page.read_text(errors='ignore')):
                self.assertTrue(src.startswith('https://www.facebook.com/plugins/'), (page.name, src))

    def test_admin_preview_stays_on_the_same_origin_proxy(self):
        # frame-ancestors 'none' is only safe because the admin never frames www pages.
        app = (ROOT / 'admin/public/app.js').read_text()
        sources = re.findall(r'frame\.src\s*=\s*([^;]+);', app)
        self.assertTrue(sources)
        for source in sources:
            self.assertTrue(source.lstrip('`"\'').startswith('/api/page-preview'), source)
        page = (ROOT / 'admin/public/index.html').read_text()
        self.assertIsNone(re.search(r'<iframe\b[^>]*\bsrc=', page))


class PostDeployCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.site = prepare_cloudflare_test_artifact(ROOT, cls.temp.name, cloudflare, producer)
        cls.publication = json.loads((cls.site / 'publication-manifest.json').read_text())
        cls.immutable = {'/' + path: (cls.site / path).read_bytes()
                         for path, _ in verifier.immutable_policy_records(cls.site, cls.publication)}

    @classmethod
    def tearDownClass(cls):
        if cls.temp:
            cls.temp.cleanup()

    def fake(self, mutate=None, status=200):
        immutable = self.immutable
        def getter(url):
            path = url.split('://', 1)[1].partition('/')[2]
            path = '/' + path
            headers = {name.lower(): value for name, value in cloudflare.SECURITY_HEADERS}
            headers['cache-control'] = 'public, max-age=0, must-revalidate'
            if path == '/deployment.json':
                headers['cache-control'] = 'no-store'
            code = 404 if path == verifier.NOT_FOUND_PROBE else status
            if path in immutable:
                headers['cache-control'] = cloudflare.IMMUTABLE_CACHE_CONTROL
            body = immutable.get(path, b'')
            if mutate:
                changed = mutate(path, code, url, headers)
                if len(changed) == 4:
                    code, url, headers, body = changed
                else:
                    code, url, headers = changed
            if isinstance(headers, dict):
                headers = http_message(headers)
            return code, url, headers, body
        return getter

    def small_verified_records(self):
        exact = cloudflare.immutable_asset_records(self.site, self.publication)
        namespaces = cloudflare.page_font_namespace_records(self.site, self.publication)
        return [*exact, *namespaces[producer.CORE_DIR][0:1]]

    def verify_small(self, getter):
        records = self.small_verified_records()
        with patch.object(verifier, 'immutable_policy_records', return_value=records):
            return verifier.verify('https://example.test', getter=getter, artifact_root=self.site)

    def test_fetch_keeps_raw_duplicate_http_message_fields(self):
        url = 'https://example.test/asset.woff2'
        message = HTTPMessage()
        message.add_header('Cache-Control', 'no-store')
        message.add_header('cAcHe-CoNtRoL', cloudflare.IMMUTABLE_CACHE_CONTROL)
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.geturl.return_value = url
        response.headers = message
        response.read.return_value = b'asset'

        with patch.object(verifier, 'urlopen', return_value=response):
            fetched = verifier.fetch(url)

        self.assertEqual(fetched[2], tuple(message.raw_items()))
        self.assertEqual(
            verifier.collect_headers(fetched[2])['cache-control'],
            'no-store, ' + cloudflare.IMMUTABLE_CACHE_CONTROL,
        )

    def test_passes_when_every_path_carries_the_reviewed_headers(self):
        report = self.verify_small(self.fake())
        self.assertEqual(report['status'], 'PASS')
        self.assertEqual(len(report['results']), len(verifier.PATHS) + 1)
        self.assertEqual(report['results'][-1]['status'], 404)
        self.assertEqual(report['immutableAssets']['status'], 'PASS')
        self.assertEqual(len(report['immutableAssets']['results']),
                         len(self.small_verified_records()))

    def test_mutable_public_paths_reject_immutable_cache_control(self):
        mutable_paths = ('/', '/index.html', '/about.html', '/site.js', '/styles.css',
                         '/data/search-index.json', '/sw.js', '/manifest.webmanifest',
                         '/page-font-manifest.json', '/publication-manifest.json', '/deployment.json')

        def make_mutable_immutable(path, code, url, headers):
            if path in mutable_paths:
                headers['cache-control'] = cloudflare.IMMUTABLE_CACHE_CONTROL
            return code, url, headers

        report = self.verify_small(self.fake(make_mutable_immutable))
        self.assertEqual(report['status'], 'FAIL')
        for path in mutable_paths:
            result = next(item for item in report['results'] if item['url'].endswith(path))
            self.assertTrue(any('immutable' in failure for failure in result['failures']), path)

    def test_conflicting_duplicate_cache_control_fields_fail_for_real_http_message(self):
        immutable_path = '/' + cloudflare.immutable_asset_records(self.site, self.publication)[0][0]

        def duplicate_cache_control(path, code, url, headers):
            if path == immutable_path:
                message = http_message({name: value for name, value in headers.items()
                                        if name.lower() != 'cache-control'})
                message.add_header('Cache-Control', 'no-store')
                message.add_header('cAcHe-CoNtRoL', cloudflare.IMMUTABLE_CACHE_CONTROL)
                return code, url, message, b''
            return code, url, headers

        report = self.verify_small(self.fake(duplicate_cache_control))
        self.assertEqual(report['status'], 'FAIL')
        asset_result = next(item for item in report['immutableAssets']['results']
                            if item['url'].endswith(immutable_path))
        self.assertTrue(any('cache-control' in failure for failure in asset_result['failures']))
        self.assertEqual(
            asset_result['headers']['cache-control'],
            'no-store, ' + cloudflare.IMMUTABLE_CACHE_CONTROL,
        )

    def test_conflicting_duplicate_security_fields_fail_for_all_five_headers(self):
        def duplicate_security_headers(path, code, url, headers):
            if path == '/':
                message = http_message(headers)
                for name, _ in cloudflare.SECURITY_HEADERS:
                    message.add_header(name.swapcase(), 'conflicting-value')
                return code, url, message
            return code, url, headers

        report = self.verify_small(self.fake(duplicate_security_headers))
        self.assertEqual(report['status'], 'FAIL')
        root_result = next(item for item in report['results'] if item['url'] == 'https://example.test/')
        for name, _ in cloudflare.SECURITY_HEADERS:
            self.assertTrue(any(name.lower() in failure for failure in root_result['failures']), name)

    def test_fails_on_missing_changed_redirected_or_wrong_status(self):
        def drop_nosniff(path, code, url, headers):
            if path == '/mktexp26/':
                headers = {k: v for k, v in headers.items() if k != 'x-content-type-options'}
            return code, url, headers
        def weaken_frame(path, code, url, headers):
            return code, url, {**headers, 'x-frame-options': 'SAMEORIGIN'} if path == '/' else headers
        def redirect(path, code, url, headers):
            return code, url.replace('/about.html', '/about') if path == '/about.html' else url, headers
        def cache_receipt(path, code, url, headers):
            return code, url, {**headers, 'cache-control': 'public, max-age=60'} if path == '/deployment.json' else headers
        def not_found_as_ok(path, code, url, headers):
            return (200 if path == verifier.NOT_FOUND_PROBE else code), url, headers
        immutable_path = '/' + cloudflare.immutable_asset_records(self.site, self.publication)[0][0]
        def bad_immutable_policy(path, code, url, headers):
            if path == immutable_path:
                headers = {**headers, 'cache-control': 'public, max-age=0, must-revalidate'}
            return code, url, headers
        def bad_immutable_bytes(path, code, url, headers):
            if path == immutable_path:
                return code, url, headers, b'tampered response'
            return code, url, headers
        for mutate in (drop_nosniff, weaken_frame, redirect, cache_receipt, not_found_as_ok,
                       bad_immutable_policy, bad_immutable_bytes):
            report = self.verify_small(self.fake(mutate))
            self.assertEqual(report['status'], 'FAIL', mutate.__name__)
        report = self.verify_small(self.fake(bad_immutable_policy))
        self.assertEqual(report['immutableAssets']['status'], 'FAIL')
        report = self.verify_small(self.fake(bad_immutable_bytes))
        self.assertEqual(report['immutableAssets']['status'], 'FAIL')

    def test_network_error_is_reported_as_failure_not_crash(self):
        def broken(url):
            raise OSError('connection reset')
        report = self.verify_small(broken)
        self.assertEqual(report['status'], 'FAIL')
        self.assertIn('connection reset', report['results'][0]['failures'][0])

    def test_unknown_manifest_paths_cannot_pass_as_an_empty_immutable_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'publication-manifest.json').write_text(json.dumps({'files': {'0': '0' * 64}}))
            report = verifier.verify_immutable_assets('https://example.test', root, getter=lambda url: None)
            self.assertEqual(report['status'], 'FAIL')
            self.assertIn('PAGE_FONT_MANIFEST_MISSING_OR_UNSAFE', report['results'][0]['failures'][0])


if __name__ == '__main__':
    unittest.main()
