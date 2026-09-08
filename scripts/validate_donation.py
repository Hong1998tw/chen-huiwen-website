#!/usr/bin/env python3
"""Validate donation integration, local references and public-data boundaries."""
from pathlib import Path
from urllib.parse import urlsplit, unquote
from collections import Counter
import json, re
import xml.etree.ElementTree as ET
from bs4 import BeautifulSoup
import html5lib
R=Path(__file__).resolve().parents[1]
page=R/'political-donation.html'
s=page.read_text(); soup=BeautifulSoup(s,'html.parser')
errors=[]
def require(ok,label):
 if not ok: errors.append(label)
parser=html5lib.HTMLParser(strict=False);parser.parse(s)
require(not parser.errors,f'HTML5 parse: {parser.errors}')
require(soup.html.get('lang')=='zh-Hant-TW','lang')
require(len(soup.select('h1'))==1,'single h1')
require(len(soup.select('main'))==1,'single main')
for name in ['description']:
 require(bool(soup.select_one(f'meta[name="{name}"]')['content']),name)
for prop in ['og:title','og:description','og:url','og:type','og:locale','og:image','og:image:alt']:
 require(bool(soup.select_one(f'meta[property="{prop}"]')['content']),prop)
url='https://hong1998tw.github.io/chen-huiwen-website/political-donation.html'
require(soup.select_one('link[rel="canonical"]')['href']==url,'canonical')
require(soup.select_one('meta[property="og:url"]')['content']==url,'og url')
require(sum(e.text==url for e in ET.parse(R/'sitemap.xml').iter('{http://www.sitemaps.org/schemas/sitemap/0.9}loc'))==1,'sitemap exactly once')
require(not soup.select('form,input,iframe'),'no donation data collection or embeds')
require(len(soup.select('details'))==9,'FAQ count')
require(all(d.find('summary') for d in soup.select('details')),'native FAQ summaries')
require(soup.select_one('.donation-account-number').text=='752200636579','verified account')
require('115年高雄市議員擬參選人陳慧文政治獻金專戶' in s,'verified account holder')
require('1151860348' in s and '115 年 5 月 7 日' in s,'permit date / number')
require(not re.search(r'YOUR_GITHUB_USERNAME|YOUR_REPOSITORY_NAME|example\.com|TODO|TBD|待補|placeholder=',s),'no deploy placeholders')
require(not re.search(r'drive\.google\.com|notion\.(so|com)|[A-Z][12][0-9]{8}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|BEGIN .*PRIVATE KEY',s),'no private URL, Taiwan ID or known secret patterns')
files=sorted(R.glob('*.html'))
refs=0
for f in files:
 doc=BeautifulSoup(f.read_text(),'html.parser')
 require(len(doc.select('#navigation a[href="political-donation.html"]'))==1,f'{f.name}: header entry')
 require(len(doc.select('footer a[href="political-donation.html"]'))==1,f'{f.name}: footer entry')
 ids=[el['id'] for el in doc.select('[id]')]
 require(len(ids)==len(set(ids)),f'{f.name}: duplicate IDs')
 for el in doc.select('[href],[src]'):
  raw=el.get('href',el.get('src'));u=urlsplit(raw)
  if u.scheme or u.netloc:continue
  target=R/unquote(u.path) if u.path else f
  require(target.exists(),f'{f.name}: missing local target {raw}')
  if u.fragment and target.suffix=='.html' and target.exists():
   targetdoc=BeautifulSoup(target.read_text(),'html.parser')
   require(targetdoc.find(id=unquote(u.fragment)) is not None,f'{f.name}: missing anchor {raw}')
  refs+=1
for a in soup.select('a[target="_blank"]'):
 require({'noopener','noreferrer'}<=set(a.get('rel',[])),'external rel')
for img in soup.select('img'):require(img.has_attr('alt'),'alt')
for el in soup.select('[aria-controls]'):require(soup.find(id=el['aria-controls']) is not None,'aria-controls target')
require(soup.select_one('#navigation [aria-current="page"]')['href']=='political-donation.html','current navigation')
print(json.dumps({'status':'Failed' if errors else 'Passed','html_files':len(files),'local_references_checked':refs,'errors':errors},ensure_ascii=False,indent=2))
raise SystemExit(bool(errors))
