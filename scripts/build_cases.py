#!/usr/bin/env python3
"""Build the public map and standalone case pages from reviewed public JSON only."""
from pathlib import Path
import xml.etree.ElementTree as ET
import json,re,html,hashlib
from achievement_metadata import facts_html, is_public, partner_text, search_text, village_lookup
from validate_achievements import validate
R=Path(__file__).resolve().parents[1]
E=lambda s:html.escape(str(s),quote=True)
BASE='https://www.huiwen.tw/'
items=json.loads((R/'data/achievements.json').read_text())
village_rows=json.loads((R/'data/villages.json').read_text())
validation_errors,_=validate(items,village_rows)
if validation_errors: raise SystemExit('Invalid achievement metadata: '+'; '.join(validation_errors))
village_by_key=village_lookup(village_rows)
public_items=[x for x in items if is_public(x)]
# Lead with distinct subjects; the station overview links to its individual topics.
station_details={'rail-greenway','metro-green-line','station-parking','station-design','station-walkway'}
public_items.sort(key=lambda c: c['id'] in station_details)
geo=json.loads((R/'assets/fengshan-villages.geojson').read_text())
template=(R/'templates/case-page.html').read_text()
byid={x['id']:x for x in public_items}
assert len({x['id']:x for x in items})==len(items)
def href(i):return 'achievement-'+i+'.html'
def ext(url,title):return f'<a href="{E(url)}" target="_blank" rel="noopener noreferrer">{E(title)} ↗</a>'
def main_tags(c):return ''.join(f'<span class="case-tag-main">{E(t)}</span>' for t in c['categories'])
def sub_tags(c):return ''.join(f'<span class="case-tag-sub">{E(t)}</span>' for t in c.get('subcategories',[]))
def asset_version(path):return hashlib.sha256((R/path).read_bytes()).hexdigest()[:12]
def page(file,title,description,body,head='',og_type='website'):
 s=template
 for key,value in {'OG_TYPE':og_type,'DIGITAL_STYLE_VERSION':asset_version('digital.css'),'DIGITAL_SCRIPT_VERSION':asset_version('digital.js')}.items():s=s.replace('{{'+key+'}}',value)
 for k,v in {'TITLE':E(title),'DESCRIPTION':E(description),'FILE':E(file),'BODY':body,'HEAD':head,'STYLE_VERSION':asset_version('styles.css'),'OG_IMAGE':E('assets/og/'+Path(file).stem+'.png'),'OG_ALT':E(('慧做事・政績地圖' if file=='achievements.html' else title)+'｜陳慧文・高雄市議員')}.items():s=s.replace('{{'+k+'}}',v)
 (R/file).write_text(s)
def card(c):
 status='' if c['status']=='待核驗' else '<span class="case-status">'+E(c['status'])+'</span>'
 location='、'.join(c['villages']) or c['scope']
 partners=partner_text(c)
 place=E(location)+(f'<span class="case-current-head">合作里長：{E(partners)}</span>' if partners else '')
 if c.get('locationName'): place+=f'<span class="case-address">{E(c["locationName"])}</span>'
 summary=('<p class="case-summary">'+E(c['summary'])+'</p>') if c['summary'] else ''
 locate=f'<button type="button" data-locate="{E(c["id"])}">地圖定位</button>' if c['coordinates'] else ''
 subtags=''
 return f'''<article class="case-card" data-case="{E(c['id'])}"><div class="case-card-header"><div class="case-tag-group"><div class="case-tags">{''.join(f'<span class="case-tag-main">{E(t)}</span>' for t in c['categories'][:1])}</div>{subtags}</div>{status}</div><h3><a href="{href(c['id'])}">{E(c['title'])}</a></h3>{summary}<div class="case-card-footer"><span class="case-place">{place}</span><div class="case-actions"><a class="case-primary-link" href="{href(c['id'])}">查看完整內容 →</a>{locate}</div></div></article>'''
expected_pages={href(c['id']) for c in public_items}
for old in R.glob('achievement-*.html'):
 if old.name not in expected_pages: old.unlink()
for c in public_items:
 h=''.join(f'<li><time>{E(x["date"])}</time><div><h3>{E(x["title"])}</h3><p>{E(x["text"])}</p></div></li>' for x in c['history'])
 photos=''
 if c['images']:
  figures=[]
  for p in c['images']:
   metadata=c.get('imageMetadata',{}).get(p,{})
   alt=metadata.get('alt',c['title']+'公開照片')
   photo=f'<a href="assets/{E(p)}"><img src="assets/{E(p)}" alt="{E(alt)}" width="{c["imageDimensions"][p][0]}" height="{c["imageDimensions"][p][1]}" loading="lazy"></a>'
   if metadata:
    photo='<figure>'+photo+'<figcaption>'+E(metadata['caption'])+'<span class="case-photo-credit">照片：'+E(metadata['credit'])+' · '+ext(metadata['sourceUrl'],'刊登來源')+'</span></figcaption></figure>'
   figures.append(photo)
  photos='<div class="case-photos">'+''.join(figures)+'</div>'
 location=('、'.join(c['villages']) or c['scope'])
 info=facts_html(c,village_by_key)
 content=('<h2 id="case-overview">重點說明</h2>'+''.join('<p>'+E(p)+'</p>' for p in c['paragraphs'])) if c['paragraphs'] else ''
 history=('<section class="history-section" id="case-history"><p class="eyebrow">推動歷程</p><h2>重要進度</h2><ol class="case-timeline">'+h+'</ol></section>') if h else ''
 sources=('<section class="case-sources" id="case-sources"><h2>資料來源</h2><ul class="source-links">'+''.join('<li>'+(f'<time>{E(source["sourceDate"])}</time> · ' if source.get('sourceDate') else '')+ext(source['url'],source['title'])+'</li>' for source in c['sources'])+'</ul></section>') if c['sources'] else ''
 article='<article class="case-body">'+content+photos+history+sources+'</article>' if content or photos or history or sources else ''
 layout_class='case-layout' if article else 'case-layout case-layout-compact'
 description=c['summary'] or f'「{c["title"]}」政績與服務紀錄｜陳慧文服務處'
 related=''
 if c['related']:
  related_ids=[id for id in c['related'] if id in byid]
  if related_ids: related='<section class="section wrap"><p class="eyebrow">RELATED STORIES</p><h2>相關專題</h2><div class="related-cases">'+''.join(card(byid[id]) for id in related_ids)+'</div></section>'
 latest=max(c['history'],key=lambda event:event['date']) if c['history'] else None
 latest_sources=[source for source in c['sources'] if latest and source.get('sourceDate')==latest['date']]
 evidence=ext(latest_sources[-1]['url'],'核對此階段來源') if latest_sources else '<a href="#case-sources">查看完整來源 ↓</a>'
 latest_datetime=(f' datetime="{E(latest["date"])}"' if latest and re.fullmatch(r'\d{4}-\d{2}(?:-\d{2})?',latest['date']) else '')
 current=(f'<section class="case-latest" aria-labelledby="latest-heading"><p class="civic-kicker">收錄的最新歷程 · <time{latest_datetime}>{E(latest["date"])}</time></p><h2 id="latest-heading">{E(latest["title"])}</h2><p>{E(latest["text"])}</p>{evidence}<p class="record-boundary">此處呈現本站已收錄的紀錄，並非即時工程進度。後續辦理情形，請一併核對主管機關最新公告。</p></section>') if latest else '<p class="record-boundary">本專題尚未收錄具日期的推動歷程。</p>'
 reading_links = [('case-overview','重點說明',bool(content)),('case-history','推動歷程',bool(h)),('case-sources','資料來源',bool(c['sources']))]
 reading_nav = '<nav class="wrap civic-article-nav" aria-label="專題閱讀導覽">'+''.join(f'<a href="#{anchor}">{label} ↓</a>' for anchor,label,present in reading_links if present)+f'<span>內容整理 <time datetime="{E(c["updated"])}">{E(c["updated"])}</time></span></nav>'
 body=f'''<div class="wrap breadcrumb"><a href="./">首頁</a><span>/</span><a href="achievements.html">政績地圖</a><span>/</span><span>{E(c['title'])}</span></div><section class="page-head case-head" data-topic="{E(c['categories'][0])}"><div class="wrap"><p class="eyebrow">政績與服務</p><h1>{E(c['title'])}</h1>{('<p>'+E(c['summary'])+'</p>') if c['summary'] else ''}</div></section>{reading_nav}<div class="wrap case-latest-wrap">{current}</div><div class="wrap {layout_class}">{article}<aside class="case-aside">{info}<a class="button button-green" href="achievements.html?case={E(c['id'])}">{'在地圖查看' if c['coordinates'] else '回到政績列表'} →</a><a class="text-link" href="petition.html">有相關問題想反映 →</a></aside></div>{related}'''
 organization={'@type':'Organization','@id':BASE+'#organization','name':'陳慧文服務處','url':BASE,'logo':{'@type':'ImageObject','url':BASE+'assets/favicon.svg'}}
 structured={'@context':'https://schema.org','@type':'WebPage','@id':BASE+href(c['id'])+'#webpage','url':BASE+href(c['id']),'name':c['title'],'description':description,'inLanguage':'zh-Hant-TW','dateModified':c['updated'],'author':organization,'image':BASE+'assets/og/achievement-'+c['id']+'.png'}
 if c.get('published'):
  structured['datePublished']=c['published']
 breadcrumbs={'@context':'https://schema.org','@type':'BreadcrumbList','itemListElement':[{'@type':'ListItem','position':1,'name':'首頁','item':BASE},{'@type':'ListItem','position':2,'name':'政績與追蹤紀錄','item':BASE+'achievements.html'},{'@type':'ListItem','position':3,'name':c['title'],'item':BASE+href(c['id'])}]}
 page(href(c['id']),c['title'],description,body,'<script type="application/ld+json">'+json.dumps([structured,breadcrumbs],ensure_ascii=False).replace('<','\\u003c')+'</script>',og_type='website')
# Map page: all cards pre-rendered so reading never depends on map tiles or JavaScript.
villages=sorted({f['properties']['name'] for f in geo['features']} | {v for c in public_items for v in c['villages']})
scopes=sorted(set(x['scope'] for x in public_items if x['scope']!='鳳山區'))
opts=''.join(f'<option value="v:{E(v)}">{E(v)}</option>' for v in villages)+''.join(f'<option value="s:{E(s)}">{E(s)}</option>' for s in scopes)
cats=sorted({t for c in public_items for t in c['categories']});subcats=sorted({t for c in public_items for t in c.get('subcategories',[])});statuses=sorted({c['status'] for c in public_items})
mapdata=[]
for c in public_items:
 entry={k:c[k] for k in ['id','title','summary','categories','subcategories','villages','scope','status','coordinates','locationName','locationNote','history','updated']}
 entry['searchText']=search_text(c,village_by_key)
 entry['years']=sorted({h['date'][:4] for h in c['history'] if re.match(r'^(19|20)\d{2}(?:\D|$)',h['date'])})
 mapdata.append(entry)
map_json=json.dumps(mapdata,ensure_ascii=False,separators=(',',':'))+'\n'
(R/'data/achievement-map.json').write_text(map_json)
map_data_url='data/achievement-map.json?v='+asset_version('data/achievement-map.json')
years=sorted({y for c in mapdata for y in c['years']},reverse=True)
year_options=''.join(f'<option value="{y}">{y}</option>' for y in years)

body=f'''<section class="page-head map-head"><div class="wrap"><p class="eyebrow">地方建設與公開紀錄</p><h1><span>慧做事</span><span class="map-title-dot" aria-hidden="true">・</span><span>政績地圖</span></h1><p class="map-intro">從你的里出發，看看地方建設。</p><div class="map-quick-links"><a href="#case-search">搜尋政績 ↓</a><a href="#achievement-map">查看地圖 ↓</a></div></div></section><section class="wrap map-controls" aria-label="政績篩選"><div><label for="case-search">關鍵字</label><input id="case-search" type="search" placeholder="搜尋道路、學校、寵物或案件名稱"></div><div><label for="village-filter">里別／服務範圍</label><select id="village-filter"><option value="all">全部里別與範圍</option>{opts}</select></div><details class="advanced-filters"><summary>進階篩選：主題、進度與年度</summary><div class="advanced-filter-fields"><div><label for="category-filter">主題</label><select id="category-filter"><option value="all">全部主題</option>{''.join(f'<option>{E(t)}</option>' for t in cats)}</select></div><div><label for="subcategory-filter">小分類</label><select id="subcategory-filter"><option value="all">全部小分類</option>{''.join(f'<option>{E(t)}</option>' for t in subcats)}</select></div><div><label for="status-filter">進度</label><select id="status-filter"><option value="all">全部進度</option>{''.join(f'<option>{E(t)}</option>' for t in statuses)}</select></div><div><label for="year-filter">歷程年度</label><select id="year-filter"><option value="all">全部年度</option>{year_options}<option value="undated">未載歷程年度</option></select></div></div></details><button type="button" id="reset-map-filters">清除篩選</button></section><section class="wrap map-workspace civic-list-only"><div class="map-panel" hidden><a class="text-link" href="#case-results">跳到篩選結果 ↓</a><div id="achievement-map" role="region" aria-label="鳳山政績互動地圖"><p class="map-startup">地圖載入中，所有紀錄也可由下方列表閱讀。</p></div><p class="map-message" id="map-message" role="status">點選里界可篩選；數字標記代表附近專題數，放大可分開查看。</p><p class="map-source">里界：{ext('https://data.gov.tw/dataset/7438','內政部國土測繪中心')}，2026-08-17。點位為代表位置，不是施工範圍；全市政策與尚缺座標的紀錄只列於列表。</p><button type="button" id="map-fit" class="map-fit">查看目前結果範圍</button></div><div class="case-results" id="case-results"><div class="results-heading"><h2>建設與服務紀錄</h2><p id="case-count" aria-live="polite">共 {len(public_items)} 個專題</p></div><div id="case-list">{''.join(card(c) for c in public_items)}</div><div id="case-empty" hidden><h3>這個條件下目前沒有顯示紀錄。</h3><p>請調整篩選條件，或查看全部公開紀錄。</p><button type="button" data-clear-filters>顯示全部紀錄</button></div></div></section><noscript><p class="wrap">目前未啟用 JavaScript，地圖與篩選暫不可用；下方完整紀錄與詳情頁仍可直接閱讀。</p></noscript><script type="application/json" id="map-data">{json.dumps({'url':map_data_url},ensure_ascii=False)}</script>'''
collection={'@context':'https://schema.org','@type':'CollectionPage','@id':BASE+'achievements.html#collection','name':'鳳山政績與建設追蹤','url':BASE+'achievements.html','description':'結合鳳山里界、建設位置、主題與進度，直接在本站閱讀政績說明及歷史紀錄。','inLanguage':'zh-Hant-TW'}
breadcrumbs={'@context':'https://schema.org','@type':'BreadcrumbList','itemListElement':[{'@type':'ListItem','position':1,'name':'首頁','item':BASE},{'@type':'ListItem','position':2,'name':'鳳山政績與建設追蹤','item':BASE+'achievements.html'}]}
map_css_v=asset_version('map.css')
map_js_v=asset_version('map.js')
head=f'<link rel="stylesheet" href="map.css?v={map_css_v}"><script src="map.js?v={map_js_v}" defer></script><script type="application/ld+json">'+json.dumps([collection,breadcrumbs],ensure_ascii=False).replace('<','\\u003c')+'</script>'
page('achievements.html','鳳山政績與建設追蹤','查詢鳳山建設與民眾服務專題，依里別、主題、小分類與進度查詢政績、服務與推動歷程。',body,head)
print('Built',len(public_items),'public standalone details and map index from',len(items),'source records')
# Keep achievement URLs synchronized with generated pages; preserve other sections.
namespace='http://www.sitemaps.org/schemas/sitemap/0.9'
ET.register_namespace('',namespace)
sitemap_path=R/'sitemap.xml'
sitemap=ET.parse(sitemap_path)
urlset=sitemap.getroot()
for entry in list(urlset):
 loc=entry.find('{'+namespace+'}loc')
 if loc is not None and loc.text and loc.text.startswith(BASE+'achievement-'):
  urlset.remove(entry)
for c in sorted(public_items,key=lambda item:item['id']):
 entry=ET.SubElement(urlset,'{'+namespace+'}url')
 ET.SubElement(entry,'{'+namespace+'}loc').text=BASE+href(c['id'])
 ET.SubElement(entry,'{'+namespace+'}lastmod').text=c['updated']
ET.indent(sitemap,space='  ')
sitemap_path.write_text('<?xml version="1.0" encoding="UTF-8"?>\n'+ET.tostring(urlset,encoding='unicode')+'\n')
