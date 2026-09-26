#!/usr/bin/env python3
"""Verify every HTML file in the reviewed Pages artifact against the live site."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from html.parser import HTMLParser
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

import build_public
import verify_production as live

ROOT = Path(__file__).resolve().parents[1]
REDIRECT = re.compile(r'<meta\s+http-equiv="refresh"\s+content="0; url=(https://www\.huiwen\.tw/[^\"]+)"', re.I)


class Headline(HTMLParser):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'h1' and not self.parts:
            self.depth = 1
        elif self.depth:
            self.depth += 1

    def handle_endtag(self, tag):
        if self.depth:
            self.depth -= 1

    def handle_data(self, value):
        if self.depth:
            self.parts.append(value)


def heading(html):
    parser = Headline()
    parser.feed(html)
    return live.normalize_space(' '.join(parser.parts))


def pages(root=ROOT):
    """Use exactly the same allowlist as the public artifact builder."""
    return sorted(path for path in build_public.public_paths(root) if path.endswith('.html'))


def public_url_path(path):
    if path == 'index.html':
        return '/'
    if path.endswith('/index.html'):
        return '/' + path.removesuffix('index.html')
    return '/' + path


def verify_page(path, root=ROOT, base_url=live.DEFAULT_BASE_URL, fetcher=live.fetch, *, timeout=20, attempt=1):
    local = (root / path).read_bytes()
    source = local.decode('utf-8-sig')
    cache_key = live.verification_cache_key(local, str(time.time_ns()), attempt)
    try:
        status, final_url, remote = fetcher(base_url, public_url_path(path), cache_key, timeout)
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        return {'path': path, 'status': 'Failed', 'reason': type(error).__name__}
    if status != 200 or urlsplit(final_url).hostname != urlsplit(base_url).hostname:
        return {'path': path, 'status': 'Failed', 'reason': 'HTTP status or final host differs'}
    live_text = remote.decode('utf-8-sig', errors='replace')
    source_page, remote_page = live.PageParser(), live.PageParser()
    source_page.feed(source)
    remote_page.feed(live_text)
    problems = []
    if remote_page.lang != source_page.lang or remote_page.title != source_page.title:
        problems.append('language/title')
    if remote_page.canonical != source_page.canonical or remote_page.description != source_page.description:
        problems.append('canonical/description')
    if heading(source) != heading(live_text):
        problems.append('main heading')
    alias = REDIRECT.search(source)
    if alias:
        if not REDIRECT.search(live_text) or REDIRECT.search(live_text).group(1) != alias.group(1):
            problems.append('legacy redirect target')
    else:
        if live.visible_text_coverage(source_page, remote_page) < live.MIN_TEXT_COVERAGE:
            problems.append('visible text')
        if live.critical_differences(source, live_text):
            problems.append('critical facts')
    return {'path': path, 'status': 'Failed' if problems else 'Passed',
            'reason': ', '.join(problems) if problems else '',
            'sourceSha256': live.digest(local), 'liveSha256': live.digest(remote)}


def verify_all(root=ROOT, base_url=live.DEFAULT_BASE_URL, fetcher=live.fetch, *, timeout=20, attempts=3, workers=6):
    roster = pages(root)
    results = {}
    remaining = roster
    for attempt in range(1, attempts + 1):
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(verify_page, path, root, base_url, fetcher,
                                   timeout=timeout, attempt=attempt): path for path in remaining}
            for future in as_completed(futures):
                results[futures[future]] = future.result()
        remaining = [path for path in roster if results[path]['status'] != 'Passed']
        if not remaining:
            break
        if attempt < attempts:
            time.sleep(3)
    checks = [results[path] for path in roster]
    return {'status': 'Passed' if not remaining else 'Failed',
            'scope': 'all-reviewed-html-artifact-paths', 'checked': len(roster),
            'passed': len(roster) - len(remaining),
            'failed': remaining, 'checks': checks}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default=live.DEFAULT_BASE_URL)
    parser.add_argument('--report')
    parser.add_argument('--timeout', type=int, default=20)
    parser.add_argument('--attempts', type=int, default=3)
    args = parser.parse_args()
    result = verify_all(base_url=args.base_url, timeout=args.timeout, attempts=args.attempts)
    output = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.report:
        dest = Path(args.report)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(output, encoding='utf-8')
    print(json.dumps({key: result[key] for key in ('status', 'scope', 'checked', 'passed', 'failed')}, ensure_ascii=False))
    return 0 if result['status'] == 'Passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
