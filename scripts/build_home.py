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
from achievement_metadata import latest_history_event

ROOT = Path(__file__).resolve().parents[1]
FEATURED_EVENT = 'campaign-headquarters-opening-2026-10-31'


def e(value):
    return escape(str(value), quote=True)


def render_services(office, schedule):
    month = int(schedule['month'].split('-')[1])
    return f'''<section class="wrap home-task-paths" aria-label="主要服務任務入口"><a href="service.html#contact" data-home-task="service"><span>服務協助</span><strong>聯絡服務處 ↗</strong><small>電話、地址與服務時間</small></a><a href="achievements.html#case-results" data-home-task="local"><span>地方進度</span><strong>查看地方紀錄 ↗</strong><small>依里別、主題與辦理階段查詢</small></a><a href="council-records.html" data-home-task="records"><span>問政紀錄</span><strong>查詢議會公開資料 ↗</strong><small>查看質詢紀錄與官方查詢入口</small></a></section><nav class="wrap home-service-shortcuts" aria-label="其他服務捷徑"><a href="service.html#monthly-heading" data-home-legal-month="{e(schedule['month'])}">公益法律諮詢 · {month}月律師時間表</a><a href="service-guides.html">洽詢前準備指南</a><a href="{e(office['phoneUrl'])}">直接撥打 {e(office['phone'])}</a><span class="home-service-address">服務處地址：{e(office['address'])}</span></nav>'''


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
    return f'''<section class="home-recent-event" id="opening" aria-labelledby="opening-title" data-home-event="{e(event['id'])}"><div><p class="kicker">{status}</p><p class="event-date"><time datetime="{e(event['start'])}">{start.month}月{start.day}日<span>星期{'一二三四五六日'[start.weekday()]}　{start:%H:%M} 開始</span></time></p><h3 id="opening-title">{e(event['name'])}</h3><p class="event-location">{e(event.get('location', ''))}</p>{change}<p>{e(event['registration'])}</p><a class="source" href="{e(url)}">完整行程、地點與圖卡下載 ↗</a></div>{photo}</section>'''


def render_recent_local(root):
    config = json.loads((root / 'data/civic-home.json').read_text())
    records = {row['id']: row for row in json.loads((root / 'data/achievements.json').read_text())}
    record = records[config['featured']]
    summary = config.get('summaries', {}).get(record['id']) or record.get('summary', '')
    place = '、'.join(record.get('villages', [])) or record.get('scope', '地區未載')
    latest = latest_history_event(record.get('history') or [])
    date_text = latest.get('date', '日期未載') if latest else '日期未載'
    return (f'<article class="home-recent-local" data-home-local-record="{e(record["id"])}">'
            f'<p class="kicker">地方專題 · {e((record.get("categories") or ["公開紀錄"])[0])}</p>'
            f'<h3><a href="achievement-{e(record["id"])}.html">{e(record["title"])}</a></h3>'
            f'<p>{e(summary)}</p><p class="home-recent-meta">{e(place)} · {e(record.get("status") or "階段未載")} · 最新收錄 {e(date_text)}</p>'
            f'<a class="source" href="achievement-{e(record["id"])}.html">閱讀這件地方事與資料來源 ↗</a></article>')


def render_contact(office):
    hours = ''.join(f'<dt>{e(label)}</dt><dd>{e(value).replace("、", "<br>")}</dd>' for label, value in office['hours'])
    return f'''<section class="contact-section civic-service-desk" id="contact"><div class="wrap contact-grid"><div><p class="kicker">有事找慧文</p><h2>先說說，<br>你遇到什麼事。</h2><a class="big-phone" href="{e(office['phoneUrl'])}">{e(office['phone'])}</a><p>{e(office['address'])}</p><a class="source" href="service.html#contact">完整聯絡資訊與地圖導航 ↗</a></div><div><dl>{hours}</dl><p>公益律師諮詢採預約制。請先來電確認日期、時段與名額。</p><small>來訪前，請先向服務處確認當日服務與預約安排。</small></div></div></section><nav class="mobile-actions" aria-label="手機常用服務"><a href="{e(office['phoneUrl'])}">電話預約</a><a href="service.html#contact">地址與時間</a></nav>'''


def build(root=ROOT):
    office = load_office(root)
    schedule = validate_schedule(json.loads((root / 'data/legal-schedule.json').read_text()))
    events = json.loads((root / 'data/events.json').read_text())['events']
    body = (root / 'templates/home-main.html').read_text().strip()
    for key, value in [('HOME_SERVICES', render_services(office, schedule)), ('HOME_EVENT', render_event(events)), ('HOME_LOCAL', render_recent_local(root)), ('HOME_CONTACT', render_contact(office))]:
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
