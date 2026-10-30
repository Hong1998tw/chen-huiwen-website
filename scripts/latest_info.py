#!/usr/bin/env python3
"""One derived "latest information" feed from existing canonical sources.

Sources are never copied into a second editable list:
- news.html media reports and press.html releases (static canonical HTML);
- owner-authored editorial pages for the news, press and daily sections;
- data/events.json public events.
Order is reproducible: verified publication/curation date, then a fixed tie
order. data/civic-home.json may pin up to three items; pins only move items
ahead of the same natural order. The build never reads the current time.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

from audit_external_links import forbidden_image_source_host
from build_events import STATUS_LABELS, event_path, public_events
from case_media import classify

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = 'data/latest-info.json'
MAX_PINNED = 3
ITEM_ID = re.compile(r'^[a-z0-9-]{1,120}$')
DAY = re.compile(r'^\d{4}-\d{2}-\d{2}$')
MINUTE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+08:00$')
TYPES = ('news', 'daily', 'activity')
TYPE_LABELS = {'news': '新聞', 'daily': '日常', 'activity': '活動'}
# Same-day ties keep a fixed, documented source order.
SOURCE_RANK = {'event': 0, 'press': 1, 'editorial': 2, 'media': 3}
DEFAULT_SHARE_IMAGE = 'assets/site-share-20260909.png'
EDITORIAL_TYPES = {'news': ('news', '新聞專頁'), 'press': ('news', '新聞專頁'), 'daily': ('daily', '日常')}


class LatestInfoError(ValueError):
    """Fail closed when a source cannot produce an unambiguous public item."""


def _text(node):
    return ' '.join(node.get_text(' ', strip=True).split()) if node is not None else ''


DECORATIVE_ARROW = re.compile(r'[\s→↗›»]+$')


def _title(node):
    """Headline text without decorative (aria-hidden) arrows the source pages add to links."""
    if node is None:
        return ''
    copy = BeautifulSoup(str(node), 'html.parser')
    for hidden in copy.select('[aria-hidden="true"]'):
        hidden.decompose()
    return DECORATIVE_ARROW.sub('', _text(copy))


def external_thumbnail_ok(url):
    """Accept only a direct, public, non-expiring HTTPS image URL."""
    if not isinstance(url, str) or len(url) > 1200:
        return False
    parsed = urlsplit(url)
    if parsed.query or parsed.fragment:
        return False  # signed or expiring URLs (and share pages) need a query string
    if forbidden_image_source_host(url):
        return False
    return classify(url, 'photo') == ('image', url)


def local_asset_ok(root, src):
    path = Path(src)
    return (isinstance(src, str) and not path.is_absolute() and '..' not in path.parts
            and path.as_posix().startswith('assets/') and (Path(root) / path).is_file())


def _thumbnail(src, alt, credit, width, height, root, *, local, fallback=None):
    if not alt or not credit:
        raise LatestInfoError('Thumbnail requires alt text and a credit: ' + str(src))
    try:
        width, height = int(width), int(height)
    except (TypeError, ValueError):
        raise LatestInfoError('Thumbnail requires numeric dimensions: ' + str(src)) from None
    if width < 1 or height < 1:
        raise LatestInfoError('Thumbnail requires positive dimensions: ' + str(src))
    if local and not local_asset_ok(root, src):
        raise LatestInfoError('Local thumbnail must be an existing public asset: ' + str(src))
    if not local and not external_thumbnail_ok(src):
        raise LatestInfoError('External thumbnail must be a direct public image URL: ' + str(src))
    value = {'src': src, 'alt': alt, 'credit': credit, 'width': width, 'height': height, 'local': local}
    if fallback:
        value['fallback'] = fallback
    return value


def _cards(html, *, strip_editorial=True):
    if strip_editorial:
        html = re.sub(r'<!-- editorial-list:start -->.*?<!-- editorial-list:end -->', '', html, flags=re.S)
    main = BeautifulSoup(html, 'html.parser').find('main')
    if main is None:
        raise LatestInfoError('News source page has no main region')
    return main.select('article[data-news-categories]')


def _card_date(card):
    if card.get('data-news-date'):
        value = card['data-news-date']
    else:
        node = card.select_one('.news-card-meta .eyebrow, .card-body > .eyebrow, time[datetime]')
        match = re.search(r'(20\d{2})[./-](\d{2})[./-](\d{2})', _text(node) if node else '')
        value = '-'.join(match.groups()) if match else ''
    if not DAY.fullmatch(value):
        raise LatestInfoError('News card has no verifiable date: ' + _text(card.select_one('h2'))[:60])
    return value


def _card_summary(card):
    for paragraph in card.select('.card-body > p'):
        if paragraph.get('class'):
            continue
        text = _text(paragraph)
        if text:
            return text
    return ''


def _external_links(card):
    return [link for link in card.select('a[href]') if link['href'].startswith('https://')]


def media_items(root):
    items = []
    for index, card in enumerate(_cards((Path(root) / 'news.html').read_text(encoding='utf-8'))):
        if 'news-press-card' in (card.get('class') or []):
            continue
        title = _title(card.select_one('h2'))
        day = _card_date(card)
        links = _external_links(card)
        if not title or not links:
            raise LatestInfoError('Media report needs a title and an original source link')
        first = links[0]
        identifier = card.get('id') or ('media-' + day.replace('-', '') + '-' +
                                        hashlib.sha256(first['href'].encode()).hexdigest()[:8])
        source_name = _text(first).split('｜')[0].strip(' ↗')
        local = None
        image = card.select_one('figure img[src]')
        if image is not None:
            caption = _text(card.select_one('figure figcaption'))
            credit = caption[caption.find('圖／'):].rstrip('。') if '圖／' in caption else '陳慧文服務處提供'
            local = _thumbnail(image['src'], image.get('alt', ''), credit, image.get('width'),
                               image.get('height'), root, local=True)
        thumbnail = None
        if card.get('data-news-thumbnail'):
            thumbnail = _thumbnail(card['data-news-thumbnail'], card.get('data-news-thumbnail-alt', ''),
                                   card.get('data-news-thumbnail-credit', ''),
                                   card.get('data-news-thumbnail-width'), card.get('data-news-thumbnail-height'),
                                   root, local=False, fallback=local)
        elif local is not None:
            thumbnail = local
        items.append({
            'id': identifier, 'type': 'news', 'kind': '媒體報導', 'source': 'media', 'sourceIndex': index,
            'title': title, 'summary': _card_summary(card), 'publishedAt': day,
            'dateLabel': '報導日期', 'eventStart': None, 'eventStatus': None,
            'url': 'news.html#' + card['id'] if card.get('id') else first['href'],
            'sourceUrl': first['href'], 'sourceName': source_name or '原始報導', 'thumbnail': thumbnail,
        })
    return items


def _detail_image(root, href):
    page = Path(root) / href
    if not page.is_file():
        raise LatestInfoError('Press release detail page is missing: ' + href)
    soup = BeautifulSoup(page.read_text(encoding='utf-8'), 'html.parser')
    meta = soup.select_one('meta[property="og:image"]')
    if meta is None:
        return None
    src = meta.get('content', '').removeprefix('https://www.huiwen.tw/')
    if not src or src == DEFAULT_SHARE_IMAGE or '://' in src:
        return None
    main = soup.find('main')
    image = main.select_one(f'img[src="{src}"]') if main else None
    if image is None:
        return None
    caption = image.find_parent('figure')
    caption_text = _text(caption.select_one('figcaption')) if caption else ''
    credit = '照片由陳慧文服務處提供' if '陳慧文服務處提供' in caption_text else '陳慧文服務處'
    return _thumbnail(src, image.get('alt', ''), credit, image.get('width'), image.get('height'), root, local=True)


def press_items(root):
    items = []
    for index, card in enumerate(_cards((Path(root) / 'press.html').read_text(encoding='utf-8'))):
        link = card.select_one('h2 a[href]')
        if link is None or not re.fullmatch(r'news-[a-z0-9-]+\.html', link['href']):
            raise LatestInfoError('Press release card must link to its news detail page')
        href = link['href']
        items.append({
            'id': href.removesuffix('.html'), 'type': 'news', 'kind': '服務處新聞稿', 'source': 'press',
            'sourceIndex': index, 'title': _title(link), 'summary': _card_summary(card),
            'publishedAt': _card_date(card), 'dateLabel': '發稿日期', 'eventStart': None, 'eventStatus': None,
            'url': href, 'sourceUrl': None, 'sourceName': '陳慧文服務處', 'thumbnail': _detail_image(root, href),
        })
    return items


def editorial_items(root):
    data = json.loads((Path(root) / 'data/editorial-pages.json').read_text(encoding='utf-8'))
    managed = json.loads((Path(root) / 'data/page-content.json').read_text(encoding='utf-8')).get('pages', {})
    items = []
    for index, (path, page) in enumerate(sorted(data.get('pages', {}).items())):
        if page.get('section') not in EDITORIAL_TYPES:
            continue
        if managed.get(path, {}).get('status', 'published') != 'published':
            continue
        kind_type, kind = EDITORIAL_TYPES[page['section']]
        if not DAY.fullmatch(page.get('updated', '')):
            raise LatestInfoError('Editorial page needs a curation date: ' + path)
        source = next((block for block in page['blocks'] if block['type'] == 'source' and block['url']), None)
        photo = next((block for block in page['blocks'] if block['type'] == 'photo'
                      and external_thumbnail_ok(block['url'])), None)
        thumbnail = None
        if photo is not None:
            # External images have no recorded intrinsic size; reserve a 4:3 box.
            thumbnail = _thumbnail(photo['url'], photo['alt'], photo['credit'], 1200, 900, root, local=False)
        video = next((block for block in page['blocks'] if block['type'] == 'video'), None)
        items.append({
            'id': path.removesuffix('.html'), 'type': kind_type, 'kind': kind, 'source': 'editorial',
            'sourceIndex': index, 'title': DECORATIVE_ARROW.sub('', page['title']), 'summary': page['summary'],
            'publishedAt': page['updated'], 'dateLabel': '整理日期', 'eventStart': page['eventStart'] or None,
            'eventStatus': None, 'url': path,
            'sourceUrl': source['url'] if source else (video['url'] if video else None),
            'sourceName': source['title'] if source else ('影片來源' if video else '陳慧文服務處'),
            'thumbnail': thumbnail, 'hasVideo': video is not None,
        })
    return items


def event_items(root):
    events = public_events(json.loads((Path(root) / 'data/events.json').read_text(encoding='utf-8')))
    items = []
    for index, event in enumerate(events):
        published = event.get('publishedAt')
        if not isinstance(published, str) or not MINUTE.fullmatch(published):
            raise LatestInfoError('Event needs a recorded website publication time: ' + event['id'])
        thumbnail = None
        if event.get('images'):
            image = event['images'][0]
            thumbnail = _thumbnail(image['src'], image.get('alt', ''), image.get('credit', ''),
                                   image.get('width'), image.get('height'), root, local=True)
        status = event.get('status', 'scheduled')
        items.append({
            'id': 'event-' + event['id'], 'type': 'activity', 'kind': '公開活動', 'source': 'event',
            'sourceIndex': index, 'title': DECORATIVE_ARROW.sub('', event['name']), 'summary': event.get('content') or '',
            'publishedAt': published, 'dateLabel': '活動時間', 'eventStart': event['start'],
            'eventStatus': status, 'eventStatusLabel': STATUS_LABELS[status], 'url': event_path(event),
            'sourceUrl': None, 'sourceName': '陳慧文公開行程', 'thumbnail': thumbnail,
            'location': event.get('location') or '',
        })
    return items


def _descending(value):
    return tuple(-ord(character) for character in value)


def natural_key(item):
    published = item['publishedAt']
    day, time = published[:10], published[11:16]
    return (_descending(day), 0 if time else 1, _descending(time),
            SOURCE_RANK[item['source']], item['sourceIndex'], item['id'])


def collect(root=ROOT):
    items = media_items(root) + press_items(root) + editorial_items(root) + event_items(root)
    seen = set()
    for item in items:
        if not ITEM_ID.fullmatch(item['id']):
            raise LatestInfoError('Latest item id is not a stable slug: ' + item['id'])
        if item['id'] in seen:
            raise LatestInfoError('Duplicate latest item id: ' + item['id'])
        seen.add(item['id'])
    items.sort(key=natural_key)
    for index, item in enumerate(items):
        item['naturalIndex'] = index
    return items


def validate_pins(pins, ids=None):
    if not isinstance(pins, list) or len(pins) > MAX_PINNED:
        raise LatestInfoError(f'Latest pins must be a list of at most {MAX_PINNED} items')
    if any(not isinstance(pin, str) or not ITEM_ID.fullmatch(pin) for pin in pins) or len(set(pins)) != len(pins):
        raise LatestInfoError('Latest pins must be unique item ids')
    if ids is not None:
        missing = [pin for pin in pins if pin not in ids]
        if missing:
            raise LatestInfoError('Pinned latest item no longer exists: ' + ', '.join(missing))
    return pins


def home_pins(root=ROOT):
    config = json.loads((Path(root) / 'data/civic-home.json').read_text(encoding='utf-8'))
    return list(config.get('latestPinned', []))


def order(items, pins):
    pinned = set(pins)
    return ([item for item in items if item['id'] in pinned] +
            [item for item in items if item['id'] not in pinned])


def project(root=ROOT):
    items = collect(root)
    pins = validate_pins(home_pins(root), {item['id'] for item in items})
    ordered = order(items, pins)
    public = []
    for item in ordered:
        row = {key: value for key, value in item.items() if key not in {'source', 'sourceIndex'}}
        row['pinned'] = item['id'] in pins
        public.append(row)
    counts = {kind: sum(1 for item in items if item['type'] == kind) for kind in TYPES}
    return {'schemaVersion': 1, 'maxPinned': MAX_PINNED, 'pinned': pins, 'counts': counts, 'items': public}


def build(root=ROOT):
    value = project(root)
    text = json.dumps(value, ensure_ascii=False, indent=1) + '\n'
    target = Path(root) / OUTPUT
    if not target.exists() or target.read_text(encoding='utf-8') != text:
        target.write_text(text, encoding='utf-8')
    return value


if __name__ == '__main__':
    result = build()
    print('Built latest information feed:', len(result['items']), result['counts'])
