#!/usr/bin/env python3
"""Build a compact search index from public HTML; never index internal data or docs."""
from python_guard import require_supported_python
require_supported_python()
import json
from pathlib import Path
from bs4 import BeautifulSoup
from achievement_metadata import is_public, latest_history_event
R = Path(__file__).resolve().parents[1]
items = []
records = {
    row['id']: row
    for row in json.loads((R/'data/achievements.json').read_text())
    if is_public(row)
}
paths = sorted(R.glob('*.html')) + sorted(p for p in R.glob('*/index.html') if not p.parent.name.startswith(('_','.')) )
for path in paths:
    soup = BeautifulSoup(path.read_text(), 'html.parser')
    robots = soup.find('meta', attrs={'name': 'robots'})
    if robots and 'noindex' in robots.get('content', ''):
        continue
    main = soup.find('main')
    if not main:
        continue
    h1 = main.find('h1')
    title = h1.get_text(' ', strip=True) if h1 else soup.title.get_text(' ', strip=True)
    meta = soup.find('meta', attrs={'name': 'description'})
    description = meta.get('content', '') if meta else ''
    for element in main.select('script, style, noscript, nav, .eyebrow, .civic-kicker, .case-subtags, .map-controls, .map-source, .case-sources, .source-links, .cross-content-explore, .case-print-sheet, .print-toolbar'):
        element.decompose()
    # Collections with separate detail pages index their intro.
    # Media reports only live on news.html; retain their text so search can find them.
    if path.name in ('achievements.html', 'press.html', 'activities.html'):
        for element in main.select('article, #case-list'):
            element.decompose()
    rel = path.relative_to(R).as_posix()
    url = path.parent.name + '/' if rel.endswith('/index.html') else path.name
    kind = '政績' if path.name.startswith('achievement-') else '新聞' if path.name.startswith('news-') else '活動' if path.name.startswith(('activity-', 'event-')) else '政見' if path.name == 'vision.html' else '頁面'
    keywords = ' '.join(main.stripped_strings)
    entry = dict(title=title, url=url, description=description, summary=description, type=kind, keywords=keywords, priority=80 if kind == '政績' else 60 if kind in {'新聞', '活動'} else 40)
    if path.name.startswith('achievement-'):
        record_id = path.stem.removeprefix('achievement-')
        record = records.get(record_id)
        if record:
            latest = latest_history_event(record.get('history', []))
            entry.update(
                summary=record.get('summary') or description,
                primaryRegion='、'.join(record.get('villages', [])) or record.get('scope') or '',
                recordStage=record.get('status') or '',
                lastRecordDate=(latest.get('date') if latest and latest.get('date') else ''),
                categories=record.get('categories', []),
            )
    items.append(entry)
for service in json.loads((R/'data/service-search.json').read_text()):
    items.append({**service, 'summary':service.get('description',''), 'primaryRegion':'鳳山區', 'lastRecordDate':'', 'recordStage':''})
result = {'version': 1, 'count': len(items), 'items': items}
(R/'data/search-index.json').write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':'))+'\n')
print(f'Built search index: {len(items)} public pages')
