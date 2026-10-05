#!/usr/bin/env python3
"""Build public schedules and activities without credentials or personal-data collection."""
from python_guard import require_supported_python
require_supported_python()
from pathlib import Path
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo
from html import escape
from urllib.parse import urlencode, urlsplit
import ipaddress
import json, re
ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo('Asia/Taipei')
SITE = 'https://www.huiwen.tw/'
BASE = SITE + 'activities.html'
EVENT_ID = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')
EVENT_PATH = re.compile(r'event-[a-z0-9]+(?:-[a-z0-9]+)*\.html')
BRAND_IMAGE = {'src': 'assets/site-share-20260909.png', 'width': 1200, 'height': 630,
               'alt': '陳慧文官網品牌分享圖，非本活動照片'}
CALENDAR_COPY_NOTICE = '加入日曆後，儲存的行程副本不會自動更新；出發前請回本站確認。'
STATUS_LABELS = {'scheduled': '已公布行程', 'rescheduled': '時間已更改', 'cancelled': '活動已取消'}
def parse_time(value):
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        raise ValueError('Event times must include a UTC offset')
    return dt

def validate_public_url(value):
    if not isinstance(value, str):
        raise ValueError('Public event links must be HTTPS')
    u = urlsplit(value)
    host = (u.hostname or '').lower().rstrip('.')
    blocked = ('notion.so', 'notion.site', 'notion.com', 'drive.google.com', 'docs.google.com', 'localhost')
    if u.scheme != 'https' or not host or u.username or u.password or '.' not in host or any(host == item or host.endswith('.' + item) for item in blocked) or host.endswith(('.local', '.internal', '.localhost')):
        raise ValueError('Public event links must use public HTTPS sources')
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError('Public event links cannot use private addresses')


def council_source(event):
    host = urlsplit(event.get('sourceUrl', '')).hostname or ''
    return host == 'kcc.gov.tw' or host.endswith('.kcc.gov.tw')


def validate(event):
    if not isinstance(event, dict):
        raise ValueError('Event must be an object')
    if event.get('location') is not None and not isinstance(event['location'], str):
        raise ValueError('Event location must be public text')
    for key in ('id', 'name', 'start', 'content', 'registration'):
        if not isinstance(event.get(key), str) or not event[key].strip():
            raise ValueError(f'Missing event field: {key}')
    if not EVENT_ID.fullmatch(event['id']):
        raise ValueError('Event id must be a lowercase URL slug')
    start = parse_time(event['start'])
    if event.get('end') is not None and (not isinstance(event['end'], str) or not event['end'].strip()):
        raise ValueError('Unknown event end must be null or omitted')
    if event.get('end') is not None and parse_time(event['end']) <= start:
        raise ValueError('Event end must follow start')
    status = event.get('status', 'scheduled')
    if status not in STATUS_LABELS:
        raise ValueError('Event status must be scheduled, rescheduled or cancelled')
    for field in ('verifiedAt', 'updatedAt', 'reviewDueAt'):
        if event.get(field):
            date.fromisoformat(event[field])
    if status in ('rescheduled', 'cancelled'):
        if not event.get('updatedAt') or not event.get('changeNote') or not event.get('sourceUrl'):
            raise ValueError('Changed events require updatedAt, changeNote and a public source')
    if status == 'rescheduled':
        previous = event.get('previousSchedule')
        if not isinstance(previous, dict) or not previous.get('start'):
            raise ValueError('Rescheduled events require the previous start')
        previous_start = parse_time(previous['start'])
        if previous.get('end') is not None and parse_time(previous['end']) <= previous_start:
            raise ValueError('Previous end must follow previous start')
        if all(previous.get(key) == event.get(key) for key in ('start', 'end')):
            raise ValueError('A rescheduled event must change its time')
    for field in ('registrationUrl', 'sourceUrl'):
        if event.get(field):
            validate_public_url(event[field])
    images = event.get('images', [])
    if not isinstance(images, list) or len(images) > 4:
        raise ValueError('Event images must be an array with at most four images')
    for image in images:
        if not isinstance(image, dict) or set(image) != {'src', 'width', 'height', 'alt', 'caption', 'credit'}:
            raise ValueError('Event image metadata is incomplete')
        if not isinstance(image['src'], str) or not re.fullmatch(r'assets/events/[a-z0-9-]+\.(?:png|jpg|jpeg|webp)', image['src']):
            raise ValueError('Event images must use reviewed local media')
        if any(type(image[key]) is not int or image[key] < 1 or image[key] > 10000 for key in ('width', 'height')):
            raise ValueError('Event image dimensions are invalid')
        if any(not isinstance(image[key], str) or not image[key].strip() for key in ('alt', 'caption', 'credit')):
            raise ValueError('Event image text is required')

def event_path(event):
    """The id is immutable; a changed start never changes the share URL."""
    if not isinstance(event.get('id'), str) or not EVENT_ID.fullmatch(event['id']):
        raise ValueError('Event id must be a lowercase URL slug')
    return 'event-' + event['id'] + '.html'


def public_events(data):
    if not isinstance(data, dict) or data.get('schemaVersion') != 2 or not isinstance(data.get('events'), list):
        raise ValueError('Event data must use schemaVersion 2')
    validate_events(data['events'])
    return data['events']


def validate_events(events):
    if not isinstance(events, list):
        raise ValueError('events must be an array')
    seen = set()
    for event in events:
        validate(event)
        if event['id'] in seen:
            raise ValueError('Duplicate event id')
        seen.add(event['id'])


def e(value):
    return escape(str(value), quote=True)


def calendar_url(event):
    validate(event)
    if event.get('status') == 'cancelled':
        raise ValueError('Cancelled events cannot be added to a calendar')
    if not event.get('end'):
        raise ValueError('A calendar range requires a confirmed event end')
    dates = '/'.join(parse_time(event[k]).astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ') for k in ('start', 'end'))
    return 'https://calendar.google.com/calendar/r/eventedit?' + urlencode({
        'action': 'TEMPLATE', 'text': event['name'], 'dates': dates,
        'stz': 'Asia/Taipei', 'etz': 'Asia/Taipei',
        'details': event['content'] + '\n\n' + CALENDAR_COPY_NOTICE + '\n' + SITE + event_path(event),
        'location': (event.get('location') or '')})


def maps_url(event):
    location = event.get('location')
    if not isinstance(location, str) or not location.strip():
        return None
    return 'https://www.google.com/maps/search/?' + urlencode({'api': '1', 'query': location})


def time_text(event):
    start = parse_time(event['start']).astimezone(TAIPEI)
    end = parse_time(event['end']).astimezone(TAIPEI) if event.get('end') else None
    text = f'{start:%Y/%m/%d}（{"一二三四五六日"[start.weekday()]}）{start:%H:%M}'
    if end:
        text += '–' + (f'{end:%H:%M}' if end.date() == start.date() else f'{end:%Y/%m/%d %H:%M}')
    else:
        text += ' 開始（結束時間尚未公布）'
    return text


def render_time(event):
    start = parse_time(event['start']).astimezone(TAIPEI)
    end = parse_time(event['end']).astimezone(TAIPEI) if event.get('end') else None
    start_label = f'{start:%Y/%m/%d}（{"一二三四五六日"[start.weekday()]}）{start:%H:%M}'
    text = f'<time datetime="{e(event["start"])}">{start_label}</time>'
    if end:
        label = f'{end:%H:%M}' if end.date() == start.date() else f'{end:%Y/%m/%d %H:%M}'
        return text + f'–<time datetime="{e(event["end"])}">{label}</time>'
    return text + ' 開始<span class="event-end-note">結束時間尚未公布</span>'


def render_change(event):
    status = event.get('status', 'scheduled')
    if status == 'scheduled':
        return ''
    text = f'<p class="event-change-note"><strong>{e(event["changeNote"])}</strong></p>'
    if status == 'rescheduled':
        text += '<p class="source-note">原定時間：' + e(time_text(event['previousSchedule'])) + '，請以新時間為準。</p>'
    return text


def render_calendar(event):
    if event.get('status') == 'cancelled':
        return ''
    if event.get('end'):
        return f'<a class="button button-outline event-calendar-link" href="{e(calendar_url(event))}" target="_blank" rel="noopener noreferrer">加入 Google 日曆 ↗</a>'
    field_id = 'reminder-duration-' + event['id']
    data = {'name': event['name'], 'start': event['start'], 'content': event['content'],
            'location': (event.get('location') or ''), 'url': SITE + event_path(event)}
    return (
        f'<details class="event-reminder" data-event-reminder="{e(json.dumps(data, ensure_ascii=False))}">'
        '<summary class="button button-outline">加入 Google 日曆（開始提醒）</summary>'
        '<div class="event-reminder-body">'
        '<p>活動結束時間尚未公布。請自行選擇日曆提醒的長度；這個長度不代表活動時長。</p>'
        f'<label for="{e(field_id)}">個人提醒長度</label>'
        f'<select id="{e(field_id)}" class="event-reminder-duration" aria-describedby="{e(field_id)}-notice">'
        '<option value="">請選擇提醒長度</option><option value="15">15 分鐘</option>'
        '<option value="30">30 分鐘</option><option value="60">60 分鐘</option></select>'
        f'<p class="source-note" id="{e(field_id)}-notice">{e(CALENDAR_COPY_NOTICE)}</p>'
        '<p class="event-reminder-status" role="status" aria-live="polite"></p>'
        '<a class="button button-green event-reminder-link" target="_blank" rel="noopener noreferrer" hidden>開啟 Google 日曆，儲存開始提醒 ↗</a>'
        '<noscript><p>請啟用 JavaScript 後選擇提醒長度；也可依本頁開始時間自行建立提醒，並由官方資訊確認活動異動。</p></noscript>'
        '</div></details>')


def render_actions(event, *, detail=False):
    status = event.get('status', 'scheduled')
    text = '<div class="actions event-actions">'
    if not detail:
        text += f'<a class="button button-green event-detail-link" href="{e(event_path(event))}">活動詳情與分享 →</a>'
    if event.get('registrationUrl') and status != 'cancelled':
        text += f'<a class="button button-outline" href="{e(event["registrationUrl"])}" target="_blank" rel="noopener noreferrer">前往報名（外部網站） ↗</a>'
    text += render_calendar(event)
    if maps_url(event) and status != 'cancelled':
        text += f'<a class="button button-outline event-map-link" href="{e(maps_url(event))}" target="_blank" rel="noopener noreferrer">Google 地圖 ↗</a>'
    if event.get('sourceUrl'):
        text += f'<a class="button button-outline" href="{e(event["sourceUrl"])}" target="_blank" rel="noopener noreferrer">{"高雄市議會｜查看官方行程" if council_source(event) else "官方資訊"} ↗</a>'
    return text + '</div>'


def render_facts(event):
    label = '原定活動時間（已取消）' if event.get('status') == 'cancelled' else '活動時間（台灣時間）'
    location = e(event['location']) if event.get('location') else ('活動地點請見議會公告。' if council_source(event) else '活動地點請見官方公告。')
    return f'<dl class="event-facts"><dt>{label}</dt><dd>{render_time(event)}</dd><dt>活動地點</dt><dd>{location}</dd></dl>'


def render_notice(event):
    text = ''
    if event.get('updatedAt'):
        text += f'<p class="source-note">行程資料更新：<time datetime="{e(event["updatedAt"])}">{e(event["updatedAt"])}</time></p>'
    notice = '本活動已取消，請勿依原行程前往。如已儲存舊行事曆副本，請自行刪除或更正。' if event.get('status') == 'cancelled' else CALENDAR_COPY_NOTICE
    return text + f'<p class="source-note">{e(notice)} 活動異動以機關或主辦單位最新公告為準。</p>'


def render_events(events):
    validate_events(events)
    body = '<section class="page-head"><div class="wrap"><p class="eyebrow">EVENTS</p><h1>公開行程與活動</h1><p>查看接下來的公開行程、活動詳情、日曆與交通資訊。</p></div></section><section class="wrap event-announcements" aria-label="活動時間軸">'
    if not events:
        return body + '<div class="event-empty"><p>新的公開行程與活動將於本頁發布。</p></div></section>'
    body += '<ol class="event-timeline">'
    for event in sorted(events, key=lambda item: (parse_time(item['start']), item['id'])):
        status = event.get('status', 'scheduled')
        start = parse_time(event['start']).astimezone(TAIPEI)
        body += f'<li class="event-timeline-item"><div class="event-date-rail" aria-hidden="true"><span>{start:%Y}</span><strong>{start:%m.%d}</strong><span>星期{"一二三四五六日"[start.weekday()]}</span></div><article class="event-card" id="event-{e(event["id"])}" data-event-status="{status}"><p class="event-status">{STATUS_LABELS[status]}</p><h2><a href="{e(event_path(event))}">{e(event["name"])}</a></h2>'
        body += render_change(event) + render_facts(event)
        summary = ' '.join(event['content'].split())
        body += f'<p class="event-summary">{e(summary[:180] + ("…" if len(summary) > 180 else ""))}</p>'
        body += render_actions(event) + render_notice(event) + '</article></li>'
    return body + '</ol></section>'


def render_detail(event):
    validate(event)
    status = event.get('status', 'scheduled')
    body = '<div class="wrap event-detail-wrap"><nav class="event-breadcrumb" aria-label="所在位置"><a href="./">首頁</a><span aria-hidden="true"> / </span><a href="activities.html">公開行程與活動</a></nav>'
    body += f'<article class="event-detail" id="event-{e(event["id"])}" data-event-status="{status}"><header><p class="event-status">{STATUS_LABELS[status]}</p><h1>{e(event["name"])}</h1></header>'
    body += render_change(event) + render_facts(event) + render_actions(event, detail=True)
    body += '<section class="event-detail-section"><h2>活動內容</h2>'
    body += ''.join(f'<p>{e(p)}</p>' for p in event['content'].split('\n') if p.strip())
    body += '</section>'
    if event.get('images'):
        body += '<section class="event-detail-section"><h2>活動圖卡</h2><div class="event-posters">'
        for image in event['images']:
            body += f'<figure><a href="{e(image["src"])}" target="_blank" rel="noopener noreferrer" aria-label="開啟完整{e(image["caption"])}"><img src="{e(image["src"])}" width="{image["width"]}" height="{image["height"]}" alt="{e(image["alt"])}" loading="lazy" decoding="async"></a><figcaption>{e(image["caption"])} · {e(image["credit"])}</figcaption><a class="text-link" href="{e(image["src"])}" download>下載{e(image["caption"])}</a></figure>'
        body += '</div></section>'
    body += '<section class="event-detail-section"><h2>報名與洽詢</h2>'
    body += '<p>本活動已取消，請勿依原行程前往。</p>' if status == 'cancelled' else f'<p>{e(event["registration"])}</p>'
    body += '</section>' + render_notice(event)
    body += f'<p><a class="text-link event-back-link" href="activities.html#event-{e(event["id"])}">← 回到活動時間軸</a></p></article></div>'
    return body


def structured_event(event):
    validate(event)
    status = event.get('status', 'scheduled')
    data = {'@context': 'https://schema.org', '@type': 'Event', '@id': SITE + event_path(event) + '#event',
            'name': event['name'], 'description': event['content'], 'url': SITE + event_path(event),
            'startDate': event['start'],
            'eventStatus': 'https://schema.org/' + {'scheduled': 'EventScheduled', 'rescheduled': 'EventRescheduled', 'cancelled': 'EventCancelled'}[status]}
    if event.get('end'):
        data['endDate'] = event['end']
    if event.get('location'):
        data['location'] = {'@type': 'Place', 'name': event['location'], 'address': event['location']}
    if event.get('images'):
        data['image'] = [SITE + image['src'] for image in event['images']]
    if status == 'rescheduled':
        data['previousStartDate'] = event['previousSchedule']['start']
    return data


def render_page(template, events, event=None):
    validate_events(events)
    if event:
        path = event_path(event)
        title = event['name'] + '｜' + parse_time(event['start']).astimezone(TAIPEI).strftime('%Y/%m/%d') + '｜陳慧文公開行程'
        description = (STATUS_LABELS[event.get('status', 'scheduled')] + '：' + event['name'] + '。' + time_text(event) + '，' + (event.get('location') or '地點以機關或主辦單位公告為準') + '。' + ' '.join(event['content'].split()))[:280]
        image = event['images'][0] if event.get('images') else BRAND_IMAGE
        body = render_detail(event)
        structured = [{'@context': 'https://schema.org', '@type': 'WebPage', '@id': SITE + path + '#page', 'url': SITE + path, 'name': title, 'description': description, 'inLanguage': 'zh-Hant-TW', 'mainEntity': {'@id': SITE + path + '#event'}}, structured_event(event)]
    else:
        path = 'activities.html'
        title = '陳慧文公開行程與活動｜鳳山活動時間軸'
        description = '陳慧文公開行程與鳳山活動時間軸；查看各場活動的日期、時間、地點、活動詳情，以及 Google 日曆與地圖連結。'
        image = BRAND_IMAGE
        body = render_events(events)
        structured = [{'@context': 'https://schema.org', '@type': 'CollectionPage', '@id': BASE + '#collection', 'url': BASE, 'name': title, 'description': description, 'inLanguage': 'zh-Hant-TW', 'mainEntity': {'@type': 'ItemList', 'itemListElement': [{'@type': 'ListItem', 'position': n + 1, 'url': SITE + event_path(item), 'name': item['name']} for n, item in enumerate(sorted(events, key=lambda item: (parse_time(item['start']), item['id'])))]}}]
    crumbs = [{'@type': 'ListItem', 'position': 1, 'name': '首頁', 'item': SITE}, {'@type': 'ListItem', 'position': 2, 'name': '公開行程與活動', 'item': BASE}]
    if event:
        crumbs.append({'@type': 'ListItem', 'position': 3, 'name': event['name'], 'item': SITE + path})
    structured.append({'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': crumbs})
    values = {'TITLE': e(title), 'DESCRIPTION': e(description), 'CANONICAL': e(SITE + path),
              'IMAGE': e(SITE + image['src']), 'IMAGE_ALT': e(image['alt']),
              'IMAGE_WIDTH': str(image['width']), 'IMAGE_HEIGHT': str(image['height']),
              'JSON_LD': json.dumps(structured, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c'), 'EVENTS': body}
    for key, value in values.items():
        template = template.replace('{{' + key + '}}', value)
    if re.search(r'\{\{[A-Z_]+\}\}', template):
        raise ValueError('Unresolved event template field')
    return template


def generated_projection(source):
    """Extract source-owned main/SEO fields; shared chrome/assets are owned elsewhere."""
    patterns = [r'<main\b[^>]*>.*?</main>', r'<title>.*?</title>',
                r'<link rel="canonical"[^>]*>',
                r'<meta (?:name|property)="(?:description|og:[^"]+|twitter:[^"]+)"[^>]*>',
                r'<script type="application/ld\+json">.*?</script>']
    result = tuple(tuple(re.findall(pattern, source, re.S)) for pattern in patterns)
    if len(result[0]) != 1 or len(result[1]) != 1 or len(result[2]) != 1 or len(result[4]) != 1:
        raise ValueError('Event source projection is incomplete')
    return result


def build(root=ROOT):
    events = public_events(json.loads((root / 'data/events.json').read_text()))
    template = (root / 'templates/events-page.html').read_text()
    (root / 'activities.html').write_text(render_page(template, events))
    for event in events:
        (root / event_path(event)).write_text(render_page(template, events, event))
    # Removal is an editorial decision: do not silently unlink published share URLs.
    expected = {event_path(event) for event in events}
    stale = {path.name for path in root.glob('event-*.html') if EVENT_PATH.fullmatch(path.name)} - expected
    if stale:
        raise ValueError('Event share pages require retained source records (use cancelled status): ' + ', '.join(sorted(stale)))
    print(f'Built activity timeline and {len(events)} stable event pages')


def main():
    build()


if __name__ == '__main__':
    main()
