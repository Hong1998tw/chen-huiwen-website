#!/usr/bin/env python3
"""Reject internal editorial / verification language from every public copy surface."""
from pathlib import Path
import json
import re
import sys

from bs4 import BeautifulSoup
from build_public import PROJECTION, PUBLIC_DATA, public_paths

ROOT = Path(__file__).resolve().parents[1]
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
PRIVATE_PROJECTION_KEYS = {
    "notes", "notes_private", "editorialReview", "verification", "verifiedAt",
    "villageMethod", "candidate_id", "candidate_status", "source_file",
    "source_sheet", "source_row", "original_case_id",
}
PUBLIC_JSON_REQUIRED = {PROJECTION, "data/achievement-map.json", "data/search-index.json"}
TEXT_ATTRIBUTES = ("alt", "aria-label", "content", "placeholder", "title", "data-label", "data-tooltip")


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
    strings.extend(soup.stripped_strings)
    return strings


def check_html(path, markup):
    findings = []
    for index, text in enumerate(html_public_strings(markup)):
        match = PATTERN.search(text)
        if match:
            findings.append(f"{path}:public-string[{index}]: internal phrase {match.group(0)}")
    return findings


def public_html_paths(root=ROOT):
    """Use the deployment allowlist, including reviewed directory-style routes."""
    return [root / relative for relative in public_paths(root) if relative.endswith(".html")]


def validate(root=ROOT):
    failures = []
    html_files = public_html_paths(root)
    for path in html_files:
        failures.extend(check_html(path.relative_to(root).as_posix(), path.read_text(encoding="utf-8")))

    for relative in PUBLIC_DATA:
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
