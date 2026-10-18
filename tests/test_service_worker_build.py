"""Artifact-derived Service Worker build, parity, and template contract tests."""
import hashlib
import inspect
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import build_cloudflare_public
import build_artifact_page_fonts
import build_public
import page_font_contract
import service_worker_artifact as worker
import verify_production as live
from unittest.mock import patch


def cache_name(source: bytes) -> str:
    match = re.search(rb"const CACHE='([^']+)';", source)
    if not match:
        raise AssertionError('generated worker is missing CACHE')
    return match.group(1).decode()


def shell_urls(source: bytes) -> list[str]:
    match = re.search(rb'const SHELL=(\[[^;]*\]);', source)
    if not match:
        raise AssertionError('generated worker is missing SHELL')
    return json.loads(match.group(1))


def required_shell_urls(source: bytes) -> list[str]:
    match = re.search(rb'const REQUIRED_SHELL=(\[[^;]*\]);', source)
    if not match:
        raise AssertionError('generated worker is missing REQUIRED_SHELL')
    return json.loads(match.group(1))


class _CompiledIndexResources(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stylesheet = None
        self.core_font = None

    def handle_starttag(self, tag: str, attrs):
        if tag != 'link':
            return
        values = dict(attrs)
        href = values.get('href')
        if not href:
            return
        rel = set((values.get('rel') or '').lower().split())
        parsed = urlsplit(href)
        if 'stylesheet' in rel and Path(parsed.path).name == 'styles.css':
            self.stylesheet = href
        if ('preload' in rel and values.get('as', '').lower() == 'font'
                and values.get('type', '').lower() == 'font/woff2'
                and Path(parsed.path).name.startswith('huiwen-index-core-')
                and parsed.path.endswith('.woff2')):
            self.core_font = href


def compiled_index_shell_resources(index_path: Path) -> tuple[str, str]:
    parser = _CompiledIndexResources()
    parser.feed(index_path.read_text(encoding='utf-8'))
    if not parser.stylesheet:
        raise AssertionError('compiled index is missing its exact styles.css link')
    if not parser.core_font:
        raise AssertionError('compiled index is missing its generated core font preload')
    return parser.stylesheet, parser.core_font


def shell_url_for_index_reference(raw: str) -> str:
    parsed = urlsplit(raw)
    path = '.' + parsed.path if parsed.path.startswith('/') else './' + parsed.path
    return path + (('?' + parsed.query) if parsed.query else '')


class ServiceWorkerArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='.c11-sw-test-', dir=ROOT)
        cls.root = Path(cls.temporary.name)
        cls.source_worker = (ROOT / 'sw.js').read_bytes()
        artifact_override = os.environ.get('HUIWEN_SW_TEST_ARTIFACT')
        cls.first = Path(artifact_override).resolve() if artifact_override else cls.root / 'first'
        cls.second = cls.root / 'second'
        revision = 'a' * 40
        cls.build_order = []
        if not artifact_override:
            build_fonts = build_artifact_page_fonts.build
            validate_contract = page_font_contract.validate_artifact_contract
            render_worker = worker.render_service_worker

            def observed_build_fonts(*args, **kwargs):
                cls.build_order.append('font-producer')
                return build_fonts(*args, **kwargs)

            def observed_validate_contract(artifact_root, source_root=ROOT):
                temporary_publication = json.loads((Path(artifact_root) / 'publication-manifest.json').read_text())
                assert 'page-font-manifest.json' in temporary_publication['files']
                assert 'sw.js' not in temporary_publication['files']
                cls.build_order.append('font-contract')
                return validate_contract(artifact_root, source_root)

            def observed_render_worker(artifact_root, template, font_contract):
                assert font_contract['routes'].get('offline.html')
                temporary_publication = json.loads((Path(artifact_root) / 'publication-manifest.json').read_text())
                assert 'sw.js' not in temporary_publication['files']
                cls.build_order.append('service-worker')
                return render_worker(artifact_root, template, font_contract)

            with patch.object(build_artifact_page_fonts, 'build', side_effect=observed_build_fonts), \
                    patch.object(page_font_contract, 'validate_artifact_contract', side_effect=observed_validate_contract), \
                    patch.object(worker, 'render_service_worker', side_effect=observed_render_worker), \
                    patch.object(build_cloudflare_public, 'validate_artifact_contract',
                                 side_effect=AssertionError('Cloudflare wrapper must reuse the source-derived contract')):
                build_cloudflare_public.build(ROOT, cls.first, source_commit=revision)
        page_font_manifest = json.loads((cls.first / 'page-font-manifest.json').read_text())
        cls.font_contract = {
            'routes': page_font_manifest['routes'],
            'fonts': page_font_manifest['fonts'],
        }

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def copy_artifact(self, name: str) -> Path:
        destination = self.root / name
        shutil.copytree(self.first, destination)
        return destination

    def test_real_public_build_and_worker_regeneration_are_deterministic(self):
        first_worker = (self.first / 'sw.js').read_bytes()
        second_worker = worker.render_service_worker(self.first, self.source_worker, self.font_contract)
        first_manifest = (self.first / 'publication-manifest.json').read_bytes()
        manifest = json.loads(first_manifest)

        self.assertEqual(first_worker, second_worker)
        if self.build_order:
            self.assertEqual(self.build_order, ['font-producer', 'font-contract', 'service-worker'])
        self.assertEqual(manifest['files']['sw.js'], hashlib.sha256(first_worker).hexdigest())
        self.assertNotIn('publication-manifest.json', manifest['files'])
        self.assertNotIn('deployment.json', manifest['files'])
        self.assertNotIn('_headers', manifest['files'])
        self.assertNotIn('_redirects', manifest['files'])
        self.assertTrue(cache_name(first_worker).startswith('huiwen-digital-v16-'))
        self.assertNotEqual(first_worker, self.source_worker)
        self.assertNotIn(b'{{CACHE_POLICY}}', self.source_worker)
        self.assertEqual(self.source_worker.count(worker.POLICY_START_MARKER.encode()), 1)
        self.assertEqual(self.source_worker.count(worker.POLICY_END_MARKER.encode()), 1)
        self.assertIn(worker._cache_policy_source(self.source_worker), first_worker)
        self.assertEqual((ROOT / 'sw.js').read_bytes(), self.source_worker)

    def test_shell_keeps_exact_homepage_queries_and_excludes_private_or_external_urls(self):
        destination = self.copy_artifact('shell-fixture')
        index = (destination / 'index.html').read_text(encoding='utf-8')
        stylesheet_href, core_font_href = compiled_index_shell_resources(self.first / 'index.html')
        expected_stylesheet = shell_url_for_index_reference(stylesheet_href)
        expected_core_font = shell_url_for_index_reference(core_font_href)
        injected = '''
<link rel="stylesheet" href="/styles.css?release=next">
<link rel="stylesheet" href="https://cdn.example.invalid/private.css">
<link rel="stylesheet" href="/admin/private.css">
<link rel="stylesheet" href="/api/private.css">
<link rel="stylesheet" href="/drafts/preview.css">
        <link rel="stylesheet" href="/styles.css?cmsEdit=1">
        <script src="/data/achievements.json"></script>
        <script src="/cms-page-editor.deadbeef.js"></script>
        <link rel="manifest" href="/cms-editor-manifests/draft.json">
        '''
        (destination / 'index.html').write_text(index.replace('</head>', injected + '</head>'), encoding='utf-8')
        offline = (destination / 'offline.html').read_text(encoding='utf-8')
        offline_refs = '''
<link rel="stylesheet" href="/offline-extra.css?version=exact">
<script src="/offline-extra.js?version=exact"></script>
<link rel="stylesheet" href="https://cdn.example.invalid/offline.css">
<link rel="stylesheet" href="/api/private.css">
<link rel="stylesheet" href="/cms/private.css">
<link rel="stylesheet" href="/runtime/private.css">
<link rel="stylesheet" href="/offline-extra.css?private=1">
<link rel="stylesheet" href="/offline-extra.css?session=fixture">
'''
        (destination / 'offline-extra.css').write_text('body{}', encoding='utf-8')
        (destination / 'offline-extra.js').write_text('void 0;', encoding='utf-8')
        (destination / 'offline.html').write_text(offline.replace('</head>', offline_refs + '</head>'), encoding='utf-8')
        generated = worker.render_service_worker(destination, self.source_worker, self.font_contract)
        urls = shell_urls(generated)
        required = required_shell_urls(generated)
        offline_row = self.font_contract['routes']['offline.html']
        expected_offline_fonts = ['./' + path for path in offline_row['preloads']]

        self.assertIn(expected_stylesheet, urls)
        self.assertIn('./styles.css?release=next', urls)
        self.assertIn('./manifest.webmanifest?v=20260912-1', urls)
        self.assertIn(expected_core_font, urls)
        self.assertIn('./offline-extra.css?version=exact', urls)
        self.assertIn('./offline-extra.js?version=exact', urls)
        self.assertIn('./offline.html', urls)  # Required separately before skipWaiting.
        self.assertEqual([url for url in urls if url in expected_offline_fonts], expected_offline_fonts)
        self.assertEqual(required, expected_offline_fonts)
        self.assertFalse(any('cdn.example.invalid' in url or '/admin/' in url or '/api/' in url
                             or '/drafts/' in url or '/cms-' in url or '/cms/' in url or '/runtime/' in url
                             or 'cmsEdit=' in url or 'private=1' in url or 'session=fixture' in url
                             or '.json' in url for url in urls))
        self.assertEqual(sum('/assets/fonts/' in url for url in urls), 3)
        self.assertFalse(any(path.endswith('Full') or '783820' in path for path in urls))

    def test_cache_changes_with_public_bytes_and_worker_logic_but_not_derived_outputs(self):
        base = worker.render_service_worker(self.first, self.source_worker, self.font_contract)
        base_cache = cache_name(base)
        _, core_font_href = compiled_index_shell_resources(self.first / 'index.html')
        core_font_path = urlsplit(core_font_href).path.lstrip('/')

        for name, path in (
            ('css', 'styles.css'),
            ('home-font', core_font_path),
            ('shell-js', 'small-q.js'),
            ('public-page', 'about.html'),
        ):
            with self.subTest(name=name):
                destination = self.copy_artifact('changed-' + name)
                target = destination / path
                target.write_bytes(target.read_bytes() + b'\n/* c11 fixture */\n')
                changed = worker.render_service_worker(destination, self.source_worker, self.font_contract)
                self.assertNotEqual(cache_name(changed), base_cache)

        changed_logic = self.source_worker.replace(b"Origin unavailable", b"Origin unavailable fixture")
        self.assertNotEqual(cache_name(worker.render_service_worker(self.first, changed_logic, self.font_contract)), base_cache)
        changed_policy = self.source_worker.replace(
            b"segment.startsWith('cms-')",
            b"segment.startsWith('cms-') || segment === 'fixture-private'",
        )
        self.assertNotEqual(cache_name(worker.render_service_worker(self.first, changed_policy, self.font_contract)), base_cache)
        with patch.object(worker, '_shell_plan', return_value=(
                shell_urls(base) + ['./manifest.webmanifest?fixture=changed-shell-plan'],
                required_shell_urls(base))):
            changed_plan = worker.render_service_worker(self.first, self.source_worker, self.font_contract)
        self.assertNotEqual(cache_name(changed_plan), base_cache,
                            'derived SHELL and required-font plan must contribute to cache identity')

        manual_defaults = re.sub(rb"(?m)^const CACHE=.*$", b"const CACHE='manual-stale-cache';", self.source_worker)
        manual_defaults = re.sub(rb"(?m)^const SHELL=.*$", b"const SHELL=['./manual-stale.js'];", manual_defaults)
        self.assertEqual(worker.render_service_worker(self.first, manual_defaults, self.font_contract), base)

        destination = self.copy_artifact('excluded-derived-files')
        (destination / 'sw.js').write_bytes(b'tampered old derived worker')
        (destination / 'publication-manifest.json').write_bytes(b'changed publication receipt')
        (destination / '_headers').write_bytes(b'changed downstream headers')
        (destination / '_redirects').write_bytes(b'changed downstream redirects')
        (destination / 'deployment.json').write_bytes(b'changed downstream deployment receipt')
        self.assertEqual(worker.render_service_worker(destination, self.source_worker, self.font_contract), base)

        # The generated worker is excluded from its own material, so regeneration is stable.
        (destination / 'sw.js').write_bytes(base)
        self.assertEqual(worker.render_service_worker(destination, self.source_worker, self.font_contract), base)

    def test_offline_is_required_and_verifier_uses_exact_derived_worker_bytes(self):
        destination = self.copy_artifact('missing-offline')
        (destination / 'offline.html').unlink()
        with self.assertRaisesRegex(ValueError, 'Required offline document'):
            worker.render_service_worker(destination, self.source_worker, self.font_contract)

        wrong_offline = self.source_worker.replace(b"const OFFLINE='./offline.html';",
                                                   b"const OFFLINE='./missing.html';")
        with self.assertRaisesRegex(ValueError, 'required offline declaration'):
            worker.render_service_worker(self.first, wrong_offline, self.font_contract)

        def use_verified_artifact(_root, destination):
            destination = Path(destination)
            destination.mkdir()
            shutil.copyfile(self.first / 'sw.js', destination / 'sw.js')

        with patch.object(build_public, 'build', side_effect=use_verified_artifact):
            expected = live.canonical_bytes('sw.js')
        self.assertEqual(expected, (self.first / 'sw.js').read_bytes())
        changed = expected + b' '
        self.assertFalse(live.source_parity('sw.js', expected, changed))
        self.assertNotEqual(live.source_sha256('sw.js', expected), live.source_sha256('sw.js', changed))
        self.assertTrue(live.source_parity('sw.js', expected, expected))

    def test_source_orders_producer_temp_manifest_validator_worker_final_manifest(self):
        source = inspect.getsource(build_public.build)
        positions = [
            source.index('artifact_page_fonts = build_artifact_page_fonts(root, staging, paths)'),
            source.index("write_publication_manifest(staging, len(records), exclude={'sw.js'})"),
            source.index('font_contract = validate_artifact_contract(staging, root)'),
            source.index('render_service_worker(staging,'),
            source.index('final_publication = write_publication_manifest(staging, len(records))'),
        ]
        self.assertEqual(positions, sorted(positions))

    def test_offline_route_pair_is_exact_and_required(self):
        destination = self.copy_artifact('offline-pair-fixture')
        offline_row = self.font_contract['routes']['offline.html']
        common, delta = offline_row['preloads']
        (destination / common).unlink()
        with self.assertRaisesRegex(ValueError, 'Validated page-font asset is missing or unsafe'):
            worker.render_service_worker(destination, self.source_worker, self.font_contract)

        missing_route = {'routes': dict(self.font_contract['routes']), 'fonts': self.font_contract['fonts']}
        missing_route['routes'].pop('offline.html')
        with self.assertRaisesRegex(ValueError, 'Validated page-font route is missing: offline.html'):
            worker.render_service_worker(self.first, self.source_worker, missing_route)

        wrong_pair = {'routes': dict(self.font_contract['routes']), 'fonts': self.font_contract['fonts']}
        wrong_pair['routes']['offline.html'] = {**offline_row, 'preloads': [common, common]}
        with self.assertRaisesRegex(ValueError, 'Validated page-font preload pair is invalid: offline.html'):
            worker.render_service_worker(self.first, self.source_worker, wrong_pair)

    def test_index_keeps_exact_legacy_guard_and_can_switch_to_validated_schema_two_row(self):
        destination = self.copy_artifact('index-schema-two-fixture')
        index_path = destination / 'index.html'
        index_html = index_path.read_text(encoding='utf-8')
        legacy_core = re.compile(r'<link\b(?=[^>]*huiwen-index-core-[0-9a-f]{12}\.woff2)[^>]*>', re.I)
        without_legacy_core, removed = legacy_core.subn('', index_html)
        self.assertEqual(removed, 1)
        index_path.write_text(without_legacy_core, encoding='utf-8')

        with self.assertRaisesRegex(ValueError, 'Public index is missing its generated core font preload'):
            worker.render_service_worker(destination, self.source_worker, self.font_contract)

        future_contract = {
            'routes': {**self.font_contract['routes'],
                       'index.html': self.font_contract['routes']['offline.html']},
            'fonts': self.font_contract['fonts'],
        }
        generated = worker.render_service_worker(destination, self.source_worker, future_contract)
        urls = shell_urls(generated)
        for path in future_contract['routes']['index.html']['preloads']:
            self.assertIn('./' + path, urls)

    def test_node_vm_keeps_install_gate_cleanup_raw_source_exclusion_and_query_matching(self):
        for worker_path in (ROOT / 'sw.js', self.first / 'sw.js'):
            with self.subTest(worker=worker_path):
                result = subprocess.run(
                    ['node', str(ROOT / 'tests/donation/service-worker-vm.mjs'), str(worker_path)],
                    cwd=ROOT, text=True, capture_output=True, check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('Service Worker VM checks passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
