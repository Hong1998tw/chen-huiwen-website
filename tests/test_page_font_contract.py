"""Pure page-font contract tests; artifact QA lives in page_font_artifact_integration.py."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_artifact_page_fonts as producer
import build_public
import page_font_contract as contract
import service_worker_artifact as service_worker
import verify_production
from verify_cloudflare_assets import verify_private_paths


class PageFontContractUnitTests(unittest.TestCase):
    def _write_minimal_font_binding(self, root):
        files = {}
        font_rows = {}
        for role, directory, payload in (
            ('common', producer.CORE_DIR, b'offline-common-font-fixture'),
            ('delta', producer.DELTA_DIR, b'offline-delta-font-fixture'),
        ):
            digest = hashlib.sha256(payload).hexdigest()
            path = f'{directory}/{digest}.woff2'
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            files[path] = digest
            font_rows[path] = {
                'sha256': digest,
                'bytes': len(payload),
                'codepoints': [0x4E00],
                'glyphsetSha256': producer.glyphset_sha256([0x4E00]),
            }
        manifest = {'schemaVersion': producer.MANIFEST_SCHEMA, 'fonts': font_rows}
        manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
        (root / contract.FONT_MANIFEST).write_bytes(manifest_bytes)
        files[contract.FONT_MANIFEST] = hashlib.sha256(manifest_bytes).hexdigest()
        publication = {'version': 1, 'files': files}
        return publication, manifest, manifest_bytes, font_rows

    def test_ordinary_paths_and_legacy_font_assets_are_not_page_font_assets(self):
        for path in (
            "achievement-alpha.html",
            "page-font-manifest.json",
            "assets/fonts/huiwen-site-sans/generated/huiwen-index-core-ead400a26308.woff2",
            "assets/fonts/huiwen-site-sans/page-core/1234.woff2",
        ):
            with self.subTest(path=path):
                self.assertFalse(contract.is_page_font_path(path))
        self.assertTrue(contract.is_page_font_path(
            "assets/fonts/huiwen-site-sans/page-core/" + "a" * 64 + ".woff2",
        ))

    def test_production_cache_key_accepts_binary_font_bytes(self):
        payload = b"\x00\xffWOFF2 binary fixture"
        expected = hashlib.sha256(payload).hexdigest()[:16] + "-run-7"
        self.assertEqual(verify_production.verification_cache_key(payload, "run", 7), expected)

    def test_unpublished_non_achievement_source_route_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="page-font-source-state-") as name:
            source = Path(name)
            data = source / "data"
            data.mkdir()
            (data / "page-content.json").write_text(json.dumps({
                "pages": {"service.html": {"status": "unpublished"}},
            }), encoding="utf-8")
            (data / "achievements-public.json").write_text("[]", encoding="utf-8")
            inactive, _public_ids = producer._inactive_and_public_ids(source)

        self.assertEqual(inactive, {"service.html"})
        with self.assertRaisesRegex(ValueError, "FONT_MANIFEST_ROUTE_NOT_PUBLIC: service.html"):
            producer.validate_route_source_status(["service.html"], [], inactive)

    def test_source_status_closes_all_nine_preexisting_font_routes(self):
        expected_legacy_routes = {
            "about.html", "achievements.html", "election.html", "explore.html", "index.html",
            "news-20260915-special-education-nurse.html", "news.html", "political-donation.html",
            "vision.html",
        }
        candidates, skipped, _excluded = producer.public_html_route_inventory(
            ROOT, ROOT, build_public.public_paths(ROOT),
        )
        inactive, _public_ids = producer._inactive_and_public_ids(ROOT)
        self.assertEqual(set(skipped), expected_legacy_routes)
        self.assertFalse((set(candidates) | set(skipped)).intersection(inactive))
        producer.validate_route_source_status(candidates, skipped, inactive)
        with self.assertRaisesRegex(ValueError, "FONT_MANIFEST_ROUTE_NOT_PUBLIC"):
            producer.validate_route_source_status([], skipped, {next(iter(skipped))})
        with self.assertRaisesRegex(ValueError, "FONT_MANIFEST_ROUTE_NOT_PUBLIC: offline.html"):
            producer.validate_route_source_status(["offline.html"], [], {"offline.html"})

    def test_offline_font_publication_rejects_missing_wrong_hash_tamper_and_namespace_sidecar(self):
        with tempfile.TemporaryDirectory(prefix='offline-font-binding-') as name:
            root = Path(name)
            publication, manifest, manifest_bytes, font_rows = self._write_minimal_font_binding(root)
            contract.validate_publication_binding(root, publication, manifest, manifest_bytes)

            common = next(path for path in font_rows if path.startswith(producer.CORE_DIR + '/'))
            wrong_hash_publication = json.loads(json.dumps(publication))
            wrong_hash_publication['files'][common] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'PAGE_FONT_ASSET_NOT_BOUND_TO_PUBLICATION'):
                contract.validate_publication_binding(root, wrong_hash_publication, manifest, manifest_bytes)

            (root / common).write_bytes(b'tampered offline common bytes')
            with self.assertRaisesRegex(ValueError, 'PAGE_FONT_ASSET_PUBLICATION_BYTES_MISMATCH'):
                contract.validate_publication_binding(root, publication, manifest, manifest_bytes)

            (root / common).write_bytes(b'offline-common-font-fixture')
            (root / common).parent.joinpath('unlisted-sidecar.woff2').write_bytes(b'unlisted')
            with self.assertRaisesRegex(ValueError, 'PAGE_FONT_NAMESPACE_CLOSURE_INVALID'):
                contract.validate_publication_binding(root, publication, manifest, manifest_bytes)

            (root / common).parent.joinpath('unlisted-sidecar.woff2').unlink()
            (root / common).unlink()
            with self.assertRaisesRegex(ValueError, 'PAGE_FONT_ASSET_PUBLICATION_BYTES_MISMATCH'):
                contract.validate_publication_binding(root, publication, manifest, manifest_bytes)

    def test_safe_shell_resolver_maps_root_relative_urls_inside_the_artifact(self):
        with tempfile.TemporaryDirectory(prefix='public-shell-reference-') as name:
            root = Path(name)
            target = root / 'assets' / 'favicon.svg'
            target.parent.mkdir()
            target.write_text('<svg/>', encoding='utf-8')
            self.assertEqual(
                service_worker._safe_artifact_file('/assets/favicon.svg', root, 'HTML shell reference'),
                target,
            )

    def test_local_http_private_path_guard_rejects_public_exposure(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/scripts/build_all.py":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"private build script")
                else:
                    self.send_response(404)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            failures = verify_private_paths(f"http://127.0.0.1:{server.server_port}")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.assertTrue(any(
            "scripts/build_all.py: non-public path returned HTTP 200" in item for item in failures
        ))


if __name__ == "__main__":
    unittest.main()
