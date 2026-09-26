#!/usr/bin/env python3
"""Apply owner-approved plain-text page edits and mark visual editor targets."""
from __future__ import annotations

import json
import re
from pathlib import Path
import sys

from build_public import public_paths
from page_authority import classify
from page_copy import render

ROOT = Path(__file__).resolve().parents[1]


def build(root=ROOT):
    state_path = root / 'data/page-content.json'
    state = json.loads(state_path.read_text(encoding='utf-8'))
    if set(state) != {'schemaVersion', 'pages'} or state['schemaVersion'] != 1 or not isinstance(state['pages'], dict):
        raise ValueError('PAGE_CONTENT_SCHEMA: expected version 1')
    seen = set()
    routes = set(public_paths(root)) | set(state['pages'])
    for route in sorted(routes):
        if not route.endswith('.html') or route == 'petition.html':
            continue  # The user's fifth audit item remains excluded from this CMS.
        _, kind, _ = classify(route)
        if kind in {'system', 'legacy-redirect', 'excluded-intake'}:
            page = root / route
            if page.is_file():
                source = page.read_text(encoding='utf-8')
                clean = re.sub(r'\sdata-cms-(?:edit-id|source-hash|value-hash)=(?:"[^"]*"|\'[^\']*\')', '', source, flags=re.I)
                clean = re.sub(r'<script\b[^>]*(?:data-cms-editor-loader|src=["\']/cms-page-editor\.js(?:\?[^"\']*)?["\'])[^>]*>.*?</script>\s*', '', clean, flags=re.I | re.S)
                if clean != source:
                    page.write_text(clean, encoding='utf-8')
            continue
        if route not in state['pages'] and route not in public_paths(root):
            continue
        entry = state['pages'].get(route, {})
        if not isinstance(entry, dict) or set(entry) - {'edits', 'status', 'lastmod'}:
            raise ValueError('PAGE_CONTENT_ENTRY: ' + route)
        if entry.get('status', 'published') not in {'published', 'unpublished', 'deleted'}:
            raise ValueError('PAGE_CONTENT_STATUS: ' + route)
        lastmod = entry.get('lastmod')
        if lastmod is not None and (not isinstance(lastmod, str) or len(lastmod) != 10 or lastmod[4:5] != '-' or lastmod[7:8] != '-'):
            raise ValueError('PAGE_CONTENT_LASTMOD: ' + route)
        edits = entry.get('edits', {})
        if not isinstance(edits, dict):
            raise ValueError('PAGE_CONTENT_EDITS: ' + route)
        page = root / route
        if not page.is_file():
            raise ValueError('PAGE_CONTENT_ROUTE: missing source ' + route)
        source = page.read_text(encoding='utf-8')
        result, _ = render(source, route, edits)
        if result != source:
            page.write_text(result, encoding='utf-8')
        seen.add(route)
    missing = {path for path in state['pages'] if path.endswith('.html') and path not in {'petition.html', '404.html', 'offline.html'}} - seen
    if missing:
        raise ValueError('PAGE_CONTENT_ROUTE: ' + ', '.join(sorted(missing)))
    print('Built visual editing targets for public pages; petition workflow remains excluded.')


if __name__ == '__main__':
    try:
        build()
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
