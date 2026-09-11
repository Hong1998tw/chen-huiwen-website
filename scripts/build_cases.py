#!/usr/bin/env python3
"""Build the public map and standalone case pages from reviewed public JSON only."""
from pathlib import Path
import json,re,html,hashlib
R=Path(__file__).resolve().parents[1]
E=lambda s:html.escape(str(s),quote=True)
BASE='https://www.huiwen.tw/'
items=json.loads((R/'data/achievements.json').read_text())
geo=json.loads((R/'assets/fengshan-villages.geojson').read_text())
template=(R/'templates/case-page.html').read_text()
byid={x['id']:x for x in items}
assert len(byid)==len(items)
def href(i):return 'achievement-'+i+'.html'
def ext(url,title):return f'<a href="{E(url)}" target="_blank" rel="noopener noreferrer">{E(title)} ↗</a>'
def main_tags(c):return ''.join(f'<span class="case-tag-main">{E(t)}</span>' for t in c['categories'])
def sub_tags(c):return ''.join(f'<span class="case-tag-sub">{E(t)}</span>' for t in c.get('subcategories',[]))
def asset_version(path):return hashlib.sha256((R/path).read_bytes()).hexdigest()[:12]
def page(file,title,description,body,head=''):
 s=template
 for k,v in {'TITLE':E(title),'DESCRIPTION':E(description),'FILE':E(file),'BODY':body,'HEAD':head}.items():s=s.replace('{{'+k+'}}',v)
 (R/file).write_text(s)
def card(c):
 status='' if c['status']=='待核驗' else '<span class="case-status">'+E(c['status'])+'</span>'
 location='、'.join(c['villages']) or c['scope']
 summary=('<p class="case-summary">'+E(c['summary'])+'</p>') if c['summary'] else ''
 locate=f'<button type="button" data-locate="{E(c["id"])}">地圖定位</button>' if c['coordinates'] else ''
 subtags=('<div class="case-subtags">'+sub_tags(c)+'</div>') if c.get('subcategories') else ''
 return f'''<article class="case-card" data-case="{E(c['id'])}"><div class="case-card-header"><div class="case-tag-group"><div class="case-tags">{main_tags(c)}</div>{subtags}</div>{status}</div><h3><a href="{href(c['id'])}">{E(c['title'])}</a></h3>{summary}<div class="case-card-footer"><span class="case-place">{E(location)}</span><div class="case-actions"><a class="case-primary-link" href="{href(c['id'])}">查看完整內容 →</a>{locate}</div></div></article>'''
for c in items:
 h=''.join(f'<li><time>{E(x["date"])}</time><div><h3>{E(x["title"])}</h3><p>{E(x["text"])}</p></div></li>' for x in c['history'])
 photos=''
 if c['images']:photos='<div class="case-photos">'+''.join(f'<a href="assets/{E(p)}"><img src="assets/{E(p)}" alt="{E(c["title"])}公開照片" width="{c["imageDimensions"][p][0]}" height="{c["imageDimensions"][p][1]}" loading="lazy"></a>' for p in c['images'])+'</div>'
 location=('、'.join(c['villages']) or c['scope'])
 info=f'<dl class="case-facts"><div><dt>服務範圍</dt><dd>{E(location)}</dd></div>'
 if c['status']!='待核驗':info+=f'<div><dt>進度</dt><dd>{E(c["status"])}</dd></div>'
 if c['budget']:info+=f'<div><dt>來源所載經費</dt><dd>{E(c["budget"])}</dd></div>'
 info+='</dl>'
 content=('<h2>重點說明</h2>'+''.join('<p>'+E(p)+'</p>' for p in c['paragraphs'])) if c['paragraphs'] else ''
 history=('<section class="history-section"><p class="eyebrow">推動歷程</p><h2>重要進度</h2><ol class="case-timeline">'+h+'</ol></section>') if h else ''
 sources=('<section class="case-sources"><h2>資料來源</h2><ul class="source-links">'+''.join('<li>'+ext(source['url'],source['title'])+'</li>' for source in c['sources'])+'</ul></section>') if c['sources'] else ''
 article='<article class="case-body">'+content+photos+history+sources+'</article>' if content or photos or history or sources else ''
 layout_class='case-layout' if article else 'case-layout case-layout-compact'
 description=c['summary'] or f'「{c["title"]}」專題索引與資料核驗狀態｜陳慧文服務處'
 related=''
 if c['related']:related='<section class="section wrap"><p class="eyebrow">RELATED STORIES</p><h2>相關專題</h2><div class="related-cases">'+''.join(card(byid[id]) for id in c['related'])+'</div></section>'
 body=f'''<div class="wrap breadcrumb"><a href="./">首頁</a><span>/</span><a href="achievements.html">政績地圖</a><span>/</span><span>{E(c['title'])}</span></div><section class="page-head case-head"><div class="wrap"><p class="eyebrow">政績與服務</p><div class="case-tags">{main_tags(c)}</div>{('<div class="case-subtags">'+sub_tags(c)+'</div>') if c.get('subcategories') else ''}<h1>{E(c['title'])}</h1>{('<p>'+E(c['summary'])+'</p>') if c['summary'] else ''}</div></section><div class="wrap {layout_class}">{article}<aside class="case-aside">{info}<a class="button button-green" href="achievements.html?case={E(c['id'])}">{'在地圖查看' if c['coordinates'] else '回到政績列表'} →</a><a class="text-link" href="petition.html">有相關問題想反映 →</a></aside></div>{related}'''
 structured={'@context':'https://schema.org','@type':'Article','headline':c['title'],'description':description,'inLanguage':'zh-Hant-TW','dateModified':c['updated'],'author':{'@type':'Organization','name':'陳慧文服務處'},'mainEntityOfPage':BASE+href(c['id'])}
 breadcrumbs={'@context':'https://schema.org','@type':'BreadcrumbList','itemListElement':[{'@type':'ListItem','position':1,'name':'首頁','item':BASE},{'@type':'ListItem','position':2,'name':'政績與追蹤紀錄','item':BASE+'achievements.html'},{'@type':'ListItem','position':3,'name':c['title'],'item':BASE+href(c['id'])}]}
 page(href(c['id']),c['title'],description,body,'<script type="application/ld+json">'+json.dumps([structured,breadcrumbs],ensure_ascii=False).replace('<','\\u003c')+'</script>')
# Map page: all cards pre-rendered so reading never depends on map tiles or JavaScript.
villages=sorted([f['properties']['name'] for f in geo['features']])
scopes=sorted(set(x['scope'] for x in items if x['scope']!='鳳山區'))
opts=''.join(f'<option value="v:{E(v)}">{E(v)}</option>' for v in villages)+''.join(f'<option value="s:{E(s)}">{E(s)}</option>' for s in scopes)+'<option value="unassigned">里別待核驗</option>'
cats=sorted({t for c in items for t in c['categories']});subcats=sorted({t for c in items for t in c.get('subcategories',[])});statuses=sorted({c['status'] for c in items})
mapdata=[{k:c[k] for k in ['id','title','summary','categories','subcategories','villages','scope','status','coordinates']} for c in items]
body=f'''<section class="page-head map-head"><div class="wrap"><p class="eyebrow">FENGSHAN, ONE PLACE AT A TIME</p><h1>慧做事・政績地圖</h1><p>從你的里出發，看看地方建設、服務與每一步進度。</p><div class="map-stats"><span><strong>{len(items)}</strong> 個專題紀錄</span><span><strong>{len(villages)}</strong> 里可點選</span><span>點選地圖或卡片，閱讀站內完整歷程</span></div></div></section><section class="wrap map-controls" aria-label="政績篩選"><div><label for="case-search">關鍵字</label><input id="case-search" type="search" placeholder="搜尋道路、學校、寵物或案件名稱"></div><div><label for="village-filter">里別／服務範圍</label><select id="village-filter"><option value="all">全部里別與範圍</option>{opts}</select></div><div><label for="category-filter">主題</label><select id="category-filter"><option value="all">全部主題</option>{''.join(f'<option>{E(t)}</option>' for t in cats)}</select></div><div><label for="subcategory-filter">小分類</label><select id="subcategory-filter"><option value="all">全部小分類</option>{''.join(f'<option>{E(t)}</option>' for t in subcats)}</select></div><div><label for="status-filter">進度</label><select id="status-filter"><option value="all">全部進度</option>{''.join(f'<option>{E(t)}</option>' for t in statuses)}</select></div><button type="button" id="reset-map-filters">清除篩選</button></section><section class="wrap map-workspace"><div class="map-panel"><a class="text-link" href="#case-results">跳到篩選結果 ↓</a><div id="achievement-map" role="region" aria-label="鳳山政績互動地圖"><p class="map-startup">地圖載入中，所有紀錄也可由下方列表閱讀。</p></div><p class="map-message" id="map-message" role="status">點選里界可篩選；數字標記代表該位置收錄的專題數。</p><p class="map-source">里界：{ext('https://data.gov.tw/dataset/7438','內政部國土測繪中心')}，2026-08-17。點位為代表位置，不是施工範圍；全市政策與尚缺座標的紀錄只列於列表。</p><button type="button" id="map-fit" class="map-fit">查看目前結果範圍</button></div><div class="case-results" id="case-results"><div class="results-heading"><h2>建設與服務紀錄</h2><p id="case-count" aria-live="polite">共 {len(items)} 個專題</p></div><div id="case-list">{''.join(card(c) for c in items)}</div><div id="case-empty" hidden><h3>這個條件下還沒有收錄紀錄。</h3><p>這不代表該里沒有服務或建設；你可以更換條件，或查看全市政策。</p><button type="button" data-clear-filters>顯示全部紀錄</button></div></div></section><noscript><p class="wrap">目前未啟用 JavaScript，地圖與篩選暫不可用；下方完整紀錄與詳情頁仍可直接閱讀。</p></noscript><script type="application/json" id="map-data">{json.dumps(mapdata,ensure_ascii=False).replace('<','&#60;')}</script>'''
collection={'@context':'https://schema.org','@type':'CollectionPage','@id':BASE+'achievements.html#collection','name':'鳳山政績與建設追蹤','url':BASE+'achievements.html','description':'結合鳳山里界、建設位置、主題與進度，直接在本站閱讀政績說明及歷史紀錄。','inLanguage':'zh-Hant-TW'}
breadcrumbs={'@context':'https://schema.org','@type':'BreadcrumbList','itemListElement':[{'@type':'ListItem','position':1,'name':'首頁','item':BASE},{'@type':'ListItem','position':2,'name':'鳳山政績與建設追蹤','item':BASE+'achievements.html'}]}
map_css_v=asset_version('map.css')
map_js_v=asset_version('map.js')
head=f'<link rel="stylesheet" href="assets/vendor/leaflet.css"><link rel="stylesheet" href="map.css?v={map_css_v}"><script src="assets/vendor/leaflet.js" defer></script><script src="map.js?v={map_js_v}" defer></script><script type="application/ld+json">'+json.dumps([collection,breadcrumbs],ensure_ascii=False).replace('<','\\u003c')+'</script>'
page('achievements.html','鳳山政績與建設追蹤','查詢鳳山建設與民眾服務專題，依里別、主題、小分類與進度查詢政績、服務與推動歷程。',body,head)
print('Built',len(items),'standalone details and map index')
