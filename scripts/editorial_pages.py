"""One safe block model for owner-created news, service, council and policy pages."""
from __future__ import annotations
from python_guard import require_supported_python
require_supported_python()

from datetime import date, datetime
from html import escape
from pathlib import Path
from urllib.parse import quote, urlsplit
import json
import re

from case_media import classify, render as render_media
from page_seo import BASE, validate as validate_seo

SECTIONS = {
    'news': ('news.html', '新聞媒體'),
    'press': ('press.html', '新聞發布'),
    'service': ('service.html', '民眾服務'),
    'council': ('council-records.html', '議會問政'),
    'achievement': ('achievements.html', '建設與政績'),
}
BLOCK_TYPES = {'heading', 'paragraph', 'timeline', 'source', 'photo', 'video', 'map'}
CONTROL = re.compile(r'[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]')
PATH = re.compile(r'^page-(news|press|service|council|achievement)-([a-z0-9]+(?:-[a-z0-9]+)*)\.html$')


def clean(value, label, limit=4000, required=False):
    if not isinstance(value, str) or len(value) > limit or CONTROL.search(value) or '<' in value or '>' in value or (required and not value.strip()):
        raise ValueError(label + '格式不正確')
    return value.strip()


def day(value, label):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError(label + '必須是 YYYY-MM-DD')
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ValueError(label + '不是有效日曆日期') from None
    return value


def datetime_taipei(value, label):
    if value == '': return ''
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+08:00', value):
        raise ValueError(label + '必須是台灣時間 YYYY-MM-DDTHH:MM+08:00')
    try:
        datetime.fromisoformat(value)
    except ValueError:
        raise ValueError(label + '不是有效時間') from None
    return value


def public_url(value, label):
    if not isinstance(value, str) or len(value) > 1200 or CONTROL.search(value):
        raise ValueError(label + '網址不正確')
    try:
        url = urlsplit(value)
        host = (url.hostname or '').lower()
        if url.scheme != 'https' or not host or '.' not in host or url.username or url.password or url.port not in (None, 443) or re.fullmatch(r'[\d.]+', host) or host.endswith(('.local','.internal','.lan','.home','.corp','.notion.so','.notion.site')) or host in {'notion.so','notion.site','docs.google.com'} or re.search(r'(?:token|api_key|secret|password)=', url.query, re.I):
            raise ValueError
    except ValueError:
        raise ValueError(label + '必須是公開 HTTPS 網址') from None
    return value


def validate_page(path, value, root: Path):
    matched = PATH.fullmatch(path)
    if not matched or not isinstance(value, dict) or set(value) != {'section','title','summary','updated','eventStart','eventEnd','seo','blocks'}:
        raise ValueError('新增頁面格式或網址不正確')
    if value['section'] != matched[1]:
        raise ValueError('頁面區塊與網址不一致')
    title = clean(value['title'], '頁面標題', 150, True)
    summary = clean(value['summary'], '頁面摘要', 500, True)
    updated = day(value['updated'], '內容整理日期')
    start = datetime_taipei(value['eventStart'], '開始時間')
    end = datetime_taipei(value['eventEnd'], '結束時間')
    if end and (not start or end <= start):
        raise ValueError('結束時間必須晚於開始時間')
    seo = validate_seo(value['seo'], root)
    blocks = validate_blocks(value['blocks'], required=True)
    return {'section':matched[1], 'title':title, 'summary':summary, 'updated':updated,
            'eventStart':start, 'eventEnd':end, 'seo':seo, 'blocks':blocks}


def validate_blocks(blocks, required=False):
    if not isinstance(blocks, list) or len(blocks) > 80 or (required and not blocks):
        raise ValueError('頁面內容區塊數量不正確，最多八十個')
    for index, block in enumerate(blocks):
        if not isinstance(block, dict) or set(block) != {'type','title','text','date','url','alt','credit','address','publicAccessConfirmed'} or block['type'] not in BLOCK_TYPES:
            raise ValueError(f'區塊 {index+1} 格式不正確')
        if not isinstance(block['publicAccessConfirmed'], bool):
            raise ValueError('媒體公開狀態格式不正確')
        for key, limit in [('title',200),('text',4000),('date',25),('url',1200),('alt',250),('credit',250),('address',300)]:
            clean(block[key], f'區塊 {index+1} {key}', limit)
        typ = block['type']
        if typ == 'heading': clean(block['title'], '標題', 200, True)
        if typ == 'paragraph': clean(block['text'], '段落', 4000, True)
        if typ == 'timeline':
            day(block['date'], '時間軸日期'); clean(block['title'], '時間軸標題', 200, True)
            clean(block['text'], '時間軸說明', 4000, True)
        if typ == 'source':
            clean(block['title'], '來源名稱', 200, True); public_url(block['url'], '資料來源')
            if block['date']: day(block['date'], '來源日期')
        if typ in {'photo','video'}:
            if not classify(block['url'], typ) or not block['alt'].strip() or not block['credit'].strip() or not block['publicAccessConfirmed']:
                raise ValueError('照片／影片需要可用的公開網址、替代文字、來源及公開存取確認')
        if typ == 'map':
            address = block['address'].strip()
            if not re.fullmatch(r'高雄市[^\s，,]{1,12}(?:區|鄉|鎮|市)[^\s，,]{2,}(?:\d+號|[路街巷]口)', address):
                raise ValueError('地圖請填高雄市、行政區、道路與門牌號碼或路口，並用地圖核對')
    return blocks


def read(root: Path):
    value = json.loads((root / 'data/editorial-pages.json').read_text(encoding='utf-8'))
    if not isinstance(value, dict) or set(value) != {'schemaVersion','pages'} or value['schemaVersion'] != 1 or not isinstance(value['pages'], dict):
        raise ValueError('EDITORIAL_SCHEMA: expected version 1')
    for path, page in value['pages'].items(): validate_page(path, page, root)
    return value


def render_block(block):
    typ = block['type']
    e = lambda key: escape(block[key], quote=True)
    if typ == 'heading': return '<h2>' + e('title') + '</h2>'
    if typ == 'paragraph': return '<p>' + e('text').replace('\n','<br>') + '</p>'
    if typ == 'timeline': return f'<article class="content-card"><div class="card-body"><time datetime="{e("date")}">{e("date")}</time><h2>{e("title")}</h2><p>{e("text")}</p></div></article>'
    if typ == 'source':
        stamp = f'<time datetime="{e("date")}">{e("date")}</time> · ' if block['date'] else ''
        return f'<p class="source-note">{stamp}<a href="{e("url")}" target="_blank" rel="noopener noreferrer">{e("title")} ↗</a></p>'
    if typ in {'photo','video'}:
        return render_media({'kind':typ,'url':block['url'],'alt':block['alt'],'caption':block['text'] or block['title'],'credit':block['credit']})
    address = e('address')
    maps = 'https://www.google.com/maps/search/?api=1&query=' + quote(block['address'], safe='')
    return f'<div class="content-card"><div class="card-body"><h2>{e("title") or "地點"}</h2><address>{address}</address><p><a class="button button-green" href="{escape(maps, quote=True)}" target="_blank" rel="noopener noreferrer">開啟地圖 App 導航 ↗</a></p></div></div>'


def render_page(path, page, root):
    section_path, section_label = SECTIONS[page['section']]
    title = page['seo']['title']; description = page['seo']['description']
    image = page['seo']['image']; image_alt = page['seo']['imageAlt']
    image_type = {'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','webp':'image/webp','avif':'image/avif'}[image.rsplit('.',1)[-1].lower()]
    e = lambda value: escape(value, quote=True)
    canonical = BASE + path
    body = (f'<div class="wrap breadcrumb"><a href="./">首頁</a><span>/</span><a href="{section_path}">{section_label}</a><span>/</span><span>{e(page["title"])}</span></div>'
            f'<section class="page-head"><div class="wrap"><p class="eyebrow">{section_label}</p><h1>{e(page["title"])}</h1><p>{e(page["summary"])}</p></div></section>'
            '<article class="wrap section editorial-body">' + ''.join(render_block(block) for block in page['blocks']) +
            f'<p class="source-note">內容整理 <time datetime="{page["updated"]}">{page["updated"]}</time></p></article>')
    if page['eventStart']:
        body = body.replace('<article class="wrap section editorial-body">', f'<article class="wrap section editorial-body"><p><time datetime="{page["eventStart"]}">{e(page["eventStart"].replace("T", " ").replace("+08:00", ""))}</time>' + (f' – <time datetime="{page["eventEnd"]}">{e(page["eventEnd"].replace("T", " ").replace("+08:00", ""))}</time>' if page['eventEnd'] else '') + '</p>', 1)
    schema = {'@context':'https://schema.org','@type':'Article','@id':canonical+'#article','url':canonical,'name':title,'headline':page['title'],'description':description,'dateModified':page['updated'],'inLanguage':'zh-Hant-TW'}
    head = (f'<title>{e(title)}</title><meta name="description" content="{e(description)}"><link rel="canonical" href="{e(canonical)}">'
            f'<meta property="og:type" content="article"><meta property="og:locale" content="zh_TW"><meta property="og:site_name" content="陳慧文官網">'
            f'<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(description)}"><meta property="og:url" content="{e(canonical)}">'
            f'<meta property="og:image" content="{e(image)}"><meta property="og:image:type" content="{image_type}"><meta property="og:image:alt" content="{e(image_alt)}">'
            f'<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{e(title)}"><meta name="twitter:description" content="{e(description)}"><meta name="twitter:image" content="{e(image)}"><meta name="twitter:image:alt" content="{e(image_alt)}">'
            '<script type="application/ld+json">' + json.dumps(schema,ensure_ascii=False).replace('<','\\u003c') + '</script>')
    return ('<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            '<meta name="theme-color" content="#075548">' + head + '<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">'
            '<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="mobile.css"><link rel="stylesheet" href="layout.css">'
            '<link rel="stylesheet" href="civic.css"><script src="site.js" defer></script><script src="civic.js" defer></script>'
            '<script data-cms-editor-loader>if(window.self!==window.top&&(document.currentScript?.dataset.cmsEditorEnabled===\'true\'||new URLSearchParams(location.search).get(\'cmsEdit\')===\'1\'))document.write(\'<scr\'+\'ipt defer src="/cms-page-editor.js"></scr\'+\'ipt>\');</script>'
            '</head><body><a class="skip-link" href="#main">跳到主要內容</a><!-- shared-header:start -->\n<!-- shared-header:end -->'
            '<main id="main">' + body + '</main><!-- shared-footer:start -->\n<!-- shared-footer:end --></body></html>')


def build(root: Path):
    data = read(root)
    managed = json.loads((root / 'data/page-content.json').read_text(encoding='utf-8')).get('pages', {})
    for path, page in data['pages'].items():
        output = render_page(path, page, root)
        target = root / path
        if not target.exists() or target.read_text(encoding='utf-8') != output:
            target.write_text(output, encoding='utf-8')
    for section, (index_path, label) in SECTIONS.items():
        source = (root / index_path).read_text(encoding='utf-8')
        source = re.sub(r'<!-- editorial-list:start -->.*?<!-- editorial-list:end -->', '', source, flags=re.S)
        rows = [(path, page) for path, page in data['pages'].items()
                if page['section'] == section and managed.get(path, {}).get('status', 'published') == 'published']
        if rows:
            rows.sort(key=lambda item: (item[1]['eventStart'] or item[1]['updated'], item[0]), reverse=True)
            cards = ''.join(f'<article class="content-card"><div class="card-body"><time datetime="{page["updated"]}">{page["updated"]}</time><h3><a href="{path}">{escape(page["title"])}</a></h3><p>{escape(page["summary"])}</p></div></article>' for path, page in rows)
            list_html = f'<!-- editorial-list:start --><section class="wrap section"><h2>{label}專頁</h2><div class="content-grid">{cards}</div></section><!-- editorial-list:end -->'
            source = source.replace('</main>', list_html + '</main>', 1)
        (root / index_path).write_text(source, encoding='utf-8')
    print('Built owner-authored editorial pages:', len(data['pages']))


if __name__ == '__main__':
    build(Path(__file__).resolve().parents[1])
