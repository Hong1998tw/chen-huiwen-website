#!/usr/bin/env python3
"""Build a compact search index from public HTML; never index internal data or docs."""
import json
from pathlib import Path
from bs4 import BeautifulSoup
R = Path(__file__).resolve().parents[1]
from build_civic import build as build_civic
build_civic()
items = []
paths = sorted(R.glob('*.html')) + sorted(R.glob('*/index.html'))
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
    for element in main.select('script, style, noscript, nav, .eyebrow, .civic-kicker, .case-subtags, .map-controls, .map-source, .case-sources, .source-links, .cross-content-explore'):
        element.decompose()
    # Collections with separate detail pages index their intro.
    # Media reports only live on news.html; retain their text so search can find them.
    if path.name in ('achievements.html', 'press.html'):
        for element in main.select('article, #case-list'):
            element.decompose()
    rel = path.relative_to(R).as_posix()
    url = path.parent.name + '/' if rel.endswith('/index.html') else path.name
    kind = '政績' if path.name.startswith('achievement-') else '新聞' if path.name.startswith('news-') else '活動' if path.name.startswith('activity-') else '政見' if path.name == 'vision.html' else '頁面'
    keywords = ' '.join(main.stripped_strings)
    items.append(dict(title=title, url=url, description=description, type=kind, keywords=keywords, priority=80 if kind == '政績' else 60 if kind == '新聞' else 40))
items.extend(json.loads((R/'data/service-search.json').read_text()))
result = {'version': 1, 'count': len(items), 'items': items}
(R/'data/search-index.json').write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':'))+'\n')
print(f'Built search index: {len(items)} public pages')
