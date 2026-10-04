#!/usr/bin/env python3
"""Build the approved homepage using published event, service and schedule sources."""
from pathlib import Path
from datetime import datetime
from html import escape
from zoneinfo import ZoneInfo
import json
import re
from build_guides import load_office
from build_events import validate as validate_event
from build_service import validate_schedule

ROOT = Path(__file__).resolve().parents[1]
FEATURED_EVENT = 'campaign-headquarters-opening-2026-10-31'


def e(value):
    return escape(str(value), quote=True)


def render_services(office, schedule):
    month = int(schedule['month'].split('-')[1])
    return f'''<section class="wrap services" aria-label="民眾常用服務"><a href="service.html#monthly-heading" data-home-legal-month="{e(schedule['month'])}"><span>公益法律諮詢</span><strong>{month}月律師時間表 ↗</strong><small>查看日期、輪值律師，下載分享圖卡</small></a><a href="service-guides.html"><span>反映生活問題</span><strong>洽詢前，準備什麼 ↗</strong><small>查看洽詢前可準備的資料</small></a><a href="{e(office['phoneUrl'])}"><span>聯絡服務處</span><strong>{e(office['phone'])} ↗</strong><small>{e(office['address'])}</small></a></section>'''


def render_event(events):
    event = next((item for item in events if item['id'] == FEATURED_EVENT), None)
    if event is None:
        return '<section class="section wrap" id="opening"><h2>公開行程與活動</h2><p>查看活動日期、地點與參與資訊。</p><a class="source" href="activities.html">查看公開行程與活動 ↗</a></section>'
    validate_event(event)
    start = datetime.fromisoformat(event['start']).astimezone(ZoneInfo('Asia/Taipei'))
    url = 'event-' + event['id'] + '.html'
    status = {'scheduled': '公開行程', 'rescheduled': '行程時間已更改', 'cancelled': '活動已取消'}[event.get('status', 'scheduled')]
    change = f'<p>{e(event["changeNote"])}</p>' if event.get('changeNote') else ''
    photo = ''
    if event.get('images'):
        image = event['images'][0]
        photo = f'<a href="{e(url)}" aria-label="查看{e(event["name"])}的完整行程與圖卡"><img src="{e(image["src"])}" width="{image["width"]}" height="{image["height"]}" alt="{e(image["alt"])}" loading="lazy" decoding="async"></a>'
    return f'''<section class="section opening-section" id="opening" aria-labelledby="opening-title" data-home-event="{e(event['id'])}"><div class="wrap event-summary"><div><p class="kicker">{status}</p><p class="event-date"><time datetime="{e(event['start'])}">{start.month}月{start.day}日<span>星期{'一二三四五六日'[start.weekday()]}　{start:%H:%M} 開始</span></time></p><h2 id="opening-title">{e(event['name'])}</h2><p class="event-location">{e(event.get('location', ''))}</p>{change}<p>{e(event['registration'])}</p><a class="source" href="{e(url)}">完整行程、地點與圖卡下載 ↗</a></div>{photo}</div></section>'''


def render_contact(office):
    hours = ''.join(f'<dt>{e(label)}</dt><dd>{e(value).replace("、", "<br>")}</dd>' for label, value in office['hours'])
    return f'''<section class="contact-section civic-service-desk" id="contact"><div class="wrap contact-grid"><div><p class="kicker">有事找慧文</p><h2>先說說，<br>你遇到什麼事。</h2><a class="big-phone" href="{e(office['phoneUrl'])}">{e(office['phone'])}</a><p>{e(office['address'])}</p><a class="source" href="service.html#contact">完整聯絡資訊與地圖導航 ↗</a></div><div><dl>{hours}</dl><p>公益律師諮詢採預約制。請先來電確認日期、時段與名額。</p><small>來訪前，請先向服務處確認當日服務與預約安排。</small></div></div></section><nav class="mobile-actions" aria-label="手機常用服務"><a href="{e(office['phoneUrl'])}">電話預約</a><a href="service.html#contact">地址與時間</a></nav>'''


def build(root=ROOT):
    office = load_office(root)
    schedule = validate_schedule(json.loads((root / 'data/legal-schedule.json').read_text()))
    events = json.loads((root / 'data/events.json').read_text())['events']
    body = (root / 'templates/home-main.html').read_text().strip()
    for key, value in [('HOME_SERVICES', render_services(office, schedule)), ('HOME_EVENT', render_event(events)), ('HOME_CONTACT', render_contact(office))]:
        marker = '{{' + key + '}}'
        if body.count(marker) != 1:
            raise ValueError('Exactly one homepage section marker required: ' + key)
        body = body.replace(marker, value)
    if '{{' in body:
        raise ValueError('Unresolved homepage template marker')
    page = root / 'index.html'
    content, count = re.subn(r'<main\b.*?</main>', lambda _: body, page.read_text(), count=1, flags=re.S)
    if count != 1:
        raise ValueError('Homepage main region is missing')
    page.write_text(content)
    print('Built homepage service and event projections from canonical sources')


if __name__ == '__main__': build()
