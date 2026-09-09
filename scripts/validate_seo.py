#!/usr/bin/env python3
"""Offline, deterministic SEO contract checks for the generated public site."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

BASE = "https://hong1998tw.github.io/chen-huiwen-website/"
HOST = urlsplit(BASE).netloc
BASE_PATH = urlsplit(BASE).path
PLACEHOLDERS = ("YOUR_", "example.com", "{{", "}}")
SCHEMA_REQUIREMENTS = {
    "index.html": {"WebSite", "Person", "Organization"},
    "about.html": {"ProfilePage", "Person"},
    "achievements.html": {"CollectionPage"},
    "vision.html": {"CollectionPage"},
    "news.html": {"CollectionPage"},
    "activities.html": {"CollectionPage"},
    "gallery.html": {"ImageGallery"},
    "service.html": {"ContactPage"},
    "petition.html": {"ContactPage"},
    "political-donation.html": {"WebPage"},
    "activity-market.html": {"Article"},
    "activity-mooncake.html": {"Article"},
}


class Document(HTMLParser):
    """Small HTML metadata parser; no network or third-party dependency."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.attrs: list[tuple[str, dict[str, str]]] = []
        self.title = ""
        self._in_title = False
        self.metas: list[dict[str, str]] = []
        self.links: list[dict[str, str]] = []
        self.scripts: list[tuple[dict[str, str], str]] = []
        self._script_attrs: dict[str, str] | None = None
        self._script_data: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized = {k.lower(): (v or "") for k, v in attrs}
        self.attrs.append((tag.lower(), normalized))
        if tag.lower() == "title":
            self._in_title = True
        elif tag.lower() == "meta":
            self.metas.append(normalized)
        elif tag.lower() == "link":
            self.links.append(normalized)
        elif tag.lower() == "script":
            self._script_attrs = normalized
            self._script_data = []

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
        elif tag == "script" and self._script_attrs is not None:
            self.scripts.append((self._script_attrs, "".join(self._script_data).strip()))
            self._script_attrs = None
            self._script_data = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        if self._script_attrs is not None:
            self._script_data.append(data)


def parse(path: Path) -> tuple[Document, str]:
    text = path.read_text(encoding="utf-8")
    doc = Document()
    doc.feed(text)
    doc.close()
    return doc, text


def meta_values(doc: Document, key: str, value: str) -> list[str]:
    return [m.get("content", "").strip() for m in doc.metas if m.get(key, "").lower() == value]


def first_meta(doc: Document, key: str, value: str) -> str:
    values = meta_values(doc, key, value)
    return values[0] if values else ""


def canonical(doc: Document) -> str:
    for link in doc.links:
        if "canonical" in link.get("rel", "").lower().split():
            return link.get("href", "").strip()
    return ""


def schema_types(value: object) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        typ = value.get("@type")
        if isinstance(typ, str):
            found.add(typ)
        elif isinstance(typ, list):
            found.update(x for x in typ if isinstance(x, str))
        for child in value.values():
            found.update(schema_types(child))
    elif isinstance(value, list):
        for child in value:
            found.update(schema_types(child))
    return found


def walk_schema(value: object):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_schema(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_schema(child)


def normalize_local(raw: str, source: str) -> str | None:
    if not raw:
        return None
    u = urlsplit(raw)
    if u.scheme or u.netloc:
        return None
    path = unquote(u.path)
    if not path or path == "/":
        return "index.html"
    path = path.lstrip("/")
    if path == "./":
        return "index.html"
    if path.endswith("/"):
        path += "index.html"
    return path


def normalize_sitemap_target(raw: str) -> str | None:
    """Map a sitemap URL on the canonical site back to a local HTML name."""
    if not raw:
        return None
    u = urlsplit(raw)
    if u.scheme or u.netloc:
        if u.netloc != HOST:
            return None
        path = u.path
        if path == BASE_PATH or path == BASE_PATH.rstrip("/"):
            path = "/"
        elif path.startswith(BASE_PATH):
            path = path[len(BASE_PATH):]
        else:
            # Keep a sentinel so a same-host URL outside this repository fails
            # the missing-local-page check below instead of being ignored.
            return "__outside_canonical_base__"
        return normalize_local(path, "sitemap.xml")
    return normalize_local(raw, "sitemap.xml")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.root.resolve()
    errors: list[str] = []
    warnings: list[str] = []
    def fail(message: str) -> None:
        errors.append(message)

    pages = {p.name: parse(p)[0] for p in sorted(root.glob("*.html"))}
    indexable: dict[str, Document] = {}
    canonicals: dict[str, str] = {}
    inbound: Counter[str] = Counter()
    title_counter: Counter[str] = Counter()
    description_counter: Counter[str] = Counter()
    missing_schema: list[str] = []

    for name, doc in pages.items():
        robots = " ".join(meta_values(doc, "name", "robots")).lower()
        if "noindex" not in robots:
            indexable[name] = doc
        if name == "404.html" and "noindex" not in robots:
            fail("404.html: missing robots noindex")
        if name != "404.html" and "noindex" in robots:
            fail(f"{name}: unexpected noindex")

    for name, doc in indexable.items():
        title_count = sum(1 for tag, _ in doc.attrs if tag == "title")
        if title_count != 1:
            fail(f"{name}: expected exactly one title element, found {title_count}")
        html_langs = [attrs.get("lang", "") for tag, attrs in doc.attrs if tag == "html"]
        if html_langs != ["zh-Hant-TW"]:
            fail(f'{name}: expected html lang="zh-Hant-TW"')
        title = doc.title.strip()
        descriptions = meta_values(doc, "name", "description")
        c = canonical(doc)
        canonical_count = sum(
            1 for link in doc.links if "canonical" in link.get("rel", "").lower().split()
        )
        if canonical_count != 1:
            fail(f"{name}: expected exactly one canonical link, found {canonical_count}")
        og_url = first_meta(doc, "property", "og:url")
        if not title:
            fail(f"{name}: missing title")
        if len(descriptions) != 1 or not descriptions[0]:
            fail(f"{name}: expected one non-empty meta description")
        if not c:
            fail(f"{name}: missing canonical")
        if c and urlsplit(c).netloc != HOST:
            fail(f"{name}: canonical host is not the GitHub Pages host")
        if c and og_url != c:
            fail(f"{name}: canonical and og:url differ")
        for value, label in ((title, "title"), (descriptions[0] if descriptions else "", "description")):
            if any(token in value for token in PLACEHOLDERS):
                fail(f"{name}: {label} contains a template placeholder")
        required_meta = [
            ("property", "og:title"), ("property", "og:description"), ("property", "og:image"),
            ("property", "og:image:alt"), ("name", "twitter:card"), ("name", "twitter:title"),
            ("name", "twitter:description"), ("name", "twitter:image"), ("name", "twitter:image:alt"),
        ]
        for key, value in required_meta:
            if not first_meta(doc, key, value):
                fail(f"{name}: missing {value}")
        if len(meta_values(doc, "name", "description")) == 1:
            description_counter[descriptions[0]] += 1
        title_counter[title] += 1
        canonicals[name] = c
        parsed_jsonld: list[object] = []
        for attrs, payload in doc.scripts:
            if attrs.get("type", "").lower() != "application/ld+json":
                continue
            try:
                value = json.loads(payload)
            except (TypeError, json.JSONDecodeError) as exc:
                fail(f"{name}: invalid JSON-LD ({exc})")
                continue
            parsed_jsonld.append(value)
            for node in walk_schema(value):
                for key in ("url", "@id", "mainEntityOfPage"):
                    child = node.get(key)
                    if isinstance(child, str) and child.startswith("http") and urlsplit(child).netloc != HOST:
                        # sameAs and source links are intentionally external; URL identity fields are not.
                        fail(f"{name}: JSON-LD {key} points to another host")
                if node.get("@type") == "BreadcrumbList":
                    positions = [
                        item.get("position") for item in node.get("itemListElement", [])
                        if isinstance(item, dict) and isinstance(item.get("position"), int)
                    ]
                    if positions and positions != list(range(1, len(positions) + 1)):
                        fail(f"{name}: breadcrumb positions are not continuous")
        types = schema_types(parsed_jsonld)
        expected = SCHEMA_REQUIREMENTS.get(name)
        if expected and not expected.issubset(types):
            missing_schema.append(name)
            fail(f"{name}: missing JSON-LD types {sorted(expected - types)}")
        if name.startswith("achievement-"):
            headline = ""
            descriptions_in_schema: list[str] = []
            for attrs, payload in doc.scripts:
                if attrs.get("type", "").lower() != "application/ld+json":
                    continue
                try:
                    parsed = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                for node in walk_schema(parsed):
                    if node.get("@type") == "Article":
                        headline = str(node.get("headline", ""))
                        descriptions_in_schema.append(str(node.get("description", "")))
                        meop = node.get("mainEntityOfPage")
                        if meop != c:
                            fail(f"{name}: Article mainEntityOfPage does not match canonical")
            if headline and not title.startswith(headline):
                fail(f"{name}: Article headline does not match title")
            if descriptions_in_schema and descriptions_in_schema[0] != descriptions[0]:
                fail(f"{name}: Article description does not match meta description")

        for tag, attrs in doc.attrs:
            if tag != "a" or not attrs.get("href"):
                continue
            target = normalize_local(attrs["href"], name)
            if target and target.endswith(".html") and target in pages and target != name:
                inbound[target] += 1

    for title, count in title_counter.items():
        if count > 1:
            fail(f"duplicate title ({count} pages): {title}")
    for description, count in description_counter.items():
        if count >= 4:
            fail(f"generic description repeated on {count} pages: {description}")

    for name in indexable:
        if name != "index.html" and inbound[name] == 0:
            fail(f"{name}: orphan indexable page")
    if inbound["gallery.html"] == 0:
        fail("gallery.html: no contextual inbound link")

    canonical_counter = Counter(canonicals.values())
    for value, count in canonical_counter.items():
        if value and count > 1:
            fail(f"duplicate canonical ({count} pages): {value}")

    sitemap_path = root / "sitemap.xml"
    try:
        xml_root = ET.parse(sitemap_path).getroot()
        locs = [el.text.strip() for el in xml_root.iter() if el.tag.endswith("loc") and el.text]
        lastmods = {el.findtext("{*}loc"): el.findtext("{*}lastmod") for el in xml_root.findall("{*}url")}
    except (OSError, ET.ParseError) as exc:
        fail(f"sitemap.xml: cannot parse ({exc})")
        locs, lastmods = [], {}
    if len(locs) != len(set(locs)):
        fail("sitemap.xml: duplicate loc")
    for loc in locs:
        if urlsplit(loc).netloc != HOST:
            fail(f"sitemap.xml: wrong host {loc}")
        target = normalize_sitemap_target(loc)
        if target == "404.html":
            fail("sitemap.xml: 404.html must not be indexed")
        if target and target not in pages:
            fail(f"sitemap.xml: missing local page {target}")
    for name, c in canonicals.items():
        if c not in locs:
            fail(f"{name}: canonical missing from sitemap")
        if locs.count(c) != 1:
            fail(f"{name}: canonical must appear exactly once in sitemap")
    for loc, lastmod in lastmods.items():
        try:
            dt.date.fromisoformat(lastmod or "")
        except ValueError:
            fail(f"sitemap.xml: invalid lastmod for {loc}")

    robots = (root / "robots.txt").read_text(encoding="utf-8")
    sitemap_directives = [line.split(":", 1)[1].strip() for line in robots.splitlines()
                          if line.lower().startswith("sitemap:")]
    if sitemap_directives != [BASE + "sitemap.xml"]:
        fail("robots.txt: Sitemap directive does not match the canonical sitemap")

    result = {
        "status": "FAIL" if errors else "PASS",
        "htmlPages": len(pages),
        "indexablePages": len(indexable),
        "sitemapUrls": len(locs),
        "duplicateTitles": sum(1 for count in title_counter.values() if count > 1),
        "duplicateDescriptions": sum(1 for count in description_counter.values() if count >= 4),
        "orphanPages": sorted(name for name in indexable if name != "index.html" and inbound[name] == 0),
        "missingSchema": missing_schema,
        "socialImageAltFailures": sum(1 for name, doc in indexable.items()
                                       if not first_meta(doc, "name", "twitter:image:alt")),
        "404Noindex": "noindex" in " ".join(meta_values(pages.get("404.html", Document()), "name", "robots")).lower(),
        "warnings": warnings,
        "errors": errors,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
