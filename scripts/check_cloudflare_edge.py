#!/usr/bin/env python3
"""Read-only Cloudflare edge cache audit for huiwen.tw."""
from __future__ import annotations
import argparse
import json
import subprocess
from dataclasses import asdict, dataclass

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
    parser.add_argument("--expect-html-cache", action="store_true")
    args = parser.parse_args()
    urls = [
        "https://huiwen.tw/",
        "https://www.huiwen.tw/",
        "https://www.huiwen.tw/styles.css",
        "https://www.huiwen.tw/?production-verification=edge-audit",
    ]
    checks = [fetch(url) for url in urls]
    print(json.dumps([asdict(item) for item in checks], ensure_ascii=False, indent=2))
    if not args.expect_html_cache:
        return 0
    html = checks[1]
    bypass = checks[3]
    good = {"HIT", "REVALIDATED", "UPDATING", "STALE"}
    if html.cf_cache_status not in good:
        print(f"Expected cached public HTML, got {html.cf_cache_status!r}")
        return 2
    if bypass.cf_cache_status in good:
        print(f"Production-verification query must bypass public HTML cache, got {bypass.cf_cache_status!r}")
        return 3
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
