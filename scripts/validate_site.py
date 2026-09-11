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
 for bad in ['待核驗','資料核驗狀態','資料查核','來源邊界','不混為完成','正式選舉公報尚未取得','已收到並核對']:
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
 for a in doc.select('a[target="_blank"]'):require('noopener' in a.get('rel',[]),f'{name}: external rel')
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
