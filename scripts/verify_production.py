#!/usr/bin/env python3
"""Independent live production verification for www.huiwen.tw.

Cloudflare may intentionally transform HTML at the edge (for example email
obfuscation or Rocket Loader), so HTML is verified semantically instead of by
raw byte equality. Canonical same-origin CSS/JS assets and static files still
require exact hash parity.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
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
    "election.html",
    "press.html",
    "facts.html",
    "achievements.html",
    "vision.html",
    "news.html",
    "activities.html",
    "service.html",
    "petition.html",
    "political-donation.html",
)
STATIC_FILES = ("robots.txt", "sitemap.xml", "data/election-2026.json")
MIN_TEXT_COVERAGE = 0.95


def normalize_space(value: str) -> str:
    return " ".join(value.split())


def decode_cfemail(value: str) -> str | None:
    """Decode Cloudflare Email Address Obfuscation's data-cfemail payload."""
    try:
        encoded = bytes.fromhex(value)
        if len(encoded) < 2:
            return None
        key = encoded[0]
        return bytes(byte ^ key for byte in encoded[1:]).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.lang = None
        self.title_parts: list[str] = []
        self.in_title = False
        self.canonical = None
        self.description = None
        self.local_assets: set[str] = set()
        self.visible_fragments: list[str] = []
        self._hidden_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        data = dict(attrs)
        if tag in {"script", "style", "template", "noscript"}:
            self._hidden_depth += 1
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

        # Cloudflare replaces visible email addresses with a placeholder and a
        # reversible data-cfemail payload. Rehydrate the original address for
        # semantic source comparison while still allowing the injected markup.
        cfemail = data.get("data-cfemail")
        if not self._hidden_depth and cfemail:
            decoded = decode_cfemail(cfemail)
            if decoded:
                self.visible_fragments.append(decoded)

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
        if tag in {"script", "style", "template", "noscript"} and self._hidden_depth:
            self._hidden_depth -= 1

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)
        if not self._hidden_depth:
            text = normalize_space(data)
            if text:
                self.visible_fragments.append(text)

    def _add_asset(self, raw: str) -> None:
        url = urlsplit(raw)
        if url.scheme or url.netloc or not url.path:
            return
        path = url.path.lstrip("/")
        if path and not path.startswith("../") and not path.startswith("cdn-cgi/"):
            self.local_assets.add(path)

    @property
    def title(self) -> str:
        return "".join(self.title_parts).strip()

    @property
    def visible_text(self) -> str:
        return normalize_space(" ".join(self.visible_fragments))


def normalize_text_bytes(data: bytes) -> bytes:
    text = data.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    return text.rstrip().encode("utf-8")


def digest(data: bytes) -> str:
    return hashlib.sha256(normalize_text_bytes(data)).hexdigest()


def visible_text_coverage(local: PageParser, remote: PageParser) -> float:
    fragments = [fragment for fragment in local.visible_fragments if len(fragment) >= 4]
    if not fragments:
        return 1.0
    remote_text = remote.visible_text
    total = sum(len(fragment) for fragment in fragments)
    matched = sum(len(fragment) for fragment in fragments if fragment in remote_text)
    return matched / total if total else 1.0


def remote_path(local_path: str) -> str:
    return "/" if local_path == "index.html" else "/" + local_path


def fetch(base_url: str, path: str, cache_key: str, timeout: int) -> tuple[int, str, bytes]:
    target = urljoin(base_url, path.lstrip("/"))
    separator = "&" if "?" in target else "?"
    target = f"{target}{separator}production-verification={cache_key}"
    request = Request(
        target,
        headers={
            "User-Agent": "chen-huiwen-production-verifier/1.3",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        return response.status, response.geturl(), response.read()


def verification_cache_key(local: bytes, run_cache_key: str, attempt: int) -> str:
    """Use a fresh URL namespace for every workflow run and retry attempt."""
    return f"{digest(local)[:16]}-{run_cache_key}-{attempt}"


def verify_once(base_url: str, timeout: int, run_cache_key: str, attempt: int) -> dict:
    checks: list[dict] = []
    failures: list[str] = []
    assets: set[str] = set()
    base_host = urlsplit(base_url).hostname

    for local_path in list(CORE_PAGES) + list(STATIC_FILES):
        source_path = ROOT / local_path
        if not source_path.is_file():
            failures.append(f"{local_path}: missing canonical source")
            continue

        local = source_path.read_bytes()
        cache_key = verification_cache_key(local, run_cache_key, attempt)
        try:
            status, final_url, remote = fetch(base_url, remote_path(local_path), cache_key, timeout)
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            failures.append(f"{local_path}: fetch failed ({type(exc).__name__})")
            checks.append({"path": local_path, "status": "Failed", "stage": "fetch"})
            continue

        same_host = urlsplit(final_url).hostname == base_host
        raw_parity = digest(local) == digest(remote)

        if local_path.endswith(".html"):
            local_parser = PageParser()
            local_parser.feed(local.decode("utf-8-sig", errors="replace"))
            remote_parser = PageParser()
            remote_parser.feed(remote.decode("utf-8-sig", errors="replace"))
            assets.update(local_parser.local_assets)

            page_failures: list[str] = []
            if status != 200:
                page_failures.append(f"HTTP {status}")
            if not same_host:
                page_failures.append("redirected away from production host")
            if remote_parser.lang != "zh-Hant-TW":
                page_failures.append("live lang is not zh-Hant-TW")
            if not remote_parser.title or remote_parser.title != local_parser.title:
                page_failures.append("live title mismatch")
            if not remote_parser.description or remote_parser.description != local_parser.description:
                page_failures.append("live description mismatch")
            if not remote_parser.canonical or remote_parser.canonical != local_parser.canonical:
                page_failures.append("live canonical mismatch")

            missing_assets = sorted(local_parser.local_assets - remote_parser.local_assets)
            if missing_assets:
                page_failures.append("canonical asset references missing: " + ", ".join(missing_assets))

            coverage = visible_text_coverage(local_parser, remote_parser)
            if coverage < MIN_TEXT_COVERAGE:
                page_failures.append(
                    f"visible text coverage {coverage:.3f} below {MIN_TEXT_COVERAGE:.2f}"
                )

            checks.append(
                {
                    "path": local_path,
                    "status": "Passed" if not page_failures else "Failed",
                    "http": status,
                    "sameHost": same_host,
                    "rawSourceParity": raw_parity,
                    "edgeTransformed": not raw_parity,
                    "visibleTextCoverage": round(coverage, 4),
                    "expectedAssetsPresent": not missing_assets,
                    "localSha256": digest(local),
                    "remoteSha256": digest(remote),
                }
            )
            failures.extend(f"{local_path}: {failure}" for failure in page_failures)
            continue

        parity = raw_parity
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

    for asset in sorted(assets):
        source_path = ROOT / asset
        if not source_path.is_file():
            failures.append(f"{asset}: referenced canonical asset missing from source")
            continue
        local = source_path.read_bytes()
        cache_key = verification_cache_key(local, run_cache_key, attempt)
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
    run_cache_key = os.environ.get("GITHUB_RUN_ID") or str(time.time_ns())
    result = {}
    for attempt in range(1, max(args.attempts, 1) + 1):
        result = verify_once(base_url, args.timeout, run_cache_key, attempt)
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
