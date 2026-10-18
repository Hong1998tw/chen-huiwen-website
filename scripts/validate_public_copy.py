#!/usr/bin/env python3
"""Reject internal editorial / verification language from every public copy surface."""
from pathlib import Path
import json
import re
import sys
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup, Comment, NavigableString
from build_public import (
    PROJECTION, PUBLIC_DATA, PUBLIC_DATA_PROJECTIONS, project_public_data,
    public_paths,
)

ROOT = Path(__file__).resolve().parents[1]
SITE_BASE = "https://www.huiwen.tw/"
BANNED = [
    r"待核驗",
    r"資料核驗狀態",
    r"資料查核",
    r"來源邊界",
    r"不混為完成",
    r"正式選舉公報尚未取得",
    r"不等於市府已承諾完成",
    r"已依提供圖卡轉錄",
    r"依本站已收到並核對",
    r"本頁保留議題索引",
    r"尚未取得足以核對",
    r"本次尚未取得足以",
    r"足以獨立重複核定",
    r"來源反映文件發布時的狀態",
    # Internal editorial / Evidence-QA meta-language must never leak into public output.
    r"可定位來源",
    r"可驗證角色",
    r"Evidence／QA",
    r"Evidence QA",
    r"PUBLIC COPY",
    r"內部查核",
    r"官網將本案呈現",
    r"本案定位為",
    r"不把既有工程改寫成個人促成",
    r"不主張由單一提案創設工程",
    r"不作單一人物(?:獨占|獨力)?歸因",
    r"不把跨機關、跨層級工程改寫成單一人物獨力完成",
]
PATTERN = re.compile("|".join(BANNED))
COMPACT_PATTERN = re.compile("|".join(phrase.replace(" ", "") for phrase in BANNED))
PRIVATE_PROJECTION_KEYS = {
    "notes", "notes_private", "editorialReview", "verification", "verifiedAt",
    "villageMethod", "candidate_id", "candidate_status", "source_file",
    "source_sheet", "source_row", "original_case_id", "checkedAt",
    "publicAccessConfirmed",
}
PUBLIC_JSON_REQUIRED = {PROJECTION, "data/achievement-map.json", "data/search-index.json"}
ARTIFACT_JSON_REQUIRED = PUBLIC_JSON_REQUIRED | {
    "data/achievements.json", "data/election-2026.json", "data/platforms.json", "data/site-profile.json",
}
TEXT_ATTRIBUTES = ("alt", "aria-label", "content", "placeholder", "title", "data-label", "data-tooltip")
BLOCK_TEXT_TAGS = {
    "address", "article", "aside", "blockquote", "body", "caption", "dd", "details",
    "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
    "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html",
    "legend", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "table",
    "tbody", "td", "tfoot", "th", "thead", "title", "tr", "ul",
}


def iter_strings(value, location="$"):
    """Yield every string in a JSON-like value with its field path."""
    if isinstance(value, str):
        yield location, value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from iter_strings(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from iter_strings(child, f"{location}[{index}]")


def inline_text_groups(root):
    """Join text across inline tags, while keeping block copy boundaries intact."""
    groups = []

    def flush(parts):
        text = re.sub(r"\s+", " ", "".join(parts)).strip()
        if text:
            groups.append(text)
        parts.clear()

    def walk_inline(node, parts):
        for child in node.children:
            if isinstance(child, Comment):
                continue
            if isinstance(child, NavigableString):
                parts.append(str(child))
            elif child.name == "br":
                parts.append(" ")
            elif child.name in BLOCK_TEXT_TAGS:
                flush(parts)
                walk_block(child)
            else:
                walk_inline(child, parts)

    def walk_block(node):
        parts = []
        walk_inline(node, parts)
        flush(parts)

    walk_block(root)
    return groups


def check_json(path, value, forbid_private_keys=False):
    """Find internal language and, for the achievement projection, review-only keys."""
    findings = []
    if forbid_private_keys:
        def visit(node, location="$"):
            if isinstance(node, dict):
                for key, child in node.items():
                    child_path = f"{location}.{key}"
                    if key in PRIVATE_PROJECTION_KEYS:
                        findings.append(f"{path}:{child_path}: review-only field {key}")
                    visit(child, child_path)
            elif isinstance(node, list):
                for index, child in enumerate(node):
                    visit(child, f"{location}[{index}]")
        visit(value)
    for location, text in iter_strings(value):
        match = PATTERN.search(text)
        if match:
            findings.append(f"{path}:{location}: internal phrase {match.group(0)}")
    return findings


def html_public_strings(markup):
    """Extract visible copy, public text attributes, and inline structured data."""
    soup = BeautifulSoup(markup, "html5lib")
    strings = []
    for node in soup.find_all("script"):
        kind = (node.get("type") or "").split(";", 1)[0].strip().lower()
        if kind in {"application/ld+json", "application/json"}:
            raw = node.string or node.get_text(" ", strip=True)
            try:
                strings.extend(text for _, text in iter_strings(json.loads(raw)))
            except (json.JSONDecodeError, TypeError):
                strings.append(raw)
    for node in soup.find_all(True):
        for attribute in TEXT_ATTRIBUTES:
            value = node.get(attribute)
            if isinstance(value, str):
                strings.append(value)
            elif isinstance(value, list):
                strings.extend(item for item in value if isinstance(item, str))
    for node in soup(["script", "style"]):
        node.decompose()
    strings.extend(inline_text_groups(soup))
    return strings


def check_html(path, markup):
    findings = []
    for index, text in enumerate(html_public_strings(markup)):
        match = PATTERN.search(text) or COMPACT_PATTERN.search(re.sub(r"\s+", "", text))
        if match:
            findings.append(f"{path}:public-string[{index}]: internal phrase {match.group(0)}")
    return findings


def is_external_link(href, page_path):
    """Classify a rendered link against the canonical origin, including page-relative URLs."""
    value = str(href or "")
    try:
        scheme = urlsplit(value).scheme.lower()
        if scheme in {"mailto", "tel"}:
            return False
        page_url = urljoin(SITE_BASE, str(page_path).lstrip("/"))
        destination = urlsplit(urljoin(page_url, value))
        site = urlsplit(SITE_BASE)

        def origin(url):
            scheme = url.scheme.lower()
            try:
                port = url.port
            except ValueError:
                return (scheme, (url.hostname or "").lower(), -1)
            default_port = 443 if scheme == "https" else 80 if scheme == "http" else None
            return (scheme, (url.hostname or "").lower(), port or default_port)

        return origin(destination) != origin(site)
    except ValueError:
        return True


def check_directional_arrows(path, markup):
    """Keep internal and contact links on → and links to other origins on ↗."""
    findings = []
    soup = BeautifulSoup(markup, "html5lib")
    for anchor in soup.find_all("a", href=True):
        text = anchor.get_text(" ", strip=True)
        marks = {glyph for glyph in ("→", "↗", "↓", "←") if glyph in text}
        if not marks:
            continue
        href = anchor.get("href", "")
        if len(marks) != 1:
            findings.append(f"{path}: link must use one directional marker: {href}")
            continue
        external = is_external_link(href, path)
        expected = "↗" if external else "→"
        if marks != {expected}:
            kind = "external" if external else "internal"
            findings.append(f"{path}: {kind} link must use {expected}: {href}")
    return findings


LEGACY_PUBLIC_UI_LABELS = (
    "ABOUT HUI-WEN", "EVENTS", "LOCAL STORY", "EXPLORE FENGSHAN",
    "MOMENTS & MEMORIES", "KAOHSIUNG CITY COUNCIL",
    "PRESS RELEASES & UPDATES", "PRESS RELEASE ARCHIVE", "NEWS & UPDATES",
    "TELL US YOUR CONCERNS", "WE ARE HERE TO HELP", "WEBSITE TERMS",
    "SOCIAL HOUSING", "HUMAN RIGHTS", "PUBLIC SCHEDULE", "PUBLIC RECORDS",
    "STAY CONNECTED", "RELATED STORIES",
)
REQUIRED_PUBLIC_UI_LABELS = {
    "about.html": ((".eyebrow", "關於慧文"), (".eyebrow", "追蹤慧文的近況")),
    "activities.html": ((".eyebrow", "公開行程"),),
    "activity-market.html": ((".eyebrow", "地方故事"),),
    "explore.html": ((".eyebrow", "主題探索"),),
    "gallery.html": ((".eyebrow", "相片集"),),
    "council-records.html": ((".eyebrow", "議會公開紀錄"),),
    "press.html": (("h1", "服務處新聞稿"), (".eyebrow", "服務處新聞稿"), (".eyebrow", "新聞稿與公開說明")),
    "news.html": (("h1", "最新動態"), (".eyebrow", "最新動態")),
    "petition.html": ((".eyebrow", "反映服務需求"), (".eyebrow", "服務協助")),
    "terms.html": ((".eyebrow", "服務條款"),),
    "history-kumamoto-relief.html": ((".eyebrow", "KAOHSIUNG · KUMAMOTO · 災後互助"),),
    "history-meilidao.html": ((".eyebrow", "KAOHSIUNG · 人權 · 1979"),),
    "election.html": ((".eyebrow", "公開追蹤紀錄"), (".eyebrow", "公開行程與活動")),
    "renwu-anju-social-housing/index.html": ((".eyebrow", "社會住宅 · 2026"),),
}


def check_public_ui_labels(path, markup):
    """Guard only the approved visible UI labels; preserve foreign names, brands and code."""
    findings = []
    relative = Path(path).as_posix()
    soup = BeautifulSoup(markup, "html5lib")
    ui_labels = [" ".join(node.get_text(" ", strip=True).split())
                 for node in soup.select("h1, h2, h3, h4, .eyebrow")]
    folded = {text.casefold() for text in ui_labels}
    for label in LEGACY_PUBLIC_UI_LABELS:
        if label.casefold() in folded:
            findings.append(f"{relative}: untranslated public UI label {label}")
    for selector, expected in REQUIRED_PUBLIC_UI_LABELS.get(relative, ()):
        actual = [" ".join(node.get_text(" ", strip=True).split()) for node in soup.select(selector)]
        if expected not in actual:
            findings.append(f"{relative}: expected {selector} label {expected}")
    if relative == "index.html":
        news_link = soup.select_one('#navigation a[href="news.html"]')
        if not news_link or news_link.get_text(" ", strip=True) != "最新動態與媒體報導":
            findings.append("index.html: news navigation label must be 最新動態與媒體報導")
    return findings


def validate_artifact_surface(root):
    """Scan the finished artifact, including post-CMS HTML and every JSON file."""
    root = Path(root)
    failures = []
    html_files = sorted(root.rglob("*.html"))
    json_files = sorted(root.rglob("*.json"))
    nonpublic_roots = {"admin", "docs", "templates", "tests"}
    public_routes = {
        path.relative_to(root).as_posix() for path in html_files
        if path.relative_to(root).parts[0] not in nonpublic_roots
    }
    present = {path.relative_to(root).as_posix() for path in json_files}
    for relative in sorted(ARTIFACT_JSON_REQUIRED - present):
        failures.append(f"{relative}: required public JSON is missing")

    for path in html_files:
        relative = path.relative_to(root).as_posix()
        markup = path.read_text(encoding="utf-8")
        failures.extend(check_html(relative, markup))
        if relative in public_routes:
            failures.extend(check_directional_arrows(relative, markup))
            failures.extend(check_public_ui_labels(relative, markup))

    from build_public import validate_public_projection

    for path in json_files:
        relative = path.relative_to(root).as_posix()
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            failures.append(f"{relative}: invalid public JSON: {exc}")
            continue
        failures.extend(check_json(
            relative, payload,
            forbid_private_keys=relative in {PROJECTION, "data/achievements.json"},
        ))
        if relative in {"data/election-2026.json", "data/platforms.json", "data/site-profile.json"}:
            try:
                validate_public_projection(relative, payload)
            except ValueError as exc:
                failures.append(str(exc))
    return failures


def validate_public_data(root=ROOT):
    """Scan deployed data, using publication projections for canonical review sources."""
    failures = []
    try:
        projections = project_public_data(root)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        failures.append(f"public JSON projection failed: {exc}")
        projections = {}

    for relative in PUBLIC_DATA:
        if relative in PUBLIC_DATA_PROJECTIONS:
            if relative not in projections:
                continue
            payload = projections[relative]
        else:
            path = root / relative
            if not path.is_file():
                if relative in PUBLIC_JSON_REQUIRED:
                    failures.append(f"{relative}: required public JSON is missing")
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                failures.append(f"{relative}: invalid public JSON: {exc}")
                continue
        failures.extend(check_json(relative, payload, forbid_private_keys=relative == PROJECTION))
    return failures


def public_html_paths(root=ROOT):
    """Use the deployment allowlist, including reviewed directory-style routes."""
    return [root / relative for relative in public_paths(root) if relative.endswith(".html")]


def validate(root=ROOT):
    failures = []
    html_files = public_html_paths(root)
    for path in html_files:
        relative = path.relative_to(root).as_posix()
        markup = path.read_text(encoding="utf-8")
        failures.extend(check_html(relative, markup))
        failures.extend(check_directional_arrows(relative, markup))
        failures.extend(check_public_ui_labels(relative, markup))
    failures.extend(validate_public_data(root))

    index = BeautifulSoup((root / "index.html").read_text(encoding="utf-8"), "html5lib")
    election = BeautifulSoup((root / "election.html").read_text(encoding="utf-8"), "html5lib")
    activities = BeautifulSoup((root / "activities.html").read_text(encoding="utf-8"), "html5lib")

    hero_actions = index.select_one(".hero-actions")
    if not hero_actions or not hero_actions.select_one('a[href="https://line.me/R/ti/p/@yve2766q"]'):
        failures.append("index.html: approved LINE hero action is missing")
    if len(index.select('main a[href="service.html#monthly-heading"]')) != 1:
        failures.append("index.html: homepage must offer one main lawyer schedule entry")
    if index.select_one('.hero-election-status, .campaign-entry-compact'):
        failures.append("index.html: superseded hero election modules must not duplicate the new service-first layout")
    if not index.select_one('#navigation a[href="election.html"]'):
        failures.append("index.html: preserve the full election center route")
    if len(election.select(".campaign-nav-card")) != 5:
        failures.append("election.html: full election center must expose five navigation cards")
    for selector in ("#campaign-platforms", "#campaign-tracking", "#campaign-events"):
        if not election.select_one(selector):
            failures.append(f"election.html: missing full election content container {selector}")
    achievements = BeautifulSoup((root / "achievements.html").read_text(encoding="utf-8"), "html5lib")
    if achievements.select_one("#achievement-dashboard, .digital-dashboard, .map-stats"):
        failures.append("achievements.html: statistics overview must not be rendered")
    if "政績統計總覽" in achievements.get_text(" ", strip=True):
        failures.append("achievements.html: statistics overview copy must be removed")
    heading = activities.find("h1")
    if not heading or heading.get_text(" ", strip=True) != "公開行程與活動":
        failures.append("activities.html: public heading must be 公開行程與活動")

    source_items = json.loads((root / "data/achievements.json").read_text(encoding="utf-8"))
    expected_pages = {f"achievement-{item['id']}.html" for item in source_items if item.get("status") != "待核驗"}
    actual_pages = {path.name for path in root.glob("achievement-*.html")}
    if actual_pages != expected_pages:
        missing = sorted(expected_pages - actual_pages)
        unexpected = sorted(actual_pages - expected_pages)
        if missing:
            failures.append("missing public achievement pages: " + ", ".join(missing))
        if unexpected:
            failures.append("unexpected non-public achievement pages: " + ", ".join(unexpected))
    return failures, len(html_files), len(actual_pages)


def main():
    failures, html_count, page_count = validate(ROOT)
    if failures:
        print("Public copy validation failed:")
        for item in failures:
            print("-", item)
        return 1
    print(f"Public copy validation passed: {html_count} HTML files; {page_count} public achievements and structured public data")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
