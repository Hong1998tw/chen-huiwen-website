"""Real-artifact consumer negatives; the artifact is built once by the caller."""
from copy import deepcopy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
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

SAMPLE_ROUTES = (
    "news-20251125-school-review.html",
    "achievement-wujia-public-parking.html",
    "achievement-metro-green-line.html",
)


class PageFontArtifactContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.artifact = Path(os.environ.get("PAGE_FONT_ARTIFACT_ROOT", ROOT / "_site")).resolve()
        cls.publication, cls.publication_bytes = contract.load_publication(cls.artifact)
        cls.manifest_path = cls.artifact / contract.FONT_MANIFEST
        cls.manifest_bytes = cls.manifest_path.read_bytes()
        cls.manifest = json.loads(cls.manifest_bytes)
        cls.fonts = cls.manifest["fonts"]
        cls.routes = cls.manifest["routes"]
        contract.validate_publication_binding(cls.artifact, cls.publication, cls.manifest, cls.manifest_bytes)
        cls.binding_temp = tempfile.TemporaryDirectory(prefix="page-font-binding-")
        cls.binding_root = Path(cls.binding_temp.name)
        (cls.binding_root / contract.FONT_MANIFEST).write_bytes(cls.manifest_bytes)
        (cls.binding_root / "publication-manifest.json").write_bytes(cls.publication_bytes)
        for path in cls.fonts:
            target = cls.binding_root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            source = cls.artifact / path
            try:
                os.link(source, target)
            except OSError:
                shutil.copyfile(source, target)

    @classmethod
    def tearDownClass(cls):
        cls.binding_temp.cleanup()

    def test_manifest_and_asset_namespaces_are_publication_bound(self):
        self.assertEqual(hashlib.sha256(self.manifest_bytes).hexdigest(),
                         self.publication["files"][contract.FONT_MANIFEST])
        self.assertEqual(set(self.fonts), {
            path for path in self.publication["files"] if contract.is_page_font_path(path)
        })
        self.assertTrue(all(Path(path).name == self.fonts[path]["sha256"] + ".woff2" for path in self.fonts))

    def test_ordinary_pages_and_legacy_fonts_are_not_page_font_manifest_assets(self):
        for path in ("achievement-alpha.html", "page-font-manifest.json",
                     "assets/fonts/huiwen-site-sans/generated/huiwen-index-core-ead400a26308.woff2",
                     "assets/fonts/huiwen-site-sans/page-core/1234.woff2"):
            self.assertFalse(contract.is_page_font_path(path), path)
        self.assertTrue(contract.is_page_font_path(next(iter(self.fonts))))

    def test_three_sample_glyphsets_and_footer_text_are_in_downloadable_faces(self):
        tc_path = ROOT / producer.TC_REL
        tc_cmap, _ = producer.source_glyphs(tc_path.read_bytes())
        for route in SAMPLE_ROUTES:
            with self.subTest(route=route):
                row = self.routes[route]
                soup = producer.BeautifulSoup((self.artifact / route).read_bytes(), "html5lib")
                footer_text = soup.find("footer").get_text(" ", strip=True)
                footer_codepoints = {ord(char) for char in footer_text if producer.is_required_character(char)}
                self.assertTrue(footer_codepoints)
                self.assertTrue(footer_codepoints.issubset(set(row["codepoints"])))
                self.assertTrue(footer_codepoints.issubset(tc_cmap))
                for path in row["preloads"]:
                    payload = (self.artifact / path).read_bytes()
                    self.assertEqual(contract.sha256(payload), self.fonts[path]["sha256"])
                    contract.validate_font_bytes(path, payload, self.fonts[path])

        parking = self.routes["achievement-wujia-public-parking.html"]
        draft_char = ord("黑")
        self.assertIn(draft_char, tc_cmap)
        self.assertNotIn(draft_char, parking["codepoints"])

    def test_build_report_proves_pinned_q9_and_has_ci_cold_budget(self):
        report_path = Path(os.environ.get(
            "G02_BUILD_REPORT", ROOT / "tests/donation/results/cloudflare-assets/build.json",
        ))
        self.assertTrue(report_path.is_file(), "capture build_cloudflare_public.py JSON output")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        producer_run = report["artifactPageFonts"]
        self.assertEqual(producer_run["compiler"]["fontTools"], "4.66.1")
        self.assertEqual(producer_run["compiler"]["brotli"], "1.2.0")
        self.assertEqual(producer_run["compiler"]["quality"], 9)
        self.assertGreater(producer_run["cold"]["cacheMisses"], 0)
        self.assertEqual(producer_run["warm"]["cacheMisses"], 0)
        self.assertTrue(producer_run["warm"]["manifestIdenticalToCold"])
        self.assertEqual(producer_run["candidateRoutes"], len(self.routes))
        self.assertLess(producer_run["cold"]["wallSeconds"], 900,
                        "30-minute CI job reserves at least 15 minutes after cold build")

    def test_tampered_bytes_wrong_sha_path_and_cmap_are_rejected(self):
        path = next(iter(self.fonts))
        row = self.fonts[path]
        payload = (self.artifact / path).read_bytes()
        with self.assertRaisesRegex(ValueError, "SHA256_OR_PATH_MISMATCH"):
            contract.validate_font_bytes(path, payload + b"tamper", row)
        with self.assertRaisesRegex(ValueError, "PATH_INVALID"):
            contract.validate_font_bytes(path.replace(Path(path).name, "short-hash.woff2"), payload, row)
        wrong_size = deepcopy(row)
        wrong_size["bytes"] += 1
        with self.assertRaisesRegex(ValueError, "SIZE_MISMATCH"):
            contract.validate_font_bytes(path, payload, wrong_size)

        wrong_cmap = deepcopy(row)
        wrong_cmap["codepoints"] = row["codepoints"][1:]
        wrong_cmap["glyphsetSha256"] = producer.glyphset_sha256(wrong_cmap["codepoints"])
        with self.assertRaisesRegex(ValueError, "CMAP_MISMATCH"):
            contract.validate_font_bytes(path, payload, wrong_cmap)
        wrong_glyphset = deepcopy(row)
        wrong_glyphset["glyphsetSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "GLYPHSET_HASH_INVALID"):
            contract.validate_font_bytes(path, payload, wrong_glyphset)
        unsorted = deepcopy(row)
        unsorted["codepoints"] = list(reversed(row["codepoints"]))
        with self.assertRaisesRegex(ValueError, "GLYPHSET_HASH_INVALID"):
            contract.validate_font_bytes(path, payload, unsorted)

    def test_production_cache_key_accepts_binary_font_bytes(self):
        payload = b"\x00\xffWOFF2 binary fixture"
        expected = hashlib.sha256(payload).hexdigest()[:16] + "-run-7"
        self.assertEqual(verify_production.verification_cache_key(payload, "run", 7), expected)

    def test_manifest_publication_hash_mismatch_is_rejected(self):
        altered_manifest_bytes = self.manifest_bytes + b" "
        with self.assertRaisesRegex(ValueError, "NOT_BOUND_TO_PUBLICATION"):
            contract.validate_publication_binding(
                self.binding_root, self.publication, self.manifest, altered_manifest_bytes,
            )

        altered_publication = deepcopy(self.publication)
        path = next(iter(self.fonts))
        altered_publication["files"][path] = "0" * 64
        with self.assertRaisesRegex(ValueError, "NOT_BOUND_TO_PUBLICATION"):
            contract.validate_publication_binding(
                self.binding_root, altered_publication, self.manifest, self.manifest_bytes,
            )

    def test_unknown_namespace_sidecar_and_wrong_name_fail_closed(self):
        sidecar = self.binding_root / producer.CORE_DIR / "notes.txt"
        sidecar.write_text("unknown sidecar", encoding="utf-8")
        try:
            with self.assertRaisesRegex(ValueError, "NAMESPACE_CLOSURE_INVALID"):
                contract.page_font_namespace_records(self.binding_root, self.publication)
        finally:
            sidecar.unlink(missing_ok=True)

        unknown = self.binding_root / producer.DELTA_DIR / ("f" * 12 + ".woff2")
        unknown.write_bytes(b"not a published font")
        try:
            with self.assertRaisesRegex(ValueError, "NAMESPACE_CLOSURE_INVALID"):
                contract.page_font_namespace_records(self.binding_root, self.publication)
        finally:
            unknown.unlink(missing_ok=True)

    def test_stale_unpublished_or_missing_route_fails_closed(self):
        candidates, inactive = producer.candidate_routes(ROOT, self.artifact, build_public.public_paths(ROOT))
        _, public_ids = producer._inactive_and_public_ids(ROOT)
        stale = deepcopy(self.manifest)
        stale["routes"].pop(SAMPLE_ROUTES[0])
        with self.assertRaisesRegex(ValueError, "ROUTE_SET_INVALID"):
            producer.validate_manifest(self.artifact, stale, candidates, inactive, public_ids)

        unpublished = deepcopy(self.publication)
        unpublished["files"].pop(SAMPLE_ROUTES[0])
        with self.assertRaisesRegex(ValueError, "ROUTE_NOT_PUBLISHED"):
            contract.validate_route_publication(self.artifact, unpublished, [SAMPLE_ROUTES[0]])

    def test_route_style_and_preload_regression_is_rejected(self):
        route = SAMPLE_ROUTES[0]
        payload = (self.artifact / route).read_bytes()
        contract.validate_route_html(route, payload, self.routes[route])
        soup = producer.BeautifulSoup(payload, "html5lib")
        soup.find("link", attrs={producer.PRELOAD_MARKER: "delta"}).decompose()
        with self.assertRaisesRegex(ValueError, "PRELOAD_CLOSURE_INVALID"):
            contract.validate_route_html(route, soup.encode("utf-8"), self.routes[route])


class PrivatePathHttpTests(unittest.TestCase):
    def test_local_http_server_exposing_private_path_is_rejected(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/scripts/build_all.py":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"private build script")
                else:
                    self.send_response(404)
                    self.end_headers()

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
        self.assertTrue(any("scripts/build_all.py: non-public path returned HTTP 200" in item for item in failures))


if __name__ == "__main__":
    unittest.main()
