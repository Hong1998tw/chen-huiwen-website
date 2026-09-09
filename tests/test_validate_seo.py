import json
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from shutil import copy2

from scripts.validate_seo import BASE, normalize_sitemap_target


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate_seo.py"


class SeoValidatorRegressionTests(unittest.TestCase):
    def make_site(self, temp_root: Path) -> None:
        for path in ROOT.glob("*.html"):
            copy2(path, temp_root / path.name)
        for name in ("sitemap.xml", "robots.txt"):
            copy2(ROOT / name, temp_root / name)

    def run_validator(self, temp_root: Path) -> tuple[int, dict]:
        completed = subprocess.run(
            [sys.executable, str(VALIDATOR), "--root", str(temp_root)],
            check=False,
            capture_output=True,
            text=True,
        )
        return completed.returncode, json.loads(completed.stdout)

    def test_sitemap_paths_are_checked_against_configured_base(self):
        self.assertEqual(normalize_sitemap_target(BASE), "index.html")
        self.assertEqual(
            normalize_sitemap_target(BASE + "not-a-page.html"),
            "not-a-page.html",
        )

    def test_rejects_wrong_language(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_root = Path(directory)
            self.make_site(temp_root)
            index = temp_root / "index.html"
            index.write_text(
                index.read_text(encoding="utf-8").replace(
                    '<html lang="zh-Hant-TW">', '<html lang="en">', 1
                ),
                encoding="utf-8",
            )
            code, result = self.run_validator(temp_root)
            self.assertNotEqual(code, 0)
            self.assertTrue(any("expected html lang" in error for error in result["errors"]))

    def test_rejects_duplicate_canonical_and_title_elements(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_root = Path(directory)
            self.make_site(temp_root)
            about = temp_root / "about.html"
            about_text = about.read_text(encoding="utf-8")
            root_url = BASE
            about_text = about_text.replace(
                f'href="{BASE}about.html"',
                f'href="{root_url}"',
                1,
            ).replace(
                f'content="{BASE}about.html"',
                f'content="{root_url}"',
                1,
            )
            about.write_text(about_text, encoding="utf-8")
            index = temp_root / "index.html"
            index_text = index.read_text(encoding="utf-8")
            index_text = index_text.replace("</title>", "</title><title>duplicate</title>", 1)
            index_text = index_text.replace(
                "</head>", f'<link rel="canonical" href="{root_url}"></head>', 1
            )
            index.write_text(index_text, encoding="utf-8")
            code, result = self.run_validator(temp_root)
            self.assertNotEqual(code, 0)
            self.assertTrue(any("duplicate canonical" in error for error in result["errors"]))
            self.assertTrue(any("expected exactly one canonical link" in error for error in result["errors"]))
            self.assertTrue(any("expected exactly one title" in error for error in result["errors"]))

    def test_rejects_nonexistent_sitemap_page(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_root = Path(directory)
            self.make_site(temp_root)
            sitemap = temp_root / "sitemap.xml"
            sitemap.write_text(
                sitemap.read_text(encoding="utf-8").replace(
                    "</urlset>",
                    f'<url><loc>{BASE}not-a-page.html</loc><lastmod>2026-09-09</lastmod></url></urlset>',
                    1,
                ),
                encoding="utf-8",
            )
            code, result = self.run_validator(temp_root)
            self.assertNotEqual(code, 0)
            self.assertTrue(any("missing local page not-a-page.html" in error for error in result["errors"]))

    def test_sitemap_lastmods_match_phase3_change_date(self):
        root = ET.parse(ROOT / "sitemap.xml").getroot()
        urls = root.findall("{*}url")
        self.assertEqual(len(urls), 55)
        self.assertTrue(all(url.findtext("{*}lastmod") == "2026-09-09" for url in urls))
        self.assertNotIn("404.html", "".join(url.findtext("{*}loc") or "" for url in urls))


if __name__ == "__main__":
    unittest.main()
