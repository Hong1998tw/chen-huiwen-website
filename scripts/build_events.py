#!/usr/bin/env python3
"""Build public event announcements without credentials or personal-data collection."""
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from html import escape
from urllib.parse import urlencode, urlsplit
import json, re
ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo('Asia/Taipei')
BASE = 'https://hong1998tw.github.io/chen-huiwen-website/activities.html'
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
    if event.get('registrationUrl'):
        u = urlsplit(event['registrationUrl'])
        if u.scheme != 'https' or not u.hostname or u.username or u.password:
            raise ValueError('Registration URL must be public HTTPS')

def calendar_url(event):
    validate(event)
    dates = '/'.join(parse_time(event[k]).astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ') for k in ('start', 'end'))
    return 'https://calendar.google.com/calendar/render?' + urlencode({
        'action': 'TEMPLATE', 'text': event['name'], 'dates': dates,
        'ctz': 'Asia/Taipei', 'details': event['content'] + '\n\n' + BASE + '#event-' + event['id'],
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
    body = '<section class="page-head"><div class="wrap"><p class="eyebrow">EVENTS</p><h1>活動公告</h1><p>活動時間、內容與報名資訊，都在這裡。</p></div></section><section class="wrap event-announcements" aria-label="活動資訊">'
    if not events:
        return body + '<div class="event-empty"><p>新的活動公告將於本頁發布。</p><p><a class="text-link" href="gallery.html">查看過往活動與相片紀錄 →</a></p><p><a class="text-link" href="activity-market.html">五福市場職人展活動紀錄 →</a>　<a class="text-link" href="activity-mooncake.html">議起做月餅活動紀錄 →</a></p></div></section>'
    for event in sorted(events, key=lambda x: parse_time(x['start'])):
        e = lambda x: escape(str(x), quote=True)
        start, end = (parse_time(event[k]).astimezone(TAIPEI) for k in ('start','end'))
        body += f'<article class="event-card" id="event-{e(event["id"])}"><h2>{e(event["name"])}</h2><dl><dt>活動時間（台灣時間）</dt><dd><time datetime="{e(event["start"])}">{start:%Y/%m/%d %H:%M}</time> — <time datetime="{e(event["end"])}">{end:%Y/%m/%d %H:%M}</time></dd>'
        if event.get('location'):
            body += f'<dt>活動地點</dt><dd>{e(event["location"])}</dd>'
        body += '</dl><h3>活動內容</h3>'
        body += ''.join(f'<p>{e(p)}</p>' for p in event['content'].split('\n') if p.strip())
        body += f'<h3>報名資訊</h3><p>{e(event["registration"])}</p><div class="actions">'
        if event.get('registrationUrl'):
            body += f'<a class="button button-green" href="{e(event["registrationUrl"])}" target="_blank" rel="noopener noreferrer">前往報名（外部網站） ↗</a>'
        body += f'<a class="button button-outline" href="{e(calendar_url(event))}" target="_blank" rel="noopener noreferrer">加入 Google 日曆 ↗</a></div><p class="source-note">開啟 Google 日曆後，確認內容並儲存；加入日曆不代表完成報名。</p></article>'
    return body + '</section>'

def main():
    events = json.loads((ROOT / 'data/events.json').read_text())['events']
    template = (ROOT / 'templates/events-page.html').read_text()
    assert template.count('{{EVENTS}}') == 1
    (ROOT / 'activities.html').write_text(template.replace('{{EVENTS}}', render_events(events)))
    print(f'Built activities.html from {len(events)} public event announcements')
if __name__ == '__main__':
    main()
