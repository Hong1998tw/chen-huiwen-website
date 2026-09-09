#!/usr/bin/env python3
"""Prepare the static site for the www.huiwen.tw canonical-host migration.

This script is intentionally deterministic and idempotent. It rewrites only the
public/static SEO surfaces that currently carry the GitHub Pages base URL. It
does not touch Cloudflare, DNS, GitHub Pages settings, Search Console, Drive or
Notion.
"""
from __future__ import annotations

import argparse
from pathlib import Path

OLD_BASE = "https://hong1998tw.github.io/chen-huiwen-website/"
NEW_BASE = "https://www.huiwen.tw/"


def targets(root: Path) -> list[Path]:
    files = sorted(root.glob("*.html"))
    files += sorted((root / "templates").glob("*.html"))
    files += [
        root / "scripts" / "build_cases.py",
        root / "scripts" / "build_events.py",
        root / "scripts" / "validate_seo.py",
        root / "sitemap.xml",
        root / "robots.txt",
    ]
    return [path for path in files if path.exists()]


def rewrite(path: Path, *, apply: bool) -> bool:
    text = path.read_text(encoding="utf-8")
    updated = text.replace(OLD_BASE, NEW_BASE)
    if path.name == "validate_seo.py":
        updated = updated.replace(
            "canonical host is not the GitHub Pages host",
            "canonical host is not the configured canonical host",
        )
    changed = updated != text
    if apply and changed:
        path.write_text(updated, encoding="utf-8")
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--apply", action="store_true", help="write the migration candidate changes")
    parser.add_argument("--check", action="store_true", help="fail if any target still needs rewriting")
    args = parser.parse_args()
    root = args.root.resolve()

    changed: list[str] = []
    for path in targets(root):
        if rewrite(path, apply=args.apply):
            changed.append(str(path.relative_to(root)))

    if args.apply:
        print(f"Rewrote {len(changed)} migration target(s) to {NEW_BASE}")
        for path in changed:
            print(path)
        return 0

    if args.check and changed:
        print("Domain migration candidate is not fully applied:")
        for path in changed:
            print(path)
        return 1

    if args.check:
        print(f"PASS: all migration targets already use {NEW_BASE}")
    else:
        print(f"Would rewrite {len(changed)} migration target(s) to {NEW_BASE}")
        for path in changed:
            print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
