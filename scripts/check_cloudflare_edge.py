#!/usr/bin/env python3
"""Read-only Cloudflare edge cache audit for huiwen.tw."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from dataclasses import asdict, dataclass
from verify_cloudflare_delivery import verify as verify_delivery

UA = "huiwen-edge-audit/1.0"

@dataclass
class Check:
    url: str
    status: int
    location: str | None
    server: str | None
    cache_control: str | None
    cf_cache_status: str | None
    age: str | None

def fetch(url: str) -> Check:
    proc = subprocess.run(
        ["curl", "--silent", "--show-error", "--max-time", "20",
         "--user-agent", UA, "--dump-header", "-", "--output", "/dev/null", url],
        check=True, capture_output=True, text=True,
    )
    blocks = [b for b in proc.stdout.replace("\r\n", "\n").split("\n\n") if b.strip()]
    block = blocks[-1]
    lines = block.splitlines()
    status = int(lines[0].split()[1])
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return Check(
        url=url, status=status, location=headers.get("location"),
        server=headers.get("server"), cache_control=headers.get("cache-control"),
        cf_cache_status=headers.get("cf-cache-status"), age=headers.get("age"),
    )

def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--expect-html-cache", action="store_true",
                      help="Verify legacy CDN HTML caching and query bypass")
    mode.add_argument("--expect-static-assets", action="store_true",
                      help="Verify current Static Assets caching and exact release receipt")
    parser.add_argument("--expected-sha")
    parser.add_argument("--artifact", type=Path, default=Path("_site/publication-manifest.json"))
    args = parser.parse_args()
    if args.expect_static_assets and not args.expected_sha:
        parser.error("--expect-static-assets requires --expected-sha")
    urls = [
        "https://huiwen.tw/",
        "https://www.huiwen.tw/",
        "https://www.huiwen.tw/styles.css",
        "https://www.huiwen.tw/?production-verification=edge-audit",
    ]
    checks = [fetch(url) for url in urls]
    print(json.dumps([asdict(item) for item in checks], ensure_ascii=False, indent=2))
    if not (args.expect_html_cache or args.expect_static_assets):
        return 0
    html = checks[1]
    bypass = checks[3]
    good = {"HIT", "REVALIDATED", "UPDATING", "STALE"}
    # A cold or expired entry can legitimately refill after the first read.
    # Retry only the same successful public HTML URL, once.
    if html.status == 200 and html.cf_cache_status in {"MISS", "EXPIRED"}:
        first_status = html.cf_cache_status
        html = fetch(urls[1])
        print(f"HTML cache warm-up: {first_status} -> {html.cf_cache_status}")
    if html.status != 200:
        print(f"Expected public HTML HTTP 200, got {html.status}")
        return 2
    if html.cf_cache_status not in good:
        print(f"Expected cached public HTML after warm-up, got {html.cf_cache_status!r}")
        return 2
    if bypass.status != 200:
        print(f"Expected production-verification HTTP 200, got {bypass.status}")
        return 3
    if args.expect_static_assets:
        # Static Assets has its own cache. A query HIT cannot prove or disprove
        # CDN bypass; bind this mode to the existing provider/SHA/artifact gate.
        try:
            digest = hashlib.sha256(args.artifact.read_bytes()).hexdigest()
            receipt = verify_delivery(args.expected_sha, digest, urls[1], attempts=1, delay=0)
        except (OSError, ValueError):
            print("Static Assets verification requires a valid source SHA and built artifact")
            return 4
        print(json.dumps(receipt, ensure_ascii=False))
        return 0 if receipt['status'] == 'PASS' else 4
    if bypass.cf_cache_status in good:
        print(f"Production-verification query must bypass public HTML cache, got {bypass.cf_cache_status!r}")
        return 3
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
