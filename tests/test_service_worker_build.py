"""Artifact-derived Service Worker build, parity, and template contract tests."""
import hashlib
import json
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
import service_worker_artifact as worker
import verify_production as live


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
        if 'stylesheet' in rel and parsed.path.endswith('/styles.css'):
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
    return '.' + parsed.path + (('?' + parsed.query) if parsed.query else '')


class ServiceWorkerArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='.c11-sw-test-', dir=ROOT)
        cls.root = Path(cls.temporary.name)
        cls.source_worker = (ROOT / 'sw.js').read_bytes()
        cls.first = cls.root / 'first'
        cls.second = cls.root / 'second'
        revision = 'a' * 40
        build_cloudflare_public.build(ROOT, cls.first, source_commit=revision)
        build_cloudflare_public.build(ROOT, cls.second, source_commit=revision)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def copy_artifact(self, name: str) -> Path:
        destination = self.root / name
        shutil.copytree(self.first, destination)
        return destination

    def test_two_real_public_builds_have_identical_worker_and_manifest(self):
        first_worker = (self.first / 'sw.js').read_bytes()
        second_worker = (self.second / 'sw.js').read_bytes()
        first_manifest = (self.first / 'publication-manifest.json').read_bytes()
        second_manifest = (self.second / 'publication-manifest.json').read_bytes()
        manifest = json.loads(first_manifest)

        self.assertEqual(first_worker, second_worker)
        self.assertEqual(first_manifest, second_manifest)
        self.assertEqual(manifest['files']['sw.js'], hashlib.sha256(first_worker).hexdigest())
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
        generated = worker.render_service_worker(destination, self.source_worker)
        urls = shell_urls(generated)

        self.assertIn(expected_stylesheet, urls)
        self.assertIn('./styles.css?release=next', urls)
        self.assertIn('./manifest.webmanifest?v=20260912-1', urls)
        self.assertIn(expected_core_font, urls)
        self.assertIn('./offline.html', urls)  # Required separately before skipWaiting.
        self.assertFalse(any('cdn.example.invalid' in url or '/admin/' in url or '/api/' in url
                             or '/drafts/' in url or '/cms-' in url or 'cmsEdit=' in url
                             or '.json' in url for url in urls))
        self.assertEqual(sum('/assets/fonts/' in url for url in urls), 1)

    def test_cache_changes_with_public_bytes_and_worker_logic_but_not_derived_outputs(self):
        base = worker.render_service_worker(self.first, self.source_worker)
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
                changed = worker.render_service_worker(destination, self.source_worker)
                self.assertNotEqual(cache_name(changed), base_cache)

        changed_logic = self.source_worker.replace(b"Origin unavailable", b"Origin unavailable fixture")
        self.assertNotEqual(cache_name(worker.render_service_worker(self.first, changed_logic)), base_cache)
        changed_policy = self.source_worker.replace(
            b"segment.startsWith('cms-')",
            b"segment.startsWith('cms-') || segment === 'fixture-private'",
        )
        self.assertNotEqual(cache_name(worker.render_service_worker(self.first, changed_policy)), base_cache)

        manual_defaults = re.sub(rb"(?m)^const CACHE=.*$", b"const CACHE='manual-stale-cache';", self.source_worker)
        manual_defaults = re.sub(rb"(?m)^const SHELL=.*$", b"const SHELL=['./manual-stale.js'];", manual_defaults)
        self.assertEqual(worker.render_service_worker(self.first, manual_defaults), base)

        destination = self.copy_artifact('excluded-derived-files')
        (destination / 'sw.js').write_bytes(b'tampered old derived worker')
        (destination / 'publication-manifest.json').write_bytes(b'changed publication receipt')
        (destination / '_headers').write_bytes(b'changed downstream headers')
        (destination / '_redirects').write_bytes(b'changed downstream redirects')
        (destination / 'deployment.json').write_bytes(b'changed downstream deployment receipt')
        self.assertEqual(worker.render_service_worker(destination, self.source_worker), base)

        # The generated worker is excluded from its own material, so regeneration is stable.
        (destination / 'sw.js').write_bytes(base)
        self.assertEqual(worker.render_service_worker(destination, self.source_worker), base)

    def test_offline_is_required_and_verifier_uses_exact_derived_worker_bytes(self):
        destination = self.copy_artifact('missing-offline')
        (destination / 'offline.html').unlink()
        with self.assertRaisesRegex(ValueError, 'Required offline document'):
            worker.render_service_worker(destination, self.source_worker)

        wrong_offline = self.source_worker.replace(b"const OFFLINE='./offline.html';",
                                                   b"const OFFLINE='./missing.html';")
        with self.assertRaisesRegex(ValueError, 'required offline declaration'):
            worker.render_service_worker(self.first, wrong_offline)

        expected = live.canonical_bytes('sw.js')
        self.assertEqual(expected, (self.first / 'sw.js').read_bytes())
        changed = expected + b' '
        self.assertFalse(live.source_parity('sw.js', expected, changed))
        self.assertNotEqual(live.source_sha256('sw.js', expected), live.source_sha256('sw.js', changed))
        self.assertTrue(live.source_parity('sw.js', expected, expected))

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
