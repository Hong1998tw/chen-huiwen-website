#!/usr/bin/env python3
"""Build a compact search index from public HTML; never index internal data or docs."""
from python_guard import require_supported_python
require_supported_python()

import json
from pathlib import Path
from urllib.parse import urlsplit
from bs4 import BeautifulSoup
from achievement_metadata import is_public, latest_history_event
from page_copy import render as render_page_copy

ROOT = Path(__file__).resolve().parents[1]
INACTIVE = {'unpublished', 'deleted'}


def route_key(url):
    """Normalize a same-site search URL to the source HTML route it targets."""
    if not isinstance(url, str):
        return ''
    parsed = urlsplit(url)
    if parsed.scheme or parsed.netloc:
        return ''
    path = parsed.path.lstrip('/')
    if not path:
        return 'index.html'
    if path.endswith('/'):
        return path + 'index.html'
    return path


def build(root=ROOT):
    state = json.loads((root / 'data/page-content.json').read_text(encoding='utf-8'))
    page_states = state.get('pages', {})
    items = []
    searchable_routes = set()
    records = {
        row['id']: row
        for row in json.loads((root / 'data/achievements.json').read_text(encoding='utf-8'))
        if is_public(row)
    }
    paths = sorted(root.glob('*.html')) + sorted(p for p in root.glob('*/index.html') if not p.parent.name.startswith(('_','.')))
    for path in paths:
        rel = path.relative_to(root).as_posix()
        entry_state = page_states.get(rel, {})
        if isinstance(entry_state, dict) and entry_state.get('status', 'published') in INACTIVE:
            continue
        source = path.read_text(encoding='utf-8')
        edits = entry_state.get('edits', {}) if isinstance(entry_state, dict) else {}
        if edits:
            source, _ = render_page_copy(source, rel, edits)
        soup = BeautifulSoup(source, 'html.parser')
        robots = soup.find('meta', attrs={'name': 'robots'})
        if robots and 'noindex' in robots.get('content', ''):
            continue
        main = soup.find('main')
        if not main:
            continue
        url = path.parent.name + '/' if rel.endswith('/index.html') else path.name
        searchable_routes.add(route_key(url))
        h1 = main.find('h1')
        title = h1.get_text(' ', strip=True) if h1 else (soup.title.get_text(' ', strip=True) if soup.title else '')
        meta = soup.find('meta', attrs={'name': 'description'})
        description = meta.get('content', '') if meta else ''
        seo = entry_state.get('seo') if isinstance(entry_state, dict) else None
        if isinstance(seo, dict) and isinstance(seo.get('description'), str):
            description = seo['description']
        for element in main.select('script, style, noscript, nav, .eyebrow, .civic-kicker, .case-subtags, .map-controls, .map-source, .case-sources, .source-links, .cross-content-explore, .case-print-sheet, .print-toolbar'):
            element.decompose()
        # Collections with separate detail pages index their intro.
        # Media reports only live on news.html; retain their text so search can find them.
        if path.name in ('achievements.html', 'press.html', 'activities.html'):
            for element in main.select('article, #case-list'):
                element.decompose()
        kind = '政績' if path.name.startswith('achievement-') else '新聞' if path.name.startswith('news-') else '活動' if path.name.startswith(('activity-', 'event-')) else '政見' if path.name == 'vision.html' else '頁面'
        keywords = ' '.join(main.stripped_strings)
        item = dict(title=title, url=url, description=description, summary=description, type=kind, keywords=keywords,
                    priority=80 if kind == '政績' else 60 if kind in {'新聞', '活動'} else 40)
        if path.name.startswith('achievement-'):
            record_id = path.stem.removeprefix('achievement-')
            record = records.get(record_id)
            if record:
                latest = latest_history_event(record.get('history', []))
                item.update(
                    summary=record.get('summary') or description,
                    primaryRegion='、'.join(record.get('villages', [])) or record.get('scope') or '',
                    recordStage=record.get('status') or '',
                    lastRecordDate=(latest.get('date') if latest and latest.get('date') else ''),
                    categories=record.get('categories', []),
                )
        items.append(item)
    for service in json.loads((root / 'data/service-search.json').read_text(encoding='utf-8')):
        if route_key(service.get('url')) not in searchable_routes:
            continue
        items.append({**service, 'summary':service.get('description',''), 'primaryRegion':'鳳山區', 'lastRecordDate':'', 'recordStage':''})
    result = {'version': 1, 'count': len(items), 'items': items}
    (root / 'data/search-index.json').write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':'))+'\n')
    print(f'Built search index: {len(items)} public pages')
    return result


if __name__ == '__main__':
    build()
