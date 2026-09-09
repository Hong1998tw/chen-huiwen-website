#!/usr/bin/env python3
"""Validate the www.huiwen.tw domain-migration candidate offline."""
from __future__ import annotations

import csv
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

OLD_BASE = "https://hong1998tw.github.io/chen-huiwen-website/"
NEW_BASE = "https://www.huiwen.tw/"
NEW_HOST = "www.huiwen.tw"


class HeadParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[dict[str, str]] = []
        self.metas: list[dict[str, str]] = []
        self.base_href = ""

    def handle_starttag(self, tag: str, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag.lower() == "link":
            self.links.append(a)
        elif tag.lower() == "meta":
            self.metas.append(a)
        elif tag.lower() == "base":
            self.base_href = a.get("href", "")


def canonical(doc: HeadParser) -> str:
    for link in doc.links:
        if "canonical" in link.get("rel", "").lower().split():
            return link.get("href", "").strip()
    return ""


def og_url(doc: HeadParser) -> str:
    for meta in doc.metas:
        if meta.get("property", "").lower() == "og:url":
            return meta.get("content", "").strip()
    return ""


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    errors: list[str] = []

    def fail(message: str) -> None:
        errors.append(message)

    public_targets = sorted(root.glob("*.html")) + sorted((root / "templates").glob("*.html"))
    public_targets += [
        root / "scripts" / "build_cases.py",
        root / "scripts" / "build_events.py",
        root / "scripts" / "validate_seo.py",
        root / "sitemap.xml",
        root / "robots.txt",
    ]
    for path in public_targets:
        if path.exists() and OLD_BASE in path.read_text(encoding="utf-8"):
            fail(f"{path.relative_to(root)}: old GitHub Pages canonical base remains")

    html_files = sorted(root.glob("*.html"))
    indexable = 0
    for path in html_files:
        text = path.read_text(encoding="utf-8")
        doc = HeadParser()
        doc.feed(text)
        robots = " ".join(
            m.get("content", "") for m in doc.metas if m.get("name", "").lower() == "robots"
        ).lower()
        if "noindex" in robots:
            continue
        indexable += 1
        c = canonical(doc)
        o = og_url(doc)
        if urlsplit(c).netloc != NEW_HOST:
            fail(f"{path.name}: canonical host is not {NEW_HOST}")
        if c != o:
            fail(f"{path.name}: canonical and og:url differ")

    not_found = root / "404.html"
    if not_found.exists():
        doc = HeadParser()
        doc.feed(not_found.read_text(encoding="utf-8"))
        if doc.base_href != NEW_BASE:
            fail("404.html: base href does not use the new canonical base")

    sitemap = root / "sitemap.xml"
    try:
        xml_root = ET.parse(sitemap).getroot()
        locs = [el.text.strip() for el in xml_root.iter() if el.tag.endswith("loc") and el.text]
    except (OSError, ET.ParseError) as exc:
        fail(f"sitemap.xml: cannot parse ({exc})")
        locs = []
    if not locs:
        fail("sitemap.xml: no URLs")
    for loc in locs:
        if urlsplit(loc).netloc != NEW_HOST:
            fail(f"sitemap.xml: wrong host {loc}")

    robots = (root / "robots.txt").read_text(encoding="utf-8")
    expected_sitemap = f"Sitemap: {NEW_BASE}sitemap.xml"
    if expected_sitemap not in robots.splitlines():
        fail("robots.txt: canonical sitemap directive is not www.huiwen.tw")

    legacy_path = root / "data" / "seo" / "legacy-urls.csv"
    redirect_path = root / "data" / "seo" / "redirect-map.csv"
    if not legacy_path.exists() or not redirect_path.exists():
        fail("migration governance CSV files are missing")
        legacy_rows = []
        redirect_rows = []
    else:
        with legacy_path.open(encoding="utf-8", newline="") as fh:
            legacy_rows = list(csv.DictReader(fh))
        with redirect_path.open(encoding="utf-8", newline="") as fh:
            redirect_rows = list(csv.DictReader(fh))

    if legacy_rows and len(legacy_rows) != 18:
        fail(f"legacy-urls.csv: expected 18 rows, got {len(legacy_rows)}")
    legacy_paths = [row.get("normalized_path", "") for row in legacy_rows]
    redirect_paths = [row.get("legacy_path", "") for row in redirect_rows]
    if len(legacy_paths) != len(set(legacy_paths)):
        fail("legacy-urls.csv: duplicate normalized_path")
    if set(legacy_paths) != set(redirect_paths):
        fail("legacy inventory and redirect map paths differ")

    allowed_home_sources = {"/", "/?pvs=18"}
    for row in redirect_rows:
        if row.get("new_path") == "/" and row.get("legacy_path") not in allowed_home_sources:
            fail(f"redirect-map.csv: unrelated legacy path redirects to home: {row.get('legacy_path')}")
        if row.get("action") in {"先補新頁再301", "410"} and row.get("verification_status") == "confirmed":
            fail(f"redirect-map.csv: unresolved/high-risk action marked confirmed: {row.get('legacy_path')}")

    cname = root / "CNAME"
    if cname.exists() and cname.read_text(encoding="utf-8").strip() != NEW_HOST:
        fail("CNAME: if present, it must contain only www.huiwen.tw")

    print(
        f"Domain migration validation: {'FAIL' if errors else 'PASS'} | "
        f"html={len(html_files)} indexable={indexable} sitemap={len(locs)} legacy={len(legacy_rows)}"
    )
    for error in errors:
        print(f"ERROR: {error}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
