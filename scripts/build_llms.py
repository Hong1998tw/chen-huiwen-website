#!/usr/bin/env python3
"""Write llms.txt from the site profile, election data and the pages' own titles and descriptions."""
from python_guard import require_supported_python
require_supported_python()
from html.parser import HTMLParser
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://www.huiwen.tw/'
OUTPUT = 'llms.txt'
SECTIONS = (
    ('認識陳慧文', ('about.html', 'vision.html')),
    ('服務', ('service.html', 'service-guides.html', 'petition.html')),
    ('建設、問政與新聞', ('achievements.html', 'public-records.html', 'explore.html', 'council-records.html', 'news.html', 'press.html')),
    ('2026 選舉', ('election.html', 'political-donation.html', 'activities.html')),
    ('網站更新', ('updates.html',)),
)


class HeadMetadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title, self.description, self._in_title = '', '', False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'title':
            self._in_title = True
        elif tag == 'meta' and attrs.get('name') == 'description' and not self.description:
            self.description = attrs.get('content') or ''

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def page_summary(root, name):
    head = (root / name).read_text(encoding='utf-8').split('</head>', 1)[0]
    parser = HeadMetadata()
    parser.feed(head)
    if not parser.title.strip() or not parser.description.strip():
        raise ValueError('LLMS_PAGE_METADATA_MISSING: ' + name)
    return parser.title.strip(), parser.description.strip()


def render(root=ROOT):
    root = Path(root)
    profile = json.loads((root / 'data/site-profile.json').read_text(encoding='utf-8'))
    election = json.loads((root / 'data/election-2026.json').read_text(encoding='utf-8'))
    person, identity = profile['person'], profile['identity']
    _, home_description = page_summary(root, 'index.html')
    lines = [
        f'# {person["name"]}官方網站',
        '',
        f'> {home_description}',
        '',
        f'- 身分：{identity["confirmedRole"]}，選區為{person["district"]}；資料截至 {identity["recordAsOf"]}。'
        f'這是資料記錄截止日，投票日或時間經過不代表當選、卸任或續任。',
        f'- 身分來源：{identity["sourceUrl"]}',
        f'- {election["election"]}投票日：{election["voteDate"]}（{election["area"]}）；'
        f'候選人號次抽籤：{election["numberDrawDate"]}。',
        '- 引用時請以各頁標示的資料日期與原始來源為準；政績頁的辦理階段以頁面標示為準。',
    ]
    for heading, pages in SECTIONS:
        lines += ['', f'## {heading}', '']
        for name in pages:
            title, description = page_summary(root, name)
            lines.append(f'- [{title}]({BASE}{name})：{description}')
    lines += ['', '## Optional', '', f'- [網站地圖]({BASE}sitemap.xml)', f'- [網站更新 RSS]({BASE}updates.xml)']
    return '\n'.join(lines) + '\n'


def build(root=ROOT):
    (Path(root) / OUTPUT).write_text(render(root), encoding='utf-8')


if __name__ == '__main__':
    build()
