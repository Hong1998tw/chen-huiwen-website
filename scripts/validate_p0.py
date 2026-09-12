#!/usr/bin/env python3
"""Check that the shipped index, structured records and PNG metadata stay in sync."""
import hashlib, json, struct
from pathlib import Path
from bs4 import BeautifulSoup
R=Path(__file__).resolve().parents[1]
source=json.loads((R/'data/achievements.json').read_text())
public=[c for c in source if c['status']!='待核驗']
index=json.loads((R/'data/search-index.json').read_text())
assert index['count']==len(index['items'])
assert len({c['url'] for c in index['items']})==len(index['items'])
for c in index['items']:
 path=R/c['url'];assert path.parent==R and path.exists(),c['url']
 doc=BeautifulSoup(path.read_text(),'html.parser');assert not doc.select_one('meta[name=robots][content*=noindex]')
assert {c['url'] for c in index['items'] if c['type']=='政績'}=={'achievement-'+c['id']+'.html' for c in public}
manifest=json.loads((R/'assets/og/manifest.json').read_text())
for c in public:
 key='achievement-'+c['id'];assert manifest[key]['title']==c['title'];assert manifest[key]['status']==c['status']
for key,meta in manifest.items():
 path=R/'assets/og'/f'{key}.png';payload=path.read_bytes();assert payload[:8]==b'\x89PNG\r\n\x1a\n'
 assert struct.unpack('>II',payload[16:24])==(1200,630)
 assert hashlib.sha256(payload).hexdigest()==meta['sha256']
 doc=BeautifulSoup((R/(key+'.html')).read_text(),'html.parser')
 og=doc.select_one('meta[property="og:image"]')['content'];tw=doc.select_one('meta[name="twitter:image"]')['content']
 assert og==tw=='https://www.huiwen.tw/assets/og/'+key+'.png'
 assert doc.select_one('meta[property="og:image:type"]')['content']=='image/png'
 assert meta['title'] in doc.select_one('meta[property="og:image:alt"]')['content']
mapdata=json.loads(BeautifulSoup((R/'achievements.html').read_text(),'html.parser').select_one('#map-data').string)
assert {c['id'] for c in mapdata}=={c['id'] for c in public}
print(f'P0 validated: {len(index["items"])} indexed public pages; {len(public)} public records; {len(manifest)} PNG share cards')
