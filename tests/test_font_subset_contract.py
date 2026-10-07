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
                first_style = soup.select_one('link[rel~="stylesheet"]')
                self.assertLess(source.index("HUIWEN_FONT_PRELOAD:start"), source.index('rel="stylesheet"'))
                core_path = ROOT / preloads[0]["href"].lstrip("/")
                self.assertTrue(core_path.is_file())
                self.assertIn(f'font-family:"Huiwen Sans TC {slug} Core"', css)
                self.assertIn(f'font-family:"{family}"', css)
                self.assertIsNotNone(soup.select_one("script[data-huiwen-font-upgrade]"))
                self.assertIn("document.fonts.load", source)
                self.assertIn("data-huiwen-font-full", css)

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

    def test_homepage_places_award_then_headquarters_then_local_story(self):
        soup = BeautifulSoup((ROOT / "index.html").read_text(encoding="utf-8"), "html.parser")
        main = soup.find("main")
        sections = {
            section.get("id"): index
            for index, section in enumerate(main.find_all("section", recursive=False))
        }
        self.assertLess(sections["news"], sections["opening"])
        self.assertLess(sections["opening"], sections["projects"])
        self.assertIn("獲選", soup.select_one("#news").get_text(" ", strip=True))
        self.assertIn("總部成立", soup.select_one("#opening").get_text(" ", strip=True))
        self.assertIn("一件地方事", soup.select_one("#projects").get_text(" ", strip=True))


if __name__ == "__main__":
    unittest.main()
