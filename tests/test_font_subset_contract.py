"""Generated Source Han subsets keep real font coverage and predictable loading."""
from pathlib import Path
import re
import sys
import unittest

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_font_subsets as fonts


class FontSubsetContractTests(unittest.TestCase):
    def test_required_cjk_glyphs_have_a_source_font(self):
        _, codepoints = fonts.collect_corpus(ROOT)
        tc_cmap = fonts.cmap(ROOT / fonts.TC_SOURCE.relative_to(ROOT))
        jp_cmap = fonts.cmap(ROOT / fonts.JP_SOURCE.relative_to(ROOT))
        fallback = fonts.validate_corpus(codepoints, tc_cmap, jp_cmap)
        self.assertTrue(fallback)
        self.assertTrue(all(codepoint in jp_cmap for codepoint in fallback))

        css = (ROOT / "styles.css").read_text(encoding="utf-8")
        match = re.search(
            r'@font-face\{font-family:"Huiwen Sans JP Support";src:url\("([^"]+)"\)',
            css,
        )
        self.assertIsNotNone(match)
        fallback_path = ROOT / match.group(1).lstrip("/")
        self.assertTrue(fallback_path.is_file())
        self.assertTrue(set(fallback).issubset(fonts.cmap(fallback_path)))
        support_face = re.search(
            r'@font-face\{font-family:"Huiwen Sans JP Support"[^}]*unicode-range:([^}]+)',
            css,
        )
        self.assertIsNotNone(support_face)
        declared = {
            int(value.removeprefix("U+"), 16)
            for value in support_face.group(1).split(",")
        }
        self.assertEqual(declared, set(fallback))

    def test_route_font_is_preloaded_before_stylesheets_and_upgrades_after_interaction(self):
        css = (ROOT / "styles.css").read_text(encoding="utf-8")
        for route, (slug, _) in fonts.ROUTES.items():
            with self.subTest(route=route):
                source = (ROOT / route).read_text(encoding="utf-8")
                soup = BeautifulSoup(source, "html.parser")
                html = soup.html
                self.assertEqual(html.get("data-huiwen-font-page"), slug)
                family = html.get("data-huiwen-font-full-family")
                self.assertEqual(family, f"Huiwen Sans TC {slug} Full")
                preloads = soup.select('link[rel~="preload"][as="font"]')
                self.assertEqual(len(preloads), 1)
                self.assertLess(source.index("HUIWEN_FONT_PRELOAD:start"), source.index('rel="stylesheet"'))
                core_path = ROOT / preloads[0]["href"].lstrip("/")
                self.assertTrue(core_path.is_file())
                self.assertIn(f'font-family:"Huiwen Sans TC {slug} Core"', css)
                self.assertIn(f'font-family:"{family}"', css)
                core_face = re.search(
                    rf'@font-face\{{font-family:"Huiwen Sans TC {re.escape(slug)} Core";'
                    rf'[^}}]*font-display:([^;}}]+)',
                    css,
                )
                full_face = re.search(
                    rf'@font-face\{{font-family:"Huiwen Sans TC {re.escape(slug)} Full";'
                    rf'[^}}]*font-display:([^;}}]+)',
                    css,
                )
                self.assertIsNotNone(core_face)
                self.assertEqual(core_face.group(1), "swap")
                self.assertIsNotNone(full_face)
                self.assertEqual(full_face.group(1), "optional")
                full_stack = (
                    f':root[data-huiwen-font-page="{slug}"][data-huiwen-font-full="1"]'
                    f'{{--huiwen-font-family:"Huiwen Sans TC {slug} Core",'
                    f'"Huiwen Sans TC {slug} Full","Huiwen Sans JP Support",sans-serif}}'
                )
                self.assertIn(full_stack, css)
                self.assertIsNotNone(soup.select_one("script[data-huiwen-font-upgrade]"))
                self.assertIn("document.fonts.load", source)
                self.assertIn("data-huiwen-font-full", css)

    def test_full_faces_cover_route_specific_cjk_glyph_deltas(self):
        css = (ROOT / "styles.css").read_text(encoding="utf-8")
        tc_codepoints = set(fonts.cmap(ROOT / fonts.TC_SOURCE.relative_to(ROOT)))
        tc_cjk = {codepoint for codepoint in tc_codepoints if fonts.is_cjk(codepoint)}
        for route, (slug, selectors) in fonts.ROUTES.items():
            with self.subTest(route=route):
                core_text = fonts.page_text(ROOT, route, selectors)
                full_text = fonts.page_text(ROOT, route)
                core_expected = {ord(char) for char in core_text}.intersection(tc_cjk)
                full_delta_expected = (
                    {ord(char) for char in full_text}
                    - {ord(char) for char in core_text}
                ).intersection(tc_cjk)
                paths = {}
                for face in ("Core", "Full"):
                    match = re.search(
                        rf'@font-face\{{font-family:"Huiwen Sans TC {re.escape(slug)} {face}";'
                        rf'src:url\("([^"]+)"\)',
                        css,
                    )
                    self.assertIsNotNone(match)
                    paths[face] = ROOT / match.group(1).lstrip("/")
                    self.assertTrue(paths[face].is_file())
                core_actual = {codepoint for codepoint in fonts.cmap(paths["Core"]) if fonts.is_cjk(codepoint)}
                full_actual = {codepoint for codepoint in fonts.cmap(paths["Full"]) if fonts.is_cjk(codepoint)}
                self.assertEqual(core_actual, core_expected)
                self.assertEqual(full_actual, full_delta_expected)

    def test_dynamic_search_and_map_surfaces_use_the_full_site_face(self):
        css = (ROOT / "styles.css").read_text(encoding="utf-8")
        for selector in (
            ".global-search-dialog",
            ".map-insight-panel",
            ".map-popup",
            ".map-popup-case",
            ".leaflet-popup-content",
        ):
            self.assertIn(selector, css)
        self.assertIn("font-family:var(--huiwen-global-font-family)", css)
        self.assertIn(
            'url("/assets/fonts/huiwen-site-sans/huiwen-site-sans-tc-20261007.woff2")',
            css,
        )
        global_face = css.split('font-family:"Huiwen Sans TC";', 1)[1].split('}', 1)[0]
        self.assertIn("font-display:swap", global_face)
        self.assertIn("Huiwen Sans JP Support", css)

    def test_homepage_headquarters_title_is_covered_by_the_preloaded_core_face(self):
        soup = BeautifulSoup((ROOT / "index.html").read_text(encoding="utf-8"), "html.parser")
        heading = soup.select_one("#opening-title").get_text(" ", strip=True)
        core_text = fonts.page_text(ROOT, "index.html", fonts.ROUTES["index.html"][1])
        tc_cmap = fonts.cmap(ROOT / fonts.TC_SOURCE.relative_to(ROOT))
        expected = {ord(char) for char in heading if ord(char) in tc_cmap}
        present = {ord(char) for char in core_text}
        self.assertTrue(expected.issubset(present), "homepage event title must not switch from system fallback after interaction")

    def test_homepage_places_award_then_headquarters_then_local_story(self):
        soup = BeautifulSoup((ROOT / "index.html").read_text(encoding="utf-8"), "html.parser")
        recent = soup.select_one("#recent .home-recent-list")
        self.assertEqual(
            [row.get("data-home-recent-item") for row in recent.find_all("li", recursive=False)],
            ["award", "headquarters", "local"],
        )
        self.assertIn("獲選", recent.select_one("[data-home-recent-item='award']").get_text(" ", strip=True))
        self.assertIn("總部成立", soup.select_one("#opening").get_text(" ", strip=True))
        self.assertEqual(recent.select_one("[data-home-local-record]")["data-home-local-record"], "wende-school-center")
        self.assertIn("閱讀這件地方事", recent.get_text(" ", strip=True))


if __name__ == "__main__":
    unittest.main()
