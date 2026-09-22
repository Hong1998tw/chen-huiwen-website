#!/usr/bin/env python3
"""Build a native, keyboard-accessible election timeline from reviewed sources."""
from pathlib import Path
import json
from html import escape

ROOT = Path(__file__).resolve().parents[1]
data = json.loads((ROOT / 'data/platforms.json').read_text())
e = lambda value: escape(str(value), quote=True)

body = '<section class="page-head"><div class="wrap"><p class="eyebrow">政見原文與公開紀錄</p><h1>歷屆政見與願景</h1><p>閱讀 2026 政見原文，對照相關紀錄；歷屆政見依年份保留。</p></div></section><div class="wrap platforms-wrap"><div class="platform-timeline">'
entries = [(x['year'], x['election'], x) for x in data['elections']]

# Keep research gaps in source; publish empty content without asserting completeness.
for gap in data['gaps']:
    bits = gap['label'].split('｜', 1)
    entries.append((int(bits[0]) if len(bits) == 2 else 0, bits[-1], None))

for year, title, item in sorted(entries, key=lambda x: x[0], reverse=True):
    key = str(year) if year else 'early'
    open_attr = ' open' if year == 2026 and item else ''
    body += f'<section class="platform-row" id="platform-{key}"><div class="platform-year">{year or ""}</div><details class="platform-election"{open_attr}><summary><h2>{e(title)}</h2><span class="platform-toggle" aria-hidden="true">＋</span></summary><div class="platform-content">'

    if item:
        if item.get('sourceType') == 'campaign_material':
            meta = []
            if item.get('district'):
                meta.append(e(item['district']))
            if item.get('candidateNumber') is not None:
                meta.append(f'{e(item["candidateNumber"])}號')
            if item.get('roleAtElection'):
                meta.append(f'當時身分：{e(item["roleAtElection"])}')
            if meta:
                body += f'<p>{" · ".join(meta)}</p>'

            image = item.get('image')
            if year == 2026:
                body += '<aside class="platform-accountability"><h3>這些方向，如何追蹤？</h3><p>原文尚未逐項列出量化目標、完成期限與執行分工。下列連結供核對既有紀錄，不表示 2026 政見已完成。</p></aside>'
            if image:
                body += (
                    '<details class="platform-original"><summary>查看原始政見圖卡</summary><figure class="platform-poster">'
                    f'<a href="{e(image["path"])}" target="_blank" rel="noopener noreferrer" aria-label="開啟{e(image.get("caption", "政見圖卡"))}原圖">'
                    f'<img src="{e(image["path"])}" alt="{e(image["alt"])}" width="{e(image["width"])}" height="{e(image["height"])}" loading="lazy" decoding="async">'
                    '</a>'
                    f'<figcaption>{e(image.get("caption", "政見圖卡"))}（點圖可放大）</figcaption>'
                    '</figure></details>'
                )

            references = {
                (0,1): [('station-walkway','車站步行環境'),('school-crossing-flags','校園通學安全')],
                (0,2): [('bade-detention','八德滯洪池與防汛整備')],
                (1,1): [('fengshan-second-market','鳳山第二公有市場')],
                (2,2): [('after-school-care','身障學生照顧支持')],
                (3,0): [('school-case-review','校事會議制度檢討'),('school-administration','高中行政減壓')],
            }
            for section_index,section in enumerate(item['sections']):
                body += f'<section class="platform-theme" id="platform-{year}-theme-{section_index+1}"><h3>{e(section["heading"])}</h3><ol>'
                for point_index,text in enumerate(section['items']):
                    body += f'<li><p>{e(text)}</p>'
                    if year == 2026:
                        links=references.get((section_index,point_index),[])
                        body += '<div class="platform-evidence">' + ('相關公開紀錄：'+ '、'.join(f'<a href="achievement-{id}.html">{e(label)} →</a>' for id,label in links) if links else '本站尚未為此項連結對應專題。') + '</div>'
                    body += '</li>'
                body += '</ol></section>'

            body += (
                '<p class="source-note">'
                f'資料來源：{e(item["sourceTitle"])}<br>'
                f'{e(item["sourceDateNote"])}'
                '</p>'
            )
        else:
            body += f'<p>{e(item["district"])} · {item["candidateNumber"]}號 · 當時身分：{e(item["roleAtElection"])}</p><p class="source-note">投票日：<time datetime="{item["electionDate"]}">{item["electionDate"]}</time></p>'
            for section in item['sections']:
                body += f'<h3>{e(section["heading"])}</h3><ol>' + ''.join(f'<li>{e(text)}</li>' for text in section['items']) + '</ol>'
            body += f'<p class="source-note"><a class="text-link" href="{e(item["sourceUrl"])}#page={item["pdfPage"]}" target="_blank" rel="noopener noreferrer">{e(item["sourceTitle"])}（PDF 第 {item["pdfPage"]} 頁，外部網站）↗</a></p>'

    body += '</div></details></section>'

body += '</div></div>'
template = (ROOT / 'templates/platform-page.html').read_text()
assert template.count('{{PLATFORMS}}') == 1
(ROOT / 'vision.html').write_text(template.replace('{{PLATFORMS}}', body))
print(f'Built election timeline from {len(data["elections"])} reviewed election entries')
