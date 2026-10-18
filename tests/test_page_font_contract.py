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
import verify_production
from verify_cloudflare_assets import verify_private_paths


class PageFontContractUnitTests(unittest.TestCase):
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
