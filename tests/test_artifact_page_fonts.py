"""Artifact-only q9 WOFF2 producer contracts; no browser is launched."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_artifact_page_fonts as fonts


SAMPLE_ROUTES = (
    "news-20251125-school-review.html",
    "achievement-wujia-public-parking.html",
    "achievement-metro-green-line.html",
)


def q11_reference(source_bytes, codepoints):
    """Use fontTools' unmodified default save path as the table-shape oracle."""
    from fontTools import subset
    from fontTools.ttLib import TTFont

    font = TTFont(BytesIO(source_bytes), recalcBBoxes=False, recalcTimestamp=False)
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.retain_gids = False
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=list(codepoints))
    created, modified = font["head"].created, font["head"].modified
    subsetter.subset(font)
    requested = set(codepoints)
    for cmap_table in font["cmap"].tables:
        if cmap_table.isUnicode():
            cmap_table.cmap = {
                cp: name for cp, name in cmap_table.cmap.items()
                if cp in requested
            }
    fonts.rename_font_family(font, fonts.WHOLE_PAGE_FAMILY, fonts.WHOLE_PAGE_UNIQUE_ID)
    font["head"].created, font["head"].modified = created, modified
    font.recalcTimestamp = False
    font.flavor = "woff2"
    output = BytesIO()
    font.save(output)
    font.close()
    return output.getvalue()


def copy_public_font_inputs(source_root: Path, artifact_root: Path) -> None:
    for relative in (fonts.TC_REL, fonts.LICENSE_REL, "styles.css"):
        source = source_root / relative
        target = artifact_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    css = (source_root / "styles.css").read_text(encoding="utf-8")
    faces = re.findall(
        r"@font-face\s*\{[^}]*font-family\s*:\s*[\"']Huiwen Sans JP Support[\"'][^}]*\}",
        css,
        re.I,
    )
    match = re.search(r"src\s*:\s*url\(\s*([\"']?)([^\"')]+)\1\s*\)", faces[0], re.I)
    jp_path = fonts._safe_artifact_path(source_root, match.group(2))
    target = artifact_root / jp_path.relative_to(source_root)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(jp_path, target)


def fixture_html(extra: str) -> bytes:
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>測試頁</title>'
        '<link rel="stylesheet" href="/styles.css"></head><body><main>'
        '<p>陳慧文公共資訊</p><div hidden>隱藏甲</div>'
        '<details><summary>詳情甲</summary><p>展開公</p></details>'
        '<img src="/fixture.png" alt="圖片丁">'
        '<button aria-label="按鈕共">送出</button>'
        '<form><input value="表單己" placeholder="提示庚" aria-description="說明辛"></form>'
        f'<p>{extra}</p><script>草稿秘密字</script></main></body></html>'
    ).encode("utf-8")


class Q9FontProducerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fonts.verify_environment()
        cls.source_bytes = (ROOT / fonts.TC_REL).read_bytes()
        cls.tc_cmap, cls.source_axes = fonts.source_glyphs(cls.source_bytes)
        cls.jp_allowed, cls.jp_cmap = fonts.parse_jp_face(ROOT, (ROOT / "styles.css").read_text(encoding="utf-8"))

    def test_three_real_woff2_samples_keep_tables_cmap_axis_and_repeat_bytes(self):
        for route in SAMPLE_ROUTES:
            with self.subTest(route=route):
                spec = fonts.extract_page_spec(
                    ROOT, route, self.tc_cmap, self.jp_allowed, self.jp_cmap,
                )
                first, _ = fonts.ProcessFontCompiler().compile(
                    self.source_bytes, spec["codepoints"],
                    fonts.WHOLE_PAGE_FAMILY, fonts.WHOLE_PAGE_UNIQUE_ID,
                )
                repeated, _ = fonts.ProcessFontCompiler().compile(
                    self.source_bytes, spec["codepoints"],
                    fonts.WHOLE_PAGE_FAMILY, fonts.WHOLE_PAGE_UNIQUE_ID,
                )
                reference = q11_reference(self.source_bytes, spec["codepoints"])
                info = fonts.font_info(first, include_tables=True)
                reference_info = fonts.font_info(reference, include_tables=True)
                self.assertEqual(first[:4], b"wOF2")
                self.assertEqual(first, repeated)
                self.assertEqual(info["codepoints"], list(spec["codepoints"]))
                self.assertEqual(info["wght"], self.source_axes)
                self.assertEqual(len(info["tables"]), 21)
                self.assertEqual(info["tables"], reference_info["tables"])

    def test_process_cache_key_and_fake_payload_fail_closed(self):
        cache = fonts.ProcessFontCompiler()
        codepoints = tuple(sorted(ord(char) for char in "陳慧文"))
        with tempfile.TemporaryDirectory() as directory:
            root_a = Path(directory) / "a"
            root_b = Path(directory) / "b"
            root_a.mkdir()
            root_b.mkdir()
            source_a = root_a / "source.woff2"
            source_b = root_b / "source.woff2"
            source_a.write_bytes(self.source_bytes)
            source_b.write_bytes(self.source_bytes)
            first, event_a = cache.compile(source_a.read_bytes(), codepoints, fonts.WHOLE_PAGE_FAMILY, fonts.WHOLE_PAGE_UNIQUE_ID)
            warm, event_b = cache.compile(source_b.read_bytes(), codepoints, fonts.WHOLE_PAGE_FAMILY, fonts.WHOLE_PAGE_UNIQUE_ID)
            self.assertFalse(event_a["cacheHit"])
            self.assertTrue(event_b["cacheHit"])
            self.assertEqual(first, warm)
        cache.compile(self.source_bytes, tuple(sorted((*codepoints, ord("甲")))), fonts.WHOLE_PAGE_FAMILY, fonts.WHOLE_PAGE_UNIQUE_ID)
        self.assertEqual(cache.misses, 2)
        changed_options = {**fonts.OPTIONS, "drop_tables": ["DSIG"]}
        cache.compile(self.source_bytes, codepoints, fonts.WHOLE_PAGE_FAMILY, fonts.WHOLE_PAGE_UNIQUE_ID, changed_options)
        cache.compile(self.source_bytes, codepoints, "Huiwen Sans TC Other Family", "Huiwen Sans TC Other Family; 1", fonts.OPTIONS)
        self.assertEqual(cache.misses, 4)
        with self.assertRaises(fonts.TTLibError):
            cache.compile(self.source_bytes + b"\x00", codepoints, fonts.WHOLE_PAGE_FAMILY, fonts.WHOLE_PAGE_UNIQUE_ID)
        self.assertEqual(cache.misses, 5)
        with self.assertRaises(ValueError):
            fonts.font_info(b"wOF2not-a-font")

    def test_artifact_manifest_closure_and_two_roots_are_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            source_root = parent / "source"
            source_root.mkdir()
            (source_root / "data").mkdir()
            (source_root / "data/page-content.json").write_text('{"pages":{}}', encoding="utf-8")
            (source_root / "data/achievements-public.json").write_text(
                json.dumps([{"id": "alpha"}, {"id": "beta"}]), encoding="utf-8",
            )
            for relative in (fonts.TC_REL, fonts.LICENSE_REL, "styles.css"):
                target = source_root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, target)
            css = (ROOT / "styles.css").read_text(encoding="utf-8")
            jp_faces = re.findall(
                r"@font-face\s*\{[^}]*font-family\s*:\s*[\"']Huiwen Sans JP Support[\"'][^}]*\}",
                css,
                re.I,
            )
            jp_match = re.search(r"src\s*:\s*url\(\s*([\"']?)([^\"')]+)\1\s*\)", jp_faces[0], re.I)
            jp_source = fonts._safe_artifact_path(ROOT, jp_match.group(2))
            jp_relative = jp_source.relative_to(ROOT).as_posix()
            for relative in (fonts.TC_REL, fonts.LICENSE_REL, "styles.css", jp_relative):
                target = source_root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    shutil.copyfile(ROOT / relative, target)

            routes = ["achievement-alpha.html", "achievement-beta.html"]
            skipped_route = "news-20260915-special-education-nurse.html"
            paths = routes + [skipped_route, "styles.css", fonts.TC_REL, fonts.LICENSE_REL, jp_relative]
            base_pages = {
                routes[0]: fixture_html("特有江"),
                routes[1]: fixture_html("特有黑"),
            }
            compiler = fonts.ProcessFontCompiler()
            outputs = []
            for run in ("one", "two"):
                artifact = parent / run
                artifact.mkdir()
                copy_public_font_inputs(ROOT, artifact)
                for route, raw in base_pages.items():
                    (artifact / route).write_bytes(raw)
                (artifact / skipped_route).write_text(
                    '<!doctype html><html data-huiwen-font-page="news-detail"><head></head><body>既有路由</body></html>',
                    encoding="utf-8",
                )
                report = fonts.build(source_root, artifact, paths, compiler=compiler)
                manifest_bytes = (artifact / fonts.MANIFEST_NAME).read_bytes()
                outputs.append(manifest_bytes)
                manifest = json.loads(manifest_bytes)
                self.assertTrue(report["warm"]["manifestIdenticalToCold"])
                self.assertEqual(report["warm"]["cacheMisses"], 0)
                self.assertEqual(report["skippedExistingFontRoutes"], [skipped_route])
                self.assertEqual(report["manifestSha256"], sha256(manifest_bytes).hexdigest())
                self.assertEqual(set(manifest["routes"]), set(routes))
                self.assertEqual(len(manifest["routes"][routes[0]]["preloads"]), 2)
                draft_codepoint = ord("黑")
                self.assertIn(draft_codepoint, self.tc_cmap)
                self.assertNotIn(draft_codepoint, manifest["routes"][routes[0]]["codepoints"])
                soup = BeautifulSoup((artifact / routes[0]).read_bytes(), "html5lib")
                self.assertNotIn(ord("草"), manifest["routes"][routes[0]]["codepoints"])
                self.assertTrue(soup.html.get("data-huiwen-font-artifact-route"))
                route_style = soup.find("style", attrs={fonts.STYLE_MARKER: "1"})
                self.assertTrue(route_style)
                route_style_text = str(route_style.string or route_style.decode_contents())
                self.assertIn('"Huiwen Sans TC"', route_style_text)
                self.assertIn('data-huiwen-font-artifact-preview="1"', route_style_text)
                inactive, public_ids = fonts._inactive_and_public_ids(source_root)
                fonts.validate_manifest(artifact, manifest, routes, inactive, public_ids)

                bad_hash = deepcopy(manifest)
                first_font = next(iter(bad_hash["fonts"]))
                bad_hash["fonts"][first_font]["bytes"] += 1
                with self.assertRaisesRegex(ValueError, "HASH_MISMATCH"):
                    fonts.validate_manifest(artifact, bad_hash, routes, inactive, public_ids)
                bad_path = deepcopy(manifest)
                bad_path["routes"][routes[0]]["commonFont"] = "assets/fonts/huiwen-site-sans/elsewhere/" + "0" * 64 + ".woff2"
                with self.assertRaisesRegex(ValueError, "FONT_PATH_INVALID"):
                    fonts.validate_manifest(artifact, bad_path, routes, inactive, public_ids)
                bad_unpublished = deepcopy(manifest)
                bad_unpublished["routes"]["achievement-gone.html"] = deepcopy(bad_unpublished["routes"][routes[0]])
                bad_candidates = routes + ["achievement-gone.html"]
                with self.assertRaisesRegex(ValueError, "NOT_PUBLIC|NOT_PROJECTED"):
                    fonts.validate_manifest(artifact, bad_unpublished, bad_candidates, {"achievement-gone.html"}, public_ids)
            self.assertEqual(outputs[0], outputs[1])

            state = {"pages": {"achievement-gone.html": {"status": "unpublished"}}}
            (source_root / "data/page-content.json").write_text(json.dumps(state), encoding="utf-8")
            stale_paths = paths + ["achievement-gone.html"]
            (parent / "one/achievement-gone.html").write_bytes(fixture_html("不得輸出"))
            with self.assertRaisesRegex(ValueError, "UNPUBLISHED_OR_UNPROJECTED"):
                fonts.candidate_routes(source_root, parent / "one", stale_paths)
            # Once the sitemap/public path set is synchronized, the inactive route is absent.
            live_routes, _ = fonts.candidate_routes(source_root, parent / "one", paths)
            self.assertEqual(live_routes, routes)

    def test_cms_font_preview_marker_is_after_the_existing_strict_guard(self):
        source = (ROOT / "cms-page-editor.js").read_text(encoding="utf-8")
        guard = 'if (params.get("cmsEdit") !== "1" || window.parent === window) return;'
        marker = 'document.documentElement.dataset.huiwenFontArtifactPreview = "1";'
        self.assertLess(source.index(guard), source.index(marker))
        self.assertIn('event.origin !== ADMIN_ORIGIN || event.source !== window.parent', source)
        self.assertIn('window.parent.postMessage({ type: "huiwen-cms-hello"', source)


if __name__ == "__main__":
    unittest.main()
