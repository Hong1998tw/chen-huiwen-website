#!/usr/bin/env python3
"""Build a native, keyboard-accessible election timeline from reviewed sources."""
from pathlib import Path
import json
from html import escape

ROOT = Path(__file__).resolve().parents[1]
data = json.loads((ROOT / 'data/platforms.json').read_text())
e = lambda value: escape(str(value), quote=True)

body = '<section class="page-head"><div class="wrap"><p class="eyebrow">ELECTION PLATFORMS</p><h1>歷屆政見與願景</h1><p>閱讀2026最新政見與歷屆選舉政見。</p></div></section><div class="wrap platforms-wrap"><div class="platform-timeline">'
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
            if image:
                body += (
                    '<figure class="platform-poster">'
                    f'<a href="{e(image["path"])}" target="_blank" rel="noopener noreferrer" aria-label="開啟{e(image.get("caption", "政見圖卡"))}原圖">'
                    f'<img src="{e(image["path"])}" alt="{e(image["alt"])}" width="{e(image["width"])}" height="{e(image["height"])}" loading="lazy" decoding="async">'
                    '</a>'
                    f'<figcaption>{e(image.get("caption", "政見圖卡"))}（點圖可放大）</figcaption>'
                    '</figure>'
                )

            for section in item['sections']:
                body += f'<h3>{e(section["heading"])}</h3><ol>' + ''.join(f'<li>{e(text)}</li>' for text in section['items']) + '</ol>'

            body += (
                '<p class="source-note">'
                f'資料狀態：{e(item["status"])}<br>'
                f'資料來源：{e(item["sourceTitle"])}<br>'
                f'{e(item["sourceDateNote"])}<br>'
                f'查核日期：{e(item["verifiedAt"])}'
                '</p>'
            )
        else:
            body += f'<p>{e(item["district"])} · {item["candidateNumber"]}號 · 當時身分：{e(item["roleAtElection"])}</p><p class="source-note">投票日：<time datetime="{item["electionDate"]}">{item["electionDate"]}</time></p>'
            for section in item['sections']:
                body += f'<h3>{e(section["heading"])}</h3><ol>' + ''.join(f'<li>{e(text)}</li>' for text in section['items']) + '</ol>'
            body += f'<p class="source-note"><a class="text-link" href="{e(item["sourceUrl"])}#page={item["pdfPage"]}" target="_blank" rel="noopener noreferrer">{e(item["sourceTitle"])}（PDF 第 {item["pdfPage"]} 頁，外部網站）↗</a><br>查核日期：{e(item["verifiedAt"])}</p>'

    body += '</div></details></section>'

body += '</div></div>'
template = (ROOT / 'templates/platform-page.html').read_text()
assert template.count('{{PLATFORMS}}') == 1
(ROOT / 'vision.html').write_text(template.replace('{{PLATFORMS}}', body))
print(f'Built election timeline from {len(data["elections"])} reviewed election entries')
