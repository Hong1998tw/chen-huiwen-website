#!/usr/bin/env python3
"""Independent live production verification for www.huiwen.tw.

Compares critical production responses against the checked-out canonical source
and validates basic HTML metadata. Intended to run after a main-branch deploy.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE_URL = "https://www.huiwen.tw/"
CORE_PAGES = (
    "index.html",
    "about.html",
    "achievements.html",
    "vision.html",
    "news.html",
    "activities.html",
    "service.html",
    "petition.html",
    "political-donation.html",
)
STATIC_FILES = ("robots.txt", "sitemap.xml")


class HeadParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.lang = None
        self.title_parts: list[str] = []
        self.in_title = False
        self.canonical = None
        self.description = None
        self.local_assets: set[str] = set()

    def handle_starttag(self, tag: str, attrs) -> None:
        data = dict(attrs)
        if tag == "html":
            self.lang = data.get("lang")
        elif tag == "title":
            self.in_title = True
        elif tag == "link":
            rel = (data.get("rel") or "").lower().split()
            href = data.get("href")
            if "canonical" in rel:
                self.canonical = href
            if "stylesheet" in rel and href:
                self._add_asset(href)
        elif tag == "meta":
            if (data.get("name") or "").lower() == "description":
                self.description = data.get("content")
        elif tag == "script" and data.get("src"):
            self._add_asset(data["src"])

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)

    def _add_asset(self, raw: str) -> None:
        u = urlsplit(raw)
        if u.scheme or u.netloc or not u.path:
            return
        path = u.path.lstrip("/")
        if path and not path.startswith("../"):
            self.local_assets.add(path)

    @property
    def title(self) -> str:
        return "".join(self.title_parts).strip()


def normalize_text_bytes(data: bytes) -> bytes:
    text = data.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    return text.rstrip().encode("utf-8")


def digest(data: bytes) -> str:
    return hashlib.sha256(normalize_text_bytes(data)).hexdigest()


def remote_path(local_path: str) -> str:
    return "/" if local_path == "index.html" else "/" + local_path


def fetch(base_url: str, path: str, cache_key: str, timeout: int) -> tuple[int, str, bytes]:
    target = urljoin(base_url, path.lstrip("/"))
    separator = "&" if "?" in target else "?"
    target = f"{target}{separator}production-verification={cache_key}"
    request = Request(
        target,
        headers={
            "User-Agent": "chen-huiwen-production-verifier/1.0",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        return response.status, response.geturl(), response.read()


def verify_once(base_url: str, timeout: int) -> dict:
    checks: list[dict] = []
    failures: list[str] = []
    assets: set[str] = set()
    base_host = urlsplit(base_url).hostname

    paths = list(CORE_PAGES) + list(STATIC_FILES)
    for local_path in paths:
        source_path = ROOT / local_path
        if not source_path.is_file():
            failures.append(f"{local_path}: missing canonical source")
            continue
        local = source_path.read_bytes()
        cache_key = digest(local)[:16]
        try:
            status, final_url, remote = fetch(base_url, remote_path(local_path), cache_key, timeout)
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            failures.append(f"{local_path}: fetch failed ({type(exc).__name__})")
            checks.append({"path": local_path, "status": "Failed", "stage": "fetch"})
            continue

        final = urlsplit(final_url)
        same_host = final.hostname == base_host
        parity = digest(local) == digest(remote)
        checks.append(
            {
                "path": local_path,
                "status": "Passed" if status == 200 and same_host and parity else "Failed",
                "http": status,
                "sameHost": same_host,
                "sourceParity": parity,
                "localSha256": digest(local),
                "remoteSha256": digest(remote),
            }
        )
        if status != 200:
            failures.append(f"{local_path}: HTTP {status}")
        if not same_host:
            failures.append(f"{local_path}: redirected away from production host")
        if not parity:
            failures.append(f"{local_path}: production body differs from canonical source")

        if local_path.endswith(".html"):
            remote_text = remote.decode("utf-8-sig", errors="replace")
            parser = HeadParser()
            parser.feed(remote_text)
            assets.update(parser.local_assets)
            local_parser = HeadParser()
            local_parser.feed(local.decode("utf-8-sig"))
            if parser.lang != "zh-Hant-TW":
                failures.append(f"{local_path}: live lang is not zh-Hant-TW")
            if not parser.title or parser.title != local_parser.title:
                failures.append(f"{local_path}: live title mismatch")
            if not parser.description or parser.description != local_parser.description:
                failures.append(f"{local_path}: live description mismatch")
            if not parser.canonical or parser.canonical != local_parser.canonical:
                failures.append(f"{local_path}: live canonical mismatch")

    for asset in sorted(assets):
        source_path = ROOT / asset
        if not source_path.is_file():
            failures.append(f"{asset}: referenced local asset missing from canonical source")
            continue
        local = source_path.read_bytes()
        cache_key = digest(local)[:16]
        try:
            status, final_url, remote = fetch(base_url, "/" + asset, cache_key, timeout)
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            failures.append(f"{asset}: fetch failed ({type(exc).__name__})")
            checks.append({"path": asset, "status": "Failed", "stage": "fetch"})
            continue
        same_host = urlsplit(final_url).hostname == base_host
        parity = digest(local) == digest(remote)
        checks.append(
            {
                "path": asset,
                "status": "Passed" if status == 200 and same_host and parity else "Failed",
                "http": status,
                "sameHost": same_host,
                "sourceParity": parity,
                "localSha256": digest(local),
                "remoteSha256": digest(remote),
            }
        )
        if status != 200:
            failures.append(f"{asset}: HTTP {status}")
        if not same_host:
            failures.append(f"{asset}: redirected away from production host")
        if not parity:
            failures.append(f"{asset}: production body differs from canonical source")

    return {
        "status": "Passed" if not failures else "Failed",
        "baseUrl": base_url,
        "checked": len(checks),
        "failures": failures,
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--attempts", type=int, default=1)
    parser.add_argument("--delay", type=int, default=20)
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--report")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/") + "/"
    result = {}
    for attempt in range(1, max(args.attempts, 1) + 1):
        result = verify_once(base_url, args.timeout)
        result["attempt"] = attempt
        if result["status"] == "Passed":
            break
        if attempt < args.attempts:
            time.sleep(max(args.delay, 0))

    payload = json.dumps(result, ensure_ascii=False, indent=2)
    print(payload)
    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(payload + "\n", encoding="utf-8")
    return 0 if result.get("status") == "Passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
