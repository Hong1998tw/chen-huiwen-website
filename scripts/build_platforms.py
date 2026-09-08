#!/usr/bin/env python3
"""Build historical platforms separately from achievement evidence."""
from pathlib import Path
import json
from html import escape

ROOT = Path(__file__).resolve().parents[1]
data = json.loads((ROOT / 'data/platforms.json').read_text())
e = lambda value: escape(str(value), quote=True)
body = '<section class="page-head"><div class="wrap"><p class="eyebrow">ELECTION PLATFORMS</p><h1>歷屆政見與願景</h1><p>哪一年、哪一次選舉，提出了哪些主張？</p></div></section><div class="wrap"><p class="section-intro">以下保存當年正式選舉公報政見，不代表已完成，也不自動代表現在的政策立場。後續執行情形請另看<a class="text-link" href="achievements.html">政績與追蹤紀錄</a>。</p><nav class="platform-years" aria-label="依選舉年份閱讀">'
for item in reversed(data['elections']):
    body += f'<a href="#platform-{item["year"]}">{item["year"]}</a>'
body += '<a href="#platform-gaps">其他參選紀錄</a></nav>'
for item in reversed(data['elections']):
    body += f'<section class="platform-section" id="platform-{item["year"]}"><h2>{item["year"]}｜{e(item["election"])}</h2><p>{e(item["district"])} · {item["candidateNumber"]}號 · 當時身分：{e(item["roleAtElection"])}</p><p class="source-note">投票日：<time datetime="{item["electionDate"]}">{item["electionDate"]}</time>。{e(item["sourceDateNote"])}</p>'
    for section in item['sections']:
        body += f'<h3>{e(section["heading"])}</h3><ol>' + ''.join(f'<li>{e(text)}</li>' for text in section['items']) + '</ol>'
    body += f'<p class="source-note"><a class="text-link" href="{e(item["sourceUrl"])}#page={item["pdfPage"]}" target="_blank" rel="noopener noreferrer">{e(item["sourceTitle"])}（PDF 第 {item["pdfPage"]} 頁，外部網站）↗</a><br>查核日期：{e(item["verifiedAt"])}</p><a class="text-link" href="#main">回到年份導覽 ↑</a></section>'
body += '<section id="platform-gaps" class="platform-section"><h2>其他參選紀錄與資料缺口</h2>'
for gap in data['gaps']:
    body += f'<h3>{e(gap["label"])}</h3><p>{e(gap["status"])}</p>'
    if gap.get('sourceUrl'):
        body += f'<p><a class="text-link" href="{e(gap["sourceUrl"])}" target="_blank" rel="noopener noreferrer">查看官方紀錄（外部網站）↗</a></p>'
body += '</section></div>'
template = (ROOT / 'templates/platform-page.html').read_text()
assert template.count('{{PLATFORMS}}') == 1
(ROOT / 'vision.html').write_text(template.replace('{{PLATFORMS}}', body))
print(f'Built vision.html from {len(data["elections"])} official election bulletins')
