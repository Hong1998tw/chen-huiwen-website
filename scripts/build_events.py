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
    for key in ('id', 'name', 'start', 'end', 'content', 'registration'):
        if not isinstance(event.get(key), str) or not event[key].strip():
            raise ValueError(f'Missing event field: {key}')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', event['id']):
        raise ValueError('Event id must be a lowercase URL slug')
    if parse_time(event['end']) <= parse_time(event['start']):
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
        if not isinstance(previous, dict) or not previous.get('start') or not previous.get('end'):
            raise ValueError('Rescheduled events require the previous start and end')
        if parse_time(previous['end']) <= parse_time(previous['start']):
            raise ValueError('Previous end must follow previous start')
        if all(previous[key] == event[key] for key in ('start', 'end')):
            raise ValueError('A rescheduled event must change its time')
    for field in ('registrationUrl', 'sourceUrl'):
        if event.get(field):
            u = urlsplit(event[field])
            if u.scheme != 'https' or not u.hostname or u.username or u.password:
                raise ValueError(f'{field} must be public HTTPS')

def calendar_url(event):
    validate(event)
    if event.get('status') == 'cancelled':
        raise ValueError('Cancelled events cannot be added to a calendar')
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
        start, end = (parse_time(event[k]).astimezone(TAIPEI) for k in ('start','end'))
        body += f'<article class="event-card" id="event-{e(event["id"])}" data-event-status="{status}"><p class="event-status">{STATUS_LABELS[status]}</p><h2>{e(event["name"])}</h2>'
        if status in ('rescheduled', 'cancelled'):
            body += f'<p class="event-change-note"><strong>{e(event["changeNote"])}</strong></p>'
        if status == 'rescheduled':
            previous = event['previousSchedule']
            old_start, old_end = (parse_time(previous[k]).astimezone(TAIPEI) for k in ('start','end'))
            body += f'<p class="source-note">原定時間：<time datetime="{e(previous["start"])}">{old_start:%Y/%m/%d %H:%M}</time> — <time datetime="{e(previous["end"])}">{old_end:%Y/%m/%d %H:%M}</time>，請以新時間為準。</p>'
        time_label = '原定活動時間（已取消）' if status == 'cancelled' else '活動時間（台灣時間）'
        body += f'<dl><dt>{time_label}</dt><dd><time datetime="{e(event["start"])}">{start:%Y/%m/%d %H:%M}</time> — <time datetime="{e(event["end"])}">{end:%Y/%m/%d %H:%M}</time></dd>'
        if event.get('location'):
            body += f'<dt>活動地點</dt><dd>{e(event["location"])}</dd>'
        body += '</dl><h3>活動內容</h3>'
        body += ''.join(f'<p>{e(p)}</p>' for p in event['content'].split('\n') if p.strip())
        body += '<h3>報名資訊</h3>'
        body += '<p>本活動已取消，請勿依原行程前往。</p>' if status == 'cancelled' else f'<p>{e(event["registration"])}</p>'
        body += '<div class="actions">'
        if event.get('registrationUrl') and status != 'cancelled':
            body += f'<a class="button button-green" href="{e(event["registrationUrl"])}" target="_blank" rel="noopener noreferrer">前往報名（外部網站） ↗</a>'
        if event.get('sourceUrl'):
            body += f'<a class="button button-outline" href="{e(event["sourceUrl"])}" target="_blank" rel="noopener noreferrer">官方資訊 ↗</a>'
        if status != 'cancelled':
            body += f'<a class="button button-outline" href="{e(calendar_url(event))}" target="_blank" rel="noopener noreferrer">加入 Google 日曆 ↗</a>'
        body += '</div>'
        if event.get('updatedAt'):
            body += f'<p class="source-note">行程資料更新：<time datetime="{e(event["updatedAt"])}">{e(event["updatedAt"])}</time></p>'
        notice = '如已儲存舊行事曆副本，請自行刪除或更正。' if status == 'cancelled' else CALENDAR_COPY_NOTICE
        body += f'<p class="source-note">{notice} 活動異動以主辦單位最新公告為準；無法開啟行事曆時，仍可依本頁時間與官方資訊核對。</p></article>'
    return body + '</section>'

def main():
    events = json.loads((ROOT / 'data/events.json').read_text())['events']
    template = (ROOT / 'templates/events-page.html').read_text()
    assert template.count('{{EVENTS}}') == 1
    (ROOT / 'activities.html').write_text(template.replace('{{EVENTS}}', render_events(events)))
    print(f'Built activities.html from {len(events)} public schedules and activities')
if __name__ == '__main__':
    main()
