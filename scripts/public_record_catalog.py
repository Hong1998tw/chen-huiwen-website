"""Derive the formal-site catalogue from the two existing public content owners.

Full narratives remain in achievements.json. Historic short copy remains in the
curated public record file; this module never turns its display flags into an
administrative status or its dates into publication/completion dates.
"""
from pathlib import Path
from urllib.parse import urlsplit
import copy
import html
import json
import re

from achievement_metadata import is_public

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = 'data/public-record-catalog.json'
COLLECTION_PATH = 'public-records.html'
SHORT_ID = re.compile(r'in-[a-f0-9]{10,12}\Z')
KIND_CATEGORIES = {
    'road': '交通與基建', 'bridge': '交通與基建', 'station': '交通與基建',
    'park': '環境與綠地', 'water': '環境與綠地',
    'school': '教育與文化', 'culture': '教育與文化',
    'care': '社福與衛環', 'market': '經濟與產業', 'office': '地方服務',
}
EXTRA_FIELDS = {'recordFormat', 'recordType', 'url', 'sourceUrl'}
E = lambda value: html.escape(str(value), quote=True)


def short_url(record_id):
    if not SHORT_ID.fullmatch(record_id):
        raise ValueError('Invalid public short-record identity')
    return COLLECTION_PATH + '#record-' + record_id


def public_source_url(value):
    if not value:
        return ''
    parsed = urlsplit(value)
    host = (parsed.hostname or '').lower()
    if (parsed.scheme != 'https' or not host or parsed.username or parsed.password
            or host in {'drive.google.com', 'docs.google.com', 'claude.ai'}
            or host.endswith(('.notion.so', '.notion.com', '.notion.site'))
            or host in {'notion.so', 'notion.com', 'notion.site'}):
        raise ValueError('Short-record source must be an existing public HTTPS URL')
    return value


def read_short_records(root=ROOT):
    root = Path(root)
    cases = [row for row in json.loads((root / 'data/achievements.json').read_text()) if is_public(row)]
    case_ids = {row['id'] for row in cases}
    island = json.loads((root / 'island/island-data.json').read_text())
    rows = island['items']
    if len({row['id'] for row in rows}) != len(rows):
        raise ValueError('Duplicate public record identity')
    mapped = [row.get('canonicalId') for row in rows if row.get('canonicalId')]
    # Formal narratives do not require an island representation. Only explicit
    # island mappings must be unique and refer to an existing canonical case.
    if len(mapped) != len(set(mapped)) or set(mapped) - case_ids:
        raise ValueError('Island full-record mapping is duplicate or has no canonical owner')
    short = []
    for row in rows:
        if row.get('canonicalId'):
            continue
        short_url(row['id'])
        if row.get('o') != 0 or row['id'] in case_ids:
            raise ValueError('Unresolved full/short public record identity')
        if not all(isinstance(row.get(key), str) for key in ('t', 's', 'k', 'layer')):
            raise ValueError('Invalid public short-record text')
        if not row['t'].strip() or row['k'] not in KIND_CATEGORIES:
            raise ValueError('Missing short-record title or reviewed category')
        if (not isinstance(row.get('h'), list)
                or any(not isinstance(event, list) or len(event) != 2
                       or not all(isinstance(value, str) for value in event) for event in row['h'])):
            raise ValueError('Invalid public short-record history')
        if not isinstance(row.get('v'), list) or not all(isinstance(v, str) for v in row['v']):
            raise ValueError('Invalid public short-record place labels')
        public_source_url(row.get('sourceUrl', ''))
        short.append(copy.deepcopy(row))
    return short


def short_cards(root=ROOT):
    """An explicit read-only display projection, not a full narrative schema."""
    root = Path(root)
    village_rows = json.loads((root / 'data/villages.json').read_text())
    villages = {}
    for village in village_rows:
        villages.setdefault(village['name'], []).append(village)
    cards = []
    for row in read_short_records(root):
        exact = [name for name in row['v'] if len(villages.get(name, [])) == 1]
        # The island's all/layout flags are display state, not scope evidence.
        scope = '範圍未列明'
        unmatched = [name for name in row['v'] if name not in exact]
        record_type = row.get('record_type') or ('會勘紀錄' if row['layer'] == '會勘' else '短紀錄')
        history = [{'date': event[0], 'title': event[1], 'text': ''} for event in row['h']]
        cards.append({
            'id': row['id'], 'title': row['t'], 'summary': row['s'],
            'categories': [KIND_CATEGORIES[row['k']]], 'subcategories': [],
            'villages': exact, 'scope': scope, 'status': '未列進度',
            'coordinates': None, 'locationName': '、'.join(row['v']),
            'locationNote': ('原紀錄里名：' + '、'.join(unmatched)) if unmatched else '',
            'history': history, 'updated': '', 'lastRecordDate': '',
            'searchText': ' '.join([row['t'], row['s'], *row['v'], record_type,
                                    *[value for event in row['h'] for value in event]]),
            'years': sorted({event[0][:4] for event in row['h'] if re.fullmatch(r'\d{4}(?:-\d{2}){0,2}', event[0])}),
            'recordFormat': 'short', 'recordType': record_type, 'url': short_url(row['id']),
            'sourceUrl': public_source_url(row.get('sourceUrl', '')),
        })
    return cards


def derive_catalog(full_map, root=ROOT):
    full = []
    for row in full_map:
        projected = copy.deepcopy(row)
        projected.update(recordFormat='full', recordType='完整專題', url='achievement-' + row['id'] + '.html')
        full.append(projected)
    result = full + short_cards(root)
    if len({row['id'] for row in result}) != len(result):
        raise ValueError('Formal catalogue identity collision')
    return result


def validate_catalog(root=ROOT):
    """Exact derivation validation keeps private fields and stale content out."""
    root = Path(root)
    full_map = json.loads((root / 'data/achievement-map.json').read_text())
    expected = derive_catalog(full_map, root)
    observed = json.loads((root / CATALOG_PATH).read_text())
    if observed != expected:
        raise ValueError('Formal public catalogue is stale or outside its public projection')
    return observed


def render_short_collection(root=ROOT):
    """Render every original public title/summary/history value, including blanks."""
    articles = []
    for row in read_short_records(root):
        record_type = row.get('record_type') or ('會勘紀錄' if row['layer'] == '會勘' else '短紀錄')
        summary = '<p class="public-record-summary">' + E(row['s']) + '</p>' if row['s'] else ''
        place = '<p class="public-record-place">原紀錄地點標示：' + E('、'.join(row['v'])) + '</p>' if row['v'] else ''
        events = ''.join('<li><span class="public-record-date">' + E(event[0]) + '</span>'
                         + ('<p>' + E(event[1]) + '</p>' if event[1] else '') + '</li>' for event in row['h'])
        history = '<h3>原紀錄所列日期與記事</h3><ol class="public-record-history">' + events + '</ol>' if events else ''
        source_url = public_source_url(row.get('sourceUrl', ''))
        source = '<p><a href="' + E(source_url) + '" target="_blank" rel="noopener noreferrer">查看資料來源 ↗</a></p>' if source_url else ''
        sparse = '<p class="public-record-note">目前公開內容僅列項目名稱。</p>' if not row['s'] and not events else ''
        articles.append('<article class="public-record" id="record-' + E(row['id']) + '" data-record-id="' + E(row['id'])
                        + '"><p class="eyebrow">' + E(record_type) + '</p><h2 tabindex="-1">' + E(row['t'])
                        + '</h2>' + place + summary + history + sparse + source
                        + '<p class="public-record-links"><a href="' + short_url(row['id']) + '">此筆紀錄連結 →</a>'
                        + ' <a href="achievements.html?case=' + E(row['id']) + '#case-results">回正式政績列表 →</a></p></article>')
    return ('<div class="wrap breadcrumb"><a href="./">首頁</a><span>/</span><a href="achievements.html">建設與進度</a>'
            + '<span>/</span><span>公開工作紀錄</span></div><section class="page-head"><div class="wrap">'
            + '<p class="eyebrow">建設與服務紀錄</p><h1>公開工作紀錄</h1>'
            + '<p>查閱各項已收錄的短紀錄、原標示日期與記事。所列日期保留原紀錄，不代表完工日期；未列進度的項目不另推定辦理狀態。</p>'
            + '</div></section><section class="wrap public-records-wrap" aria-label="公開短紀錄">'
            + '<p class="public-record-total">共 ' + str(len(articles)) + ' 筆短紀錄</p>'
            + '<div id="public-record-list" class="public-records">' + ''.join(articles) + '</div></section>')
