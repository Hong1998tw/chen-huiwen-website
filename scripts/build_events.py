#!/usr/bin/env python3
"""Build public schedules and activities without credentials or personal-data collection."""
from pathlib import Path
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo
from html import escape
from urllib.parse import urlencode, urlsplit
import json, re
ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo('Asia/Taipei')
BASE = 'https://www.huiwen.tw/activities.html'
CALENDAR_COPY_NOTICE = '儲存的是當下副本，不會自動更新；出發前請回本站確認。'
STATUS_LABELS = {'scheduled': '已公布行程', 'rescheduled': '時間已更改', 'cancelled': '活動已取消'}
def parse_time(value):
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        raise ValueError('Event times must include a UTC offset')
    return dt

def validate(event):
    for key in ('id', 'name', 'start', 'content', 'registration'):
        if not isinstance(event.get(key), str) or not event[key].strip():
            raise ValueError(f'Missing event field: {key}')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', event['id']):
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
            u = urlsplit(event[field])
            if u.scheme != 'https' or not u.hostname or u.username or u.password:
                raise ValueError(f'{field} must be public HTTPS')
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

def calendar_url(event):
    validate(event)
    if event.get('status') == 'cancelled':
        raise ValueError('Cancelled events cannot be added to a calendar')
    if not event.get('end'):
        raise ValueError('A calendar range requires a confirmed event end')
    dates = '/'.join(parse_time(event[k]).astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ') for k in ('start', 'end'))
    return 'https://calendar.google.com/calendar/render?' + urlencode({
        'action': 'TEMPLATE', 'text': event['name'], 'dates': dates,
        'ctz': 'Asia/Taipei', 'details': event['content'] + '\n\n' + CALENDAR_COPY_NOTICE + '\n' + BASE + '#event-' + event['id'],
        'location': event.get('location', '')})

def render_events(events):
    if not isinstance(events, list):
        raise ValueError('events must be an array')
    seen = set()
    for event in events:
        validate(event)
        if event['id'] in seen:
            raise ValueError('Duplicate event id')
        seen.add(event['id'])
    body = '<section class="page-head"><div class="wrap"><p class="eyebrow">EVENTS</p><h1>公開行程與活動</h1><p>活動時間、內容與報名資訊，都在這裡。</p></div></section><section class="wrap event-announcements" aria-label="活動資訊">'
    if not events:
        return body + '<div class="event-empty"><p>新的公開行程與活動將於本頁發布。</p></div></section>'
    for event in sorted(events, key=lambda x: parse_time(x['start'])):
        e = lambda x: escape(str(x), quote=True)
        status = event.get('status', 'scheduled')
        start = parse_time(event['start']).astimezone(TAIPEI)
        end = parse_time(event['end']).astimezone(TAIPEI) if event.get('end') else None
        body += f'<article class="event-card" id="event-{e(event["id"])}" data-event-status="{status}"><p class="event-status">{STATUS_LABELS[status]}</p><h2>{e(event["name"])}</h2>'
        if status in ('rescheduled', 'cancelled'):
            body += f'<p class="event-change-note"><strong>{e(event["changeNote"])}</strong></p>'
        if status == 'rescheduled':
            previous = event['previousSchedule']
            old_start = parse_time(previous['start']).astimezone(TAIPEI)
            old_end = parse_time(previous['end']).astimezone(TAIPEI) if previous.get('end') else None
            old_range = f' — <time datetime="{e(previous["end"])}">{old_end:%Y/%m/%d %H:%M}</time>' if old_end else ' 開始'
            body += f'<p class="source-note">原定時間：<time datetime="{e(previous["start"])}">{old_start:%Y/%m/%d %H:%M}</time>{old_range}，請以新時間為準。</p>'
        time_label = '原定活動時間（已取消）' if status == 'cancelled' else '活動時間（台灣時間）'
        start_label = f'{start:%Y/%m/%d %H:%M}' if end else f'{start:%Y/%m/%d}（{"一二三四五六日"[start.weekday()]}）{start:%H:%M}'
        time_range = f'<time datetime="{e(event["start"])}">{start_label}</time>'
        time_range += f' — <time datetime="{e(event["end"])}">{end:%Y/%m/%d %H:%M}</time>' if end else ' 開始'
        body += f'<dl><dt>{time_label}</dt><dd>{time_range}</dd>'
        if event.get('location'):
            body += f'<dt>活動地點</dt><dd>{e(event["location"])}</dd>'
        body += '</dl><h3>活動內容</h3>'
        body += ''.join(f'<p>{e(p)}</p>' for p in event['content'].split('\n') if p.strip())
        if event.get('images'):
            body += '<div class="event-posters" aria-label="活動圖卡">'
            for image in event['images']:
                body += f'<figure><a href="{e(image["src"])}" target="_blank" rel="noopener noreferrer" aria-label="開啟完整{e(image["caption"])}"><img src="{e(image["src"])}" width="{image["width"]}" height="{image["height"]}" alt="{e(image["alt"])}" loading="lazy" decoding="async"></a><figcaption>{e(image["caption"])} · {e(image["credit"])}</figcaption><a class="text-link" href="{e(image["src"])}" download>下載{e(image["caption"])}</a></figure>'
            body += '</div>'
        body += '<h3>報名資訊</h3>'
        body += '<p>本活動已取消，請勿依原行程前往。</p>' if status == 'cancelled' else f'<p>{e(event["registration"])}</p>'
        body += '<div class="actions">'
        if event.get('registrationUrl') and status != 'cancelled':
            body += f'<a class="button button-green" href="{e(event["registrationUrl"])}" target="_blank" rel="noopener noreferrer">前往報名（外部網站） ↗</a>'
        if event.get('sourceUrl'):
            body += f'<a class="button button-outline" href="{e(event["sourceUrl"])}" target="_blank" rel="noopener noreferrer">官方資訊 ↗</a>'
        if status != 'cancelled' and end:
            body += f'<a class="button button-outline" href="{e(calendar_url(event))}" target="_blank" rel="noopener noreferrer">加入 Google 日曆 ↗</a>'
        body += '</div>'
        if event.get('updatedAt'):
            body += f'<p class="source-note">行程資料更新：<time datetime="{e(event["updatedAt"])}">{e(event["updatedAt"])}</time></p>'
        notice = '如已儲存舊行事曆副本，請自行刪除或更正。' if status == 'cancelled' else CALENDAR_COPY_NOTICE if end else '目前公布開始時間；結束時間尚未公布。'
        body += f'<p class="source-note">{notice} 活動異動以主辦單位最新公告為準；出發前請再確認本頁資訊。</p></article>'
    return body + '</section>'

def main():
    events = json.loads((ROOT / 'data/events.json').read_text())['events']
    template = (ROOT / 'templates/events-page.html').read_text()
    assert template.count('{{EVENTS}}') == 1
    (ROOT / 'activities.html').write_text(template.replace('{{EVENTS}}', render_events(events)))
    print(f'Built activities.html from {len(events)} public schedules and activities')
if __name__ == '__main__':
    main()
