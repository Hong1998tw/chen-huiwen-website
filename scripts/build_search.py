#!/usr/bin/env python3
"""Build a compact search index from public HTML; never index internal data or docs."""
import json
from pathlib import Path
from bs4 import BeautifulSoup
R = Path(__file__).resolve().parents[1]
items = []
for path in sorted(R.glob('*.html')):
    soup = BeautifulSoup(path.read_text(), 'html.parser')
    robots = soup.find('meta', attrs={'name': 'robots'})
    if robots and 'noindex' in robots.get('content', ''):
        continue
    search_control = soup.find('meta', attrs={'name': 'site-search'})
    if search_control and search_control.get('content', '').strip().lower() == 'exclude':
        continue
    main = soup.find('main')
    if not main:
        continue
    h1 = main.find('h1')
    title = h1.get_text(' ', strip=True) if h1 else soup.title.get_text(' ', strip=True)
    meta = soup.find('meta', attrs={'name': 'description'})
    description = meta.get('content', '') if meta else ''
    for element in main.select('script, style, noscript, nav, .map-controls, .map-source, .case-sources, .source-links, .cross-content-explore'):
        element.decompose()
    # Collection pages index their intro, not duplicate copies of every detail.
    if path.name in ('achievements.html', 'news.html'):
        for element in main.select('article, #case-list'):
            element.decompose()
    kind = '政績' if path.name.startswith('achievement-') else '新聞' if path.name.startswith('news-') else '活動' if path.name.startswith('activity-') else '政見' if path.name == 'vision.html' else '頁面'
    keywords = ' '.join(main.stripped_strings)
    items.append(dict(title=title, url=path.name, description=description, type=kind, keywords=keywords, priority=80 if kind == '政績' else 60 if kind == '新聞' else 40))
result = {'version': 1, 'count': len(items), 'items': items}
(R/'data/search-index.json').write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':'))+'\n')
print(f'Built search index: {len(items)} public pages')
