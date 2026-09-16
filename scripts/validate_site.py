#!/usr/bin/env python3
"""Deterministic public boundaries, HTML, SEO and source integrity checks."""
from pathlib import Path
from urllib.parse import urlsplit,unquote
from html import unescape
import json,re,subprocess,xml.etree.ElementTree as ET
from bs4 import BeautifulSoup
import html5lib
R=Path(__file__).resolve().parents[1];errors=[]
def require(ok,label):
 if not ok:errors.append(label)
files=set(subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],cwd=R,text=True).splitlines())
# A public repository must never track local/private work areas, secret files or service-case exports,
# even if someone bypasses .gitignore with `git add -f`.
private_path_patterns=[
 re.compile(r'(^|/)private(?:/|$)',re.I),
 re.compile(r'(^|/)\.local(?:/|$)',re.I),
 re.compile(r'(^|/)audit-results(?:/|$)',re.I),
 re.compile(r'(^|/)\.env(?:\.|$)',re.I),
 re.compile(r'\.(?:pem|key|p12|pfx)$',re.I),
 re.compile(r'(^|/)(?:achievement-candidates|service-cases|schedule-private)[^/]*\.(?:csv|xlsx)$',re.I),
]
for name in sorted(files):
 require(not any(pattern.search(name) for pattern in private_path_patterns),f'{name}: private/sensitive path must not be tracked')
allow=json.loads((R/'data/public-link-allowlist.json').read_text())['notion'];found=[]
for name in sorted(files):
 p=R/name
 if not p.is_file():continue
 try:s=p.read_text()
 except UnicodeDecodeError:continue
 for raw in re.findall(r'https?://[^\s<>"\x27`]+',unescape(s).replace('\\/', '/')):
  u=urlsplit(raw.rstrip('.,);]'));host=u.hostname or ''
  if any(host==d or host.endswith('.'+d) for d in ['notion'+'.so','notion'+'.site','notion'+'.com']):
   found.append({'file':name,'url':raw});require(raw in allow,f'{name}: non-allowlisted public content URL')
 # Known tokens / private keys / personal identification patterns. No value is printed.
 require(not re.search(r'gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b[A-Z][12][0-9]{8}\b',s),f'{name}: sensitive pattern')
 require('YOUR_GITHUB_USERNAME' not in s or name.startswith(('.github/','scripts/','docs/')),f'{name}: deploy placeholder')
pages={p.name:BeautifulSoup(p.read_text(),'html.parser') for p in R.glob('*.html')};canonical=[];refs=0
for name,doc in pages.items():
 parser=html5lib.HTMLParser();parser.parse((R/name).read_text());require(not parser.errors,f'{name}: HTML5 errors {parser.errors}')
 require(doc.html.get('lang')=='zh-Hant-TW',f'{name}: language')
 require(len(doc.select('h1'))==1 and len(doc.select('main'))==1,f'{name}: main/headings')
 require(bool(doc.select_one('.skip-link')),f'{name}: skip link')
 for sel in ['title','meta[name="description"]','link[rel="canonical"]','meta[property="og:title"]','meta[property="og:description"]','meta[property="og:url"]','meta[property="og:image"]','meta[name="twitter:card"]']:
  require(bool(doc.select_one(sel)),f'{name}: {sel}')
 c=doc.select_one('link[rel="canonical"]')['href'];canonical.append(c)
 require(doc.select_one('meta[property="og:url"]')['content']==c,f'{name}: OG canonical mismatch')
 public_text=(R/name).read_text()
 for bad in ['待核驗','資料核驗狀態','資料查核','來源邊界','不混為完成','正式選舉公報尚未取得','已收到並核對','尚未查到','本頁不把','不把未釐清','內部連結','目前未收錄更完整']:
  require(bad not in public_text,f'{name}: internal-facing public copy {bad}')
 for script in doc.select('script[type="application/ld+json"],script[type="application/json"]'):
  try:json.loads(script.string or script.text)
  except ValueError:require(False,f'{name}: structured JSON')
 for image in doc.select('img'):
  require(image.has_attr('alt'),f'{name}: image alt')
  if image.get('src'):require(image.get('width') and image.get('height'),f'{name}: image dimensions')
 for el in doc.select('[href],[src]'):
  raw=el.get('href',el.get('src'));u=urlsplit(raw)
  if u.scheme or u.netloc:continue
  path=unquote(u.path);target=R/path if path else R/name
  if target.is_dir():target=target/'index.html'
  require(target.is_file(),f'{name}: missing {raw}')
  if u.fragment and target.name in pages:require(bool(pages[target.name].find(id=unquote(u.fragment))),f'{name}: missing fragment {raw}')
  refs+=1
 for source in doc.select('[srcset]'):
  for item in source['srcset'].split(','):require((R/item.strip().split()[0]).is_file(),f'{name}: srcset asset')
 for a in doc.select('a[target="_blank"]'):
  rel=set(a.get('rel',[]));require({'noopener','noreferrer'}.issubset(rel),f'{name}: external rel')
 brand=doc.select_one('a.brand')
 if brand:require(not brand.has_attr('aria-label'),f'{name}: visible brand text must remain in accessible name')
# News editorial contract: Notion owns the prose policy; GitHub enforces deployable invariants.
news=pages.get('news.html')
if news:
 news_text=news.get_text(' ',strip=True)
 for bad in ['多家媒體均確認','多家媒體證實','經多家媒體交叉確認']:
  require(bad not in news_text,f'news.html: forbidden self-verification wording {bad}')
 for i,card in enumerate(news.select('.news-report-card'),start=1):
  links=card.select('.news-source-links a')
  if len(links)>=2:
   require('完整報導' in card.get_text(' ',strip=True),f'news.html: multi-source card {i} missing 完整報導')
   for a in links:
    require('｜' in a.get_text(' ',strip=True),f'news.html: multi-source card {i} link missing 媒體｜原文標題')
  for figure in card.select('.news-report-media'):
   image=figure.select_one('img');src=(image.get('src','') if image else '')
   require('site-share' not in src and not re.search(r'(^|/)chen-huiwen-(?:240|480|800)\.(?:avif|webp|png|jpe?g)$',src),f'news.html: generic portrait/share image used as news photo {src}')
   require(bool(figure.select_one('figcaption')),f'news.html: news image missing caption/credit {src}')
  tags=card.get('data-news-tags','').split();visible=[x.get_text(strip=True) for x in card.select('.news-tag-list .news-tag')]
  require(bool(tags),f'news.html: card {i} missing hashtag metadata')
  require(visible==['#'+tag for tag in tags],f'news.html: card {i} visible hashtag list mismatch')
 require(not news.select_one('.news-layout'),'news.html: legacy announcement block must not return')
 require(bool(news.select_one('#news-search')),'news.html: media search control missing')
 require(bool(news.select_one('#news-sort')),'news.html: media sort control missing')
 require(len(news.select('.news-filter-selectors details.news-multiselect'))==2,'news.html: topic/tag multiselect controls missing')
 require(not news.select('.news-filter-button'),'news.html: legacy pill topic filters must not return')
 require(not news.select('.news-press-card'),'news.html: press-release cards must live on press.html')
press=pages.get('press.html')
if press:
 press_cards=press.select('.news-press-card')
 press_files={p.name for p in R.glob('news-*.html')}
 press_links={a.get('href') for a in press.select('.news-press-card h2 a[href]')}
 require(len(press_cards)==len(press_files),f'press.html: expected {len(press_files)} press cards, got {len(press_cards)}')
 require(press_links==press_files,'press.html: press index/detail-page set mismatch')
 require(bool(press.select_one('#press-search')),'press.html: press search control missing')
 require(bool(press.select_one('#press-sort')),'press.html: press sort control missing')
 require(all(card.get('data-news-categories') for card in press_cards),'press.html: every press card needs topic categories')
 require(all(card.get('data-news-tags') for card in press_cards),'press.html: every press card needs hashtag metadata')
 for i,card in enumerate(press_cards,start=1):
  tags=card.get('data-news-tags','').split();visible=[x.get_text(strip=True) for x in card.select('.news-tag-list .news-tag')]
  require(visible==['#'+tag for tag in tags],f'press.html: card {i} visible hashtag list mismatch')
 require(len(press.select('.news-filter-selectors details.news-multiselect'))==2,'press.html: topic/tag multiselect controls missing')
 require(not press.select('.news-filter-button'),'press.html: legacy pill topic filters must not return')
 require('const PAGE_SIZE = 10;' in (R/'news.js').read_text(),'news.js: page size must remain 10')
 require('const PAGE_SIZE = 10;' in (R/'press.js').read_text(),'press.js: page size must remain 10')
workflow=(R/'.github/workflows/production-verification.yml').read_text()
require('node tests/donation/production-browser.mjs' in workflow,'production verification: live production browser runner missing')
require('BASE_URL: https://www.huiwen.tw/' in workflow,'production verification: canonical live BASE_URL missing')
require('run: node tests/donation/browser.mjs' not in workflow,'production verification: candidate browser runner must not substitute live QA')
prod_browser=(R/'tests/donation/production-browser.mjs').read_text()
require('live_production_proxy.py' in prod_browser,'production browser: Python live snapshot proxy launcher missing')
require((R/'tests/donation/live_production_proxy.py').is_file(),'production browser: Python live snapshot proxy file missing')
proxy_source=(R/'tests/donation/live_production_proxy.py').read_text()
require('_snapshot.json' in proxy_source,'production browser proxy: verified snapshot manifest gate missing')
require('normalize_edge_html' in proxy_source,'production browser proxy: edge normalization missing')
require('LIVE_SNAPSHOT_DIR' in prod_browser,'production browser: live snapshot env gate missing')
require('Cloudflare browser envelope only' in prod_browser,'production browser: edge normalization disclosure missing')
require('--snapshot-dir /tmp/huiwen-production-snapshot' in workflow,'production verification: HTTP live snapshot capture missing')
require('LIVE_SNAPSHOT_DIR: /tmp/huiwen-production-snapshot' in workflow,'production verification: browser live snapshot binding missing')
require('live-preflight:start' in prod_browser,'production browser: live preflight missing')
require('live-check:start' in prod_browser,'production browser: progress logging missing')
verify_source=(R/'scripts/verify_production.py').read_text()
for runtime_path in ['data/achievements.json','data/search-index.json','data/events.json','data/platforms.json','assets/fengshan-villages.geojson']:
 require(runtime_path in verify_source,f'production verification: runtime live data snapshot missing {runtime_path}')
locs=[x.text for x in ET.parse(R/'sitemap.xml').iter('{http://www.sitemaps.org/schemas/sitemap/0.9}loc')]
require(len(locs)==len(set(locs)),'duplicate sitemap canonical')
for name,doc in pages.items():
 if name!='404.html':require(doc.select_one('link[rel="canonical"]')['href'] in locs,f'{name}: sitemap canonical')
for p in (R/'data').glob('*.json'):json.loads(p.read_text())
for width in [240,480,800]:
 for fmt in ['avif','webp']:require((R/f'assets/chen-huiwen-{width}.{fmt}').stat().st_size<100000,'portrait size budget')
require('src="assets/chen-huiwen.png"' not in str(pages['index.html'].select_one('picture source')),'responsive portrait')
print(json.dumps({'status':'Failed' if errors else 'Passed','htmlPages':len(pages),'localReferences':refs,'notionURLs':found,'errors':errors},ensure_ascii=False,indent=2))
raise SystemExit(bool(errors))
