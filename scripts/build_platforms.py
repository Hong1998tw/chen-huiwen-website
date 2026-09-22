#!/usr/bin/env python3
"""Build reviewed platform text and stable evidence links without inferring fulfilment."""
from pathlib import Path
from html import escape
import json
import re

ROOT = Path(__file__).resolve().parents[1]
e = lambda value: escape(str(value), quote=True)


def platform_registry(data, achievements):
    """Bind IDs to exact source text, never to array position; reject stale relations."""
    records = {item['id']: item for item in achievements if item.get('status') != '待核驗'}
    registry = data.get('itemsById', {})
    lookup = {}
    for item_id, item in registry.items():
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', item_id):
            raise ValueError(f'Invalid platform ID: {item_id}')
        key = (item['year'], item['sourceText'])
        if key in lookup:
            raise ValueError('Duplicate platform source text in one election')
        lookup[key] = (item_id, item)
        for case_id in item.get('relatedRecordIds', []):
            if case_id not in records:
                raise ValueError(f'Platform {item_id} references a non-public record: {case_id}')
    source_keys = [(entry['year'], text) for entry in data['elections']
                   for section in entry['sections'] for text in section['items']]
    if len(source_keys) != len(set(source_keys)) or set(source_keys) != set(lookup):
        raise ValueError('Platform registry must match every source item exactly; preserve IDs when editing reviewed text')
    seen = set()
    for comparison in data.get('crossTermComparisons', []):
        if comparison['id'] in seen:
            raise ValueError('Duplicate comparison ID')
        seen.add(comparison['id'])
        a, b = (registry.get(comparison[key]) for key in ('fromItemId', 'toItemId'))
        if not a or not b or a['year'] >= b['year']:
            raise ValueError('Comparison must reference two existing platform items in chronological order')
        if (comparison.get('relationType') != 'topic_comparison'
                or comparison.get('relationshipStatus') != 'needs_confirmation'
                or comparison.get('outcomeStatus') != 'not_assessed'):
            raise ValueError('A stronger cross-term claim needs a separately reviewed evidence contract')
    return lookup, records


def render_comparisons(data):
    comparisons = data.get('crossTermComparisons', [])
    if not comparisons:
        return ''
    registry = data['itemsById']
    body = '<section class="platform-comparisons" aria-labelledby="platform-comparisons-heading"><h2 id="platform-comparisons-heading">前後屆政見，放在一起讀</h2><p>以下按相近主題對照原文，並不表示已確認承諾延續或完成。目標、期限與政府執行情形仍須逐項核對。</p>'
    for comparison in comparisons:
        body += f'<details class="platform-comparison" id="comparison-{e(comparison["id"])}"><summary>{e(comparison["title"])}</summary>'
        for key in ('fromItemId', 'toItemId'):
            item_id = comparison[key]
            item = registry[item_id]
            body += f'<p><strong>{item["year"]} 原文</strong></p><blockquote><p>{e(item["sourceText"])}</p></blockquote><a class="text-link" href="#platform-item-{e(item_id)}">閱讀 {item["year"]} 原文與來源 ↓</a>'
        body += f'<p class="source-note">{e(comparison["note"])}</p><p class="source-note">延續關係：待確認 · 完成情形：尚未評估</p></details>'
    return body + '</section>'


def render_platforms(data, achievements):
    lookup, records = platform_registry(data, achievements)
    body = '<section class="page-head"><div class="wrap"><p class="eyebrow">政見原文與公開紀錄</p><h1>歷屆政見與願景</h1><p>閱讀 2026 政見原文，對照相關紀錄；歷屆政見依年份保留。</p>'
    if data.get('crossTermComparisons'):
        body += '<a class="text-link" href="#platform-comparisons-heading">前後屆政見對照 ↓</a>'
    body += '</div></section><div class="wrap platforms-wrap"><div class="platform-timeline">'
    entries = [(x['year'], x['election'], x, None) for x in data['elections']]
    for gap in data['gaps']:
        bits = gap['label'].split('｜', 1)
        entries.append((int(bits[0]) if len(bits) == 2 else 0, bits[-1], None, gap))
    for year, title, item, gap in sorted(entries, key=lambda x: x[0], reverse=True):
        key = str(year) if year else 'early'
        open_attr = ' open' if year == 2026 and item else ''
        body += f'<section class="platform-row" id="platform-{key}"><div class="platform-year">{year or ""}</div><details class="platform-election"{open_attr}><summary><h2>{e(title)}</h2><span class="platform-toggle" aria-hidden="true">＋</span></summary><div class="platform-content">'
        if gap:
            body += f'<p class="source-note">資料待補：{e(gap["status"])}</p>'
            if gap.get('sourceUrl'):
                body += f'<p><a class="text-link" href="{e(gap["sourceUrl"])}" target="_blank" rel="noopener noreferrer">已取得的官方資料 ↗</a></p>'
        if item:
            campaign = item.get('sourceType') == 'campaign_material'
            if campaign:
                meta = [e(item[field]) for field in ('district', 'roleAtElection') if item.get(field)]
                if item.get('candidateNumber') is not None:
                    meta.append(f'{e(item["candidateNumber"])}號')
                if meta:
                    body += f'<p>{" · ".join(meta)}</p>'
                if year == 2026:
                    body += '<aside class="platform-accountability"><h3>這些方向，如何追蹤？</h3><p>原文尚未逐項列出量化目標、完成期限與執行分工。下列連結供核對既有紀錄，不表示 2026 政見已完成；尚缺資訊會明確保留。</p></aside>'
                image = item.get('image')
                if image:
                    body += ('<details class="platform-original"><summary>查看原始政見圖卡</summary><figure class="platform-poster">'
                             f'<a href="{e(image["path"])}" target="_blank" rel="noopener noreferrer" aria-label="開啟{e(image.get("caption", "政見圖卡"))}原圖">'
                             f'<img src="{e(image["path"])}" alt="{e(image["alt"])}" width="{e(image["width"])}" height="{e(image["height"])}" loading="lazy" decoding="async"></a>'
                             f'<figcaption>{e(image.get("caption", "政見圖卡"))}（點圖可放大）</figcaption></figure></details>')
            else:
                body += f'<p>{e(item["district"])} · {item["candidateNumber"]}號 · 當時身分：{e(item["roleAtElection"])}</p><p class="source-note">投票日：<time datetime="{item["electionDate"]}">{item["electionDate"]}</time></p>'
            for section_index, section in enumerate(item['sections']):
                body += f'<section class="platform-theme" id="platform-{year}-theme-{section_index+1}"><h3>{e(section["heading"])}</h3><ol>'
                for text in section['items']:
                    item_id, metadata = lookup[(year, text)]
                    body += f'<li id="platform-item-{e(item_id)}"><p>{e(text)}</p>'
                    if year == 2026:
                        links = metadata.get('relatedRecordIds', [])
                        body += '<div class="platform-evidence">' + ('相關公開紀錄：' + '、'.join(f'<a href="achievement-{e(case_id)}.html">{e(records[case_id]["title"])} →</a>' for case_id in links) if links else '本站尚未為此項連結對應專題。') + '</div>'
                    body += '</li>'
                body += '</ol></section>'
            if campaign:
                body += f'<p class="source-note">資料來源：{e(item["sourceTitle"])}<br>{e(item["sourceDateNote"])}</p>'
            else:
                body += f'<p class="source-note"><a class="text-link" href="{e(item["sourceUrl"])}#page={item["pdfPage"]}" target="_blank" rel="noopener noreferrer">{e(item["sourceTitle"])}（PDF 第 {item["pdfPage"]} 頁，外部網站）↗</a></p>'
        body += '</div></details></section>'
    return body + '</div>' + render_comparisons(data) + '</div>'


def main():
    data = json.loads((ROOT / 'data/platforms.json').read_text())
    achievements = json.loads((ROOT / 'data/achievements.json').read_text())
    template = (ROOT / 'templates/platform-page.html').read_text()
    assert template.count('{{PLATFORMS}}') == 1
    (ROOT / 'vision.html').write_text(template.replace('{{PLATFORMS}}', render_platforms(data, achievements)))
    print(f'Built election timeline with {len(data["itemsById"])} stable platform IDs')


if __name__ == '__main__':
    main()
