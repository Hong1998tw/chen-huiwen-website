"""One explicit source-owner catalogue for every reviewed public HTML route."""
from __future__ import annotations

import json
from html.parser import HTMLParser
from pathlib import Path

from build_public import LEGACY_PAGES, public_paths

ROOT = Path(__file__).resolve().parents[1]

DATA_PAGES = {
    'achievements.html': ('data/achievements.json', 'generated', 'none'),
    'activities.html': ('data/events.json', 'generated', 'partial'),
    'election.html': ('data/election-2026.json', 'composite', 'partial'),
    'explore.html': ('data/achievements.json', 'generated', 'none'),
    'index.html': ('data/civic-home.json', 'composite', 'none'),
    'about.html': ('data/site-profile.json', 'composite', 'none'),
    'service.html': ('data/legal-schedule.json', 'composite', 'partial'),
    'service-guides.html': ('data/service-guides.json', 'generated', 'partial'),
    'service-print.html': ('data/legal-schedule.json', 'generated', 'partial'),
    'updates.html': ('data/content-updates.json', 'generated', 'none'),
    'vision.html': ('data/platforms.json', 'generated', 'none'),
}
SYSTEM_PAGES = {'404.html', 'offline.html'}
EXCLUDED_AUTHORING = {'petition.html'}
STATIC_ROOT_PAGES = {
    'activity-market.html', 'activity-mooncake.html', 'council-records.html',
    'gallery.html', 'history-kumamoto-relief.html', 'history-meilidao.html',
    'news.html', 'political-donation.html', 'press.html', 'terms.html',
}


class Title(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_title = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'title':
            self.in_title = True

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.parts.append(data)


def classify(path):
    from build_events import EVENT_PATH
    if EVENT_PATH.fullmatch(path):
        return ('data/events.json', 'generated', 'partial')
    if path in DATA_PAGES:
        return DATA_PAGES[path]
    if path in SYSTEM_PAGES:
        return (path, 'system', 'none')
    if path in EXCLUDED_AUTHORING:
        return (path, 'excluded-intake', 'none')
    if path.startswith('achievement-') and path.endswith('.html'):
        return ('data/achievements.json', 'generated', 'none')
    if path.startswith('page-') and path.endswith('.html'):
        from editorial_pages import PATH
        if PATH.fullmatch(path):
            return ('data/editorial-pages.json', 'generated', 'partial')
    if path.startswith('news-') and path.endswith('.html'):
        return (path, 'static', 'none')
    if path == 'renwu-anju-social-housing/index.html':
        return (path, 'static', 'none')
    if path in LEGACY_PAGES:
        return (path, 'legacy-redirect', 'none')
    if path in STATIC_ROOT_PAGES:
        return (path, 'static', 'none')
    if '/' in path and path.endswith('.html'):
        return (path, 'static', 'partial')
    raise ValueError('Unclassified public page: ' + path)


def catalog(root=ROOT):
    rows = []
    managed = json.loads((root / 'data/page-content.json').read_text(encoding='utf-8')).get('pages', {})
    routes = set(public_paths(root)) | set(managed)
    for path in sorted(routes):
        if not path.endswith('.html'):
            continue
        source, kind, editor_scope = classify(path)
        if not (root / source).is_file():
            raise ValueError('Missing page authority: ' + source)
        parser = Title()
        parser.feed((root / path).read_text(encoding='utf-8-sig'))
        title = ' '.join(''.join(parser.parts).split())
        if not title or len(title) > 250:
            raise ValueError('Missing or oversized page title: ' + path)
        if kind not in {'system', 'legacy-redirect', 'excluded-intake'}:
            editor_scope = 'partial'
        rows.append({'path': path, 'title': title, 'source': source,
                     'kind': kind, 'editorScope': editor_scope,
                     'publicationStatus': managed.get(path, {}).get('status', 'published')})
    return sorted(rows, key=lambda row: row['path'])
