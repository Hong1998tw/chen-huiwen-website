#!/usr/bin/env python3
"""Reject internal editorial / verification language from deployable public HTML."""
from pathlib import Path
import json
import re
from bs4 import BeautifulSoup

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
]
PATTERN = re.compile("|".join(BANNED))

failures = []
html_files = sorted(ROOT.glob("*.html"))
for path in html_files:
    soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html5lib")
    for node in soup(["script", "style"]):
        node.decompose()
    text = " ".join(soup.stripped_strings)
    match = PATTERN.search(text)
    if match:
        failures.append(f"{path.name}: public copy contains internal phrase: {match.group(0)}")

index = BeautifulSoup((ROOT / "index.html").read_text(encoding="utf-8"), "html5lib")
election = BeautifulSoup((ROOT / "election.html").read_text(encoding="utf-8"), "html5lib")
activities = BeautifulSoup((ROOT / "activities.html").read_text(encoding="utf-8"), "html5lib")

hero_status = index.select_one(".hero-copy > .hero-election-status")
if not hero_status:
    failures.append("index.html: homepage election status must sit directly inside the hero copy")
else:
    status_text = hero_status.get_text(" ", strip=True)
    if "勝選倒數" not in status_text or "2026.11.28" not in status_text:
        failures.append("index.html: hero election status must show the countdown and election date")
    if "10/23" in status_text or "候選人姓名號次抽籤" in status_text:
        failures.append("index.html: hero election status must not include the candidate-number draw")
    heading = index.select_one(".hero-copy > h1")
    if heading and heading.find_next_sibling() is not hero_status:
        failures.append("index.html: hero election status must immediately follow the slogan")
if index.select_one(".campaign-entry-compact"):
    failures.append("index.html: legacy standalone election module must be removed")
if len(election.select(".campaign-nav-card")) != 5:
    failures.append("election.html: full election center must expose five navigation cards")
for selector in ("#campaign-platforms", "#campaign-tracking", "#campaign-events"):
    if not election.select_one(selector):
        failures.append(f"election.html: missing full election content container {selector}")
achievements = BeautifulSoup((ROOT / "achievements.html").read_text(encoding="utf-8"), "html5lib")
if achievements.select_one("#achievement-dashboard, .digital-dashboard, .map-stats"):
    failures.append("achievements.html: statistics overview must not be rendered")
if "政績統計總覽" in achievements.get_text(" ", strip=True):
    failures.append("achievements.html: statistics overview copy must be removed")
heading = activities.find("h1")
if not heading or heading.get_text(" ", strip=True) != "公開行程與活動":
    failures.append("activities.html: public heading must be 公開行程與活動")

source_items = json.loads((ROOT / "data/achievements.json").read_text(encoding="utf-8"))
expected_pages = {f"achievement-{item['id']}.html" for item in source_items if item.get("status") != "待核驗"}
actual_pages = {path.name for path in ROOT.glob("achievement-*.html")}
if actual_pages != expected_pages:
    missing = sorted(expected_pages - actual_pages)
    unexpected = sorted(actual_pages - expected_pages)
    if missing:
        failures.append("missing public achievement pages: " + ", ".join(missing))
    if unexpected:
        failures.append("unexpected non-public achievement pages: " + ", ".join(unexpected))

if failures:
    print("Public copy validation failed:")
    for item in failures:
        print("-", item)
    raise SystemExit(1)
print(f"Public copy validation passed: {len(html_files)} HTML files; {len(actual_pages)} public achievements")
