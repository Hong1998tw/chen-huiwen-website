#!/usr/bin/env python3
"""Build public website additions and RSS; never infer a new real-world event."""
from __future__ import annotations

from datetime import date, datetime
from email.utils import format_datetime
import hashlib
from html import escape
import json
from pathlib import Path
import re
from urllib.parse import unquote, urljoin, urlsplit
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://www.huiwen.tw/'
PAGE = 'updates.html'
FEED = 'updates.xml'
TITLE = '最近更新｜服務指南與議題導讀'
DESCRIPTION = '查看陳慧文官網新增的服務指南、議題導讀與資料整理。網站補充日期與原事件日期分開呈現，方便找到新補充的閱讀內容。'
KINDS = {'service-guide': '服務指南', 'reading-guide': '議題導讀', 'record-organization': '資料整理'}
e = lambda value: escape(str(value), quote=True)


def public_url(value):
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ValueError('A titled public link is required')
    url = urlsplit(urljoin(BASE, value))
    if url.scheme != 'https' or not url.hostname or url.username or url.password or '\\' in value:
        raise ValueError('Updates links must be public HTTPS URLs')
    if '..' in unquote(url.path).split('/'):
        raise ValueError('Updates link contains path traversal')
    if url.hostname == 'www.huiwen.tw' and url.path.startswith(('/docs/', '/scripts/', '/tests/', '/private/', '/.')):
        raise ValueError('Updates must link to public reading pages')
    return url.geturl()


def website_time(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}', value):
        raise ValueError('Website addition time must include seconds and an explicit UTC offset')
    parsed = datetime.fromisoformat(value)
    if parsed.utcoffset() is None:
        raise ValueError('Website addition time must include a timezone')
    return parsed


def validate(data):
    if set(data) != {'schemaVersion', 'dateSemantics', 'updates'}:
        raise ValueError('Content updates allow only explicit public fields')
    if data.get('schemaVersion') != 1 or not isinstance(data.get('updates'), list):
        raise ValueError('Unsupported content updates schema')
    if not isinstance(data.get('dateSemantics'), str) or not data['dateSemantics'].strip():
        raise ValueError('Date meanings must be explained publicly')
    seen = set()
    for item in data['updates']:
        if not isinstance(item, dict) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', item.get('id', '')):
            raise ValueError('Each update needs a stable URL ID')
        if item['id'] in seen:
            raise ValueError('Duplicate update ID')
        if set(item) != {'id', 'kind', 'websiteUpdatedAt', 'eventDate', 'title', 'summary', 'pageUrl', 'sources'}:
            raise ValueError('Each update must use the explicit public schema')
        seen.add(item['id'])
        if item.get('kind') not in KINDS:
            raise ValueError('Unknown public update kind')
        website_time(item.get('websiteUpdatedAt'))
        for field in ('title', 'summary'):
            if not isinstance(item.get(field), str) or not item[field].strip():
                raise ValueError('Update title and summary are required')
        if 'eventDate' not in item:
            raise ValueError('Explicit eventDate is required; use null for a website-only addition')
        if item['eventDate'] is not None:
            if not isinstance(item['eventDate'], str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', item['eventDate']):
                raise ValueError('Event date must preserve a confirmed full date, or be null')
            date.fromisoformat(item['eventDate'])
        public_url(item.get('pageUrl'))
        if not isinstance(item.get('sources'), list) or not item['sources']:
            raise ValueError('Each update needs its original reading links')
        for source in item['sources']:
            if not isinstance(source, dict) or set(source) != {'title', 'url'}:
                raise ValueError('Sources allow only a public title and URL')
            if not isinstance(source.get('title'), str) or not source['title'].strip():
                raise ValueError('A source title is required')
            public_url(source.get('url'))
    return data


def ordered_updates(data):
    validate(data)
    return sorted(data['updates'], key=lambda item: (website_time(item['websiteUpdatedAt']), item['id']), reverse=True)


def event_label(item):
    return item['eventDate'] or '不適用（本次為網站內容補充）'


def render_item(item):
    website_date = website_time(item['websiteUpdatedAt']).date().isoformat()
    event = f'<time datetime="{e(item["eventDate"])}">{e(item["eventDate"])}</time>' if item['eventDate'] else e(event_label(item))
    links = ''.join(f'<li><a class="text-link" href="{e(source["url"])}">{e(source["title"])} →</a></li>' for source in item['sources'])
    return f'''<article class="event-card content-update" id="update-{e(item['id'])}"><p class="civic-kicker">{KINDS[item['kind']]}</p><h2><a href="{e(item['pageUrl'])}">{e(item['title'])}</a></h2><dl class="update-dates"><div><dt>網站補充日期</dt><dd><time datetime="{e(item['websiteUpdatedAt'])}">{website_date}</time></dd></div><div><dt>事件日期</dt><dd>{event}</dd></div></dl><p>{e(item['summary'])}</p><nav aria-label="{e(item['title'])}：閱讀內容與來源"><ul>{links}</ul></nav></article>'''


def render_page_body(data):
    items = ordered_updates(data)
    body = f'''<section class="page-head"><div class="wrap"><p class="eyebrow">網站內容更新</p><h1>最近更新</h1><p>找到新補充的服務指南、議題導讀與資料整理。</p><p class="source-note">{e(data['dateSemantics'])}</p><a class="text-link" href="{FEED}" type="application/rss+xml">訂閱網站更新 RSS ↗</a></div></section><section class="wrap event-announcements updates-list" aria-label="網站補充紀錄">'''
    return body + (''.join(render_item(item) for item in items) or '<p>目前沒有新增的網站補充紀錄。</p>') + '</section>'


def render_rss(data):
    items = ordered_updates(data)
    atom = 'http://www.w3.org/2005/Atom'
    ET.register_namespace('atom', atom)
    rss = ET.Element('rss', {'version': '2.0'})
    channel = ET.SubElement(rss, 'channel')
    for tag, text in [('title', '陳慧文官網｜網站內容更新'), ('link', BASE + PAGE), ('description', data['dateSemantics']), ('language', 'zh-TW')]:
        ET.SubElement(channel, tag).text = text
    ET.SubElement(channel, '{' + atom + '}link', {'href': BASE + FEED, 'rel': 'self', 'type': 'application/rss+xml'})
    if items:
        ET.SubElement(channel, 'lastBuildDate').text = format_datetime(website_time(items[0]['websiteUpdatedAt']))
    for item in items:
        entry = ET.SubElement(channel, 'item')
        permalink = BASE + PAGE + '#update-' + item['id']
        ET.SubElement(entry, 'title').text = item['title']
        ET.SubElement(entry, 'link').text = permalink
        ET.SubElement(entry, 'guid', {'isPermaLink': 'true'}).text = permalink
        # RSS publication means the website addition, never the historical event.
        ET.SubElement(entry, 'pubDate').text = format_datetime(website_time(item['websiteUpdatedAt']))
        links = ''.join(f'<li><a href="{e(public_url(source["url"]))}">{e(source["title"])}</a></li>' for source in item['sources'])
        ET.SubElement(entry, 'description').text = (f'<p>網站補充日期：{e(item["websiteUpdatedAt"])}</p><p>事件日期：{e(event_label(item))}</p><p>{e(item["summary"])}</p><p>訂閱日期是網站補充時間，不代表工程或政策有新的進展。</p><ul>{links}</ul>')
        ET.SubElement(entry, 'category').text = KINDS[item['kind']]
    ET.indent(rss, space='  ')
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(rss, encoding='unicode') + '\n'


def build(root=ROOT):
    data = validate(json.loads((root / 'data/content-updates.json').read_text()))
    template = (root / 'templates/case-page.html').read_text()
    structured = {'@context': 'https://schema.org', '@type': 'CollectionPage', '@id': BASE + PAGE + '#updates', 'url': BASE + PAGE, 'name': TITLE, 'description': DESCRIPTION, 'inLanguage': 'zh-Hant-TW'}
    items = ordered_updates(data)
    if items:
        structured['dateModified'] = items[0]['websiteUpdatedAt']
    head = f'<link rel="alternate" type="application/rss+xml" title="陳慧文官網｜網站內容更新" href="{FEED}">\n<script type="application/ld+json">' + json.dumps(structured, ensure_ascii=False).replace('<', '\\u003c') + '</script>'
    version = lambda name: hashlib.sha256((root / name).read_bytes()).hexdigest()[:12]
    replacements = {'TITLE': e(TITLE), 'DESCRIPTION': e(DESCRIPTION), 'FILE': PAGE,
                    'OG_TYPE': 'website', 'OG_IMAGE': 'assets/site-share-20260909.png',
                    'OG_ALT': '陳慧文・高雄市議員・鳳山區', 'HEAD': head,
                    'BODY': render_page_body(data), 'STYLE_VERSION': version('styles.css'),
                    'DIGITAL_STYLE_VERSION': version('digital.css'), 'DIGITAL_SCRIPT_VERSION': version('digital.js')}
    for key, value in replacements.items():
        template = template.replace('{{' + key + '}}', value)
    if re.search(r'\{\{[A-Z_]+\}\}', template):
        raise ValueError('Unresolved updates page template token')
    (root / PAGE).write_text(template)
    (root / FEED).write_text(render_rss(data))
    print(f'Built website updates: {len(items)} editorial additions; RSS dates use website addition time')


if __name__ == '__main__':
    build()
