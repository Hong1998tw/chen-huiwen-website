#!/usr/bin/env python3
"""Static audit: shared header markup + core asset versions must match across public pages."""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "20260912-header3"
CORE_CSS = ("styles.css", "digital.css", "mobile.css", "layout.css")
CORE_JS = ("site.js", "digital.js")
EXPECTED_NAV = [
    "./",
    "political-donation.html",
    "election.html",
    "service.html#monthly-heading",
    "about.html",
    "achievements.html",
    "vision.html",
    "news.html",
    "activities.html",
    "service.html",
    "petition.html",
]
KEY_PAGES = [
    "index.html",
    "about.html",
    "political-donation.html",
    "election.html",
    "service.html",
    "achievements.html",
    "vision.html",
    "news.html",
    "activities.html",
    "petition.html",
    "404.html",
    "achievement-bade-detention.html",
]


def pages() -> list[Path]:
    return sorted(ROOT.glob("*.html")) + sorted((ROOT / "templates").glob("*.html"))


def nav_links(html: str) -> list[str]:
    m = re.search(r'<nav id="navigation"[^>]*>(.*?)</nav>', html, re.S)
    if not m:
        return []
    return re.findall(r'<a href="([^"]+)"', m.group(1))


def markup_hash(html: str) -> str | None:
    m = re.search(r'<header class="site-header".*?</header>', html, re.S)
    if not m:
        return None
    normalized = re.sub(r'\s+aria-current="page"', "", m.group(0))
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]


def asset_version(html: str, name: str) -> str | None:
    m = re.search(rf'{re.escape(name)}\?v=([^"\']+)', html)
    return m.group(1) if m else None


def audit() -> dict:
    failures: list[dict] = []
    hashes: dict[str, list[str]] = {}
    report_pages = []

    for path in pages():
        html = path.read_text(encoding="utf-8")
        if "site-header" not in html:
            continue
        rel = str(path.relative_to(ROOT))
        hrefs = nav_links(html)
        h = markup_hash(html)
        hashes.setdefault(h or "missing", []).append(rel)
        versions = {name: asset_version(html, name) for name in CORE_CSS + CORE_JS}
        page_fail = []
        if hrefs != EXPECTED_NAV:
            page_fail.append({"code": "NAV_ORDER", "got": hrefs})
        for name in CORE_CSS + CORE_JS:
            if versions[name] != VERSION:
                page_fail.append({"code": "ASSET_VERSION", "asset": name, "got": versions[name]})
        hdr_m = re.search(r'<header class="site-header".*?</header>', html, re.S)
        hdr = hdr_m.group(0) if hdr_m else ''
        if '<br/>' in hdr:
            page_fail.append({"code": "BR_MARKUP"})
        if hdr and not hdr.startswith('<header class="site-header"><div class="wrap nav-wrap"><a href="./" class="brand"'):
            page_fail.append({"code": "ATTR_ORDER"})
        entry = {"page": rel, "markup_hash": h, "versions": versions, "failures": page_fail}
        report_pages.append(entry)
        for f in page_fail:
            failures.append({"page": rel, **f})

    hash_groups = {k: v for k, v in hashes.items() if k != "missing"}
    if len(hash_groups) != 1:
        failures.append({"code": "MARKUP_HASH_SPLIT", "groups": hash_groups})

    # Key pages must exist
    for name in KEY_PAGES:
        if not (ROOT / name).exists():
            failures.append({"code": "MISSING_KEY_PAGE", "page": name})

    return {
        "version": VERSION,
        "expected_nav": EXPECTED_NAV,
        "page_count": len(report_pages),
        "unique_markup_hashes": list(hash_groups.keys()),
        "failures": failures,
        "pages": [p for p in report_pages if Path(p["page"]).name in KEY_PAGES or p["failures"]],
        "ok": not failures,
    }


def main() -> int:
    result = audit()
    out = ROOT.parent / "header-audit-static.json"
    # Prefer writing beside repo when invoked from workspace tooling
    target = Path("/workspace/header-audit-static.json")
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": result["ok"], "failures": len(result["failures"]), "hashes": result["unique_markup_hashes"]}, ensure_ascii=False))
    if not result["ok"]:
        for f in result["failures"][:20]:
            print("FAIL", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
