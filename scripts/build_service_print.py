#!/usr/bin/env python3
"""Make the service handout from the actual service page and canonical schedule."""
from pathlib import Path
from html import escape
import hashlib
import json
from bs4 import BeautifulSoup
from build_service import validate_schedule, source_markup

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://www.huiwen.tw/'


def render(root=ROOT):
    source = BeautifulSoup((root / 'service.html').read_text(), 'html.parser')
    schedule = validate_schedule(json.loads((root / 'data/legal-schedule.json').read_text()))
    metadata = json.loads((root / 'data/page-metadata.json').read_text())
    e = lambda value: escape(str(value), quote=True)
    contact = source.select_one('#contact .contact-card')
    hours = source.select_one('#contact .hours')
    if contact is None or hours is None:
        raise ValueError('Printable service facts require the canonical contact and hours sections')
    phone = contact.select_one('.big-phone')
    facts = contact.select_one('dl')
    if phone is None or facts is None:
        raise ValueError('Missing canonical service contact facts')
    rows = ''.join(f'<tr><th scope="row"><time datetime="{e(row["date"])}">{e(row["date"][5:].replace("-", "/"))}</time></th><td>{e(row["start"])}–{e(row["end"])}</td><td>{e(row.get("lawyer") or "請洽服務處")}</td></tr>' for row in schedule['sessions'])
    body = f'''<section class="wrap service-handout" aria-labelledby="handout-title">
    <div class="print-toolbar"><a class="text-link" href="service.html">← 服務處資訊</a><button class="button button-green print-page" type="button" hidden>列印／存成 PDF</button></div>
    <p class="civic-kicker">陳慧文服務處 · 服務資訊隨身單</p><h1 id="handout-title">來訪與公益律師諮詢</h1>
    <p class="handout-intro">律師表適用月份：{e(schedule['month'])}。其他月份請先來電確認日期、時間與名額，勿依過期月表直接前往。</p>
    <div class="handout-grid"><section><h2>聯絡與來訪</h2><a class="handout-phone" href="{e(phone['href'])}">{e(phone.select_one('.phone-number').get_text(strip=True))}</a>{facts}<h3>服務時間</h3>{hours}<p>法律諮詢請備妥案件正本資料，先以電話或親臨服務處預約。</p></section>
    <section><h2>{e(schedule['month'])} 律師時間表</h2><table><caption>所列月份已公布時段 · 非即時名額</caption><thead><tr><th scope="col">日期</th><th scope="col">時間</th><th scope="col">律師</th></tr></thead><tbody>{rows}</tbody></table></section></div>
    <div class="handout-source"><p>律師表核對日期：<time datetime="{e(schedule['observedAt'])}">{e(schedule['observedAt'])}</time>；聯絡資訊整理日期：{e(metadata['service.html']['contentUpdated'])}。</p><p>時間表來源：{source_markup(schedule)}。最新資訊與預約須知：<a class="latest-url" href="{BASE}service.html">{BASE}service.html</a></p><p>需要準備什麼？<a href="service-guides.html">閱讀洽詢準備指南 →</a></p></div>
    <noscript><p>請使用瀏覽器選單的「列印」，選擇 A4 直式、100% 比例；如需保留電子檔，可選「存成 PDF」。</p></noscript></section>'''
    template = (root / 'templates/case-page.html').read_text()
    title = '服務資訊隨身單｜陳慧文服務處'
    description = '列印陳慧文服務處電話、地址、服務時間與已公布月份的公益律師時間表。資料由服務處資訊頁同步產生，出發前請來電確認。'
    # Screen-only wrapping keeps enlarged text readable; the A4 print layout is unchanged.
    head = '<style>@media screen{.service-handout .handout-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.handout-grid>section{min-width:0}.handout-grid dd,.handout-grid a,.handout-grid th,.handout-grid td{overflow-wrap:anywhere}.handout-grid table{table-layout:fixed}}@media screen and (max-width:700px){.service-handout .handout-grid{grid-template-columns:minmax(0,1fr)}}</style>'
    replacements = {'TITLE':title, 'DESCRIPTION':description, 'FILE':'service-print.html', 'BODY':body,
                    'HEAD':head, 'OG_TYPE':'website', 'OG_IMAGE':'assets/site-share-20260909.png', 'OG_ALT':title,
                    'STYLE_VERSION':hashlib.sha256((root/'styles.css').read_bytes()).hexdigest()[:12],
                    'DIGITAL_STYLE_VERSION':hashlib.sha256((root/'digital.css').read_bytes()).hexdigest()[:12],
                    'DIGITAL_SCRIPT_VERSION':hashlib.sha256((root/'digital.js').read_bytes()).hexdigest()[:12]}
    for key,value in replacements.items():
        template = template.replace('{{'+key+'}}',value if key in ('BODY','HEAD') else e(value))
    if '{{' in template:
        raise ValueError('Unresolved print template variable')
    return template


if __name__ == '__main__':
    (ROOT/'service-print.html').write_text(render())
    print('Built service handout from canonical service and schedule sources')
