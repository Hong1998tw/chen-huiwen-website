#!/usr/bin/env python3
"""Read-only, non-blocking external URL inventory; never submit forms or messages."""
from pathlib import Path
from html import unescape
from urllib.parse import urlsplit,quote
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError
from concurrent.futures import ThreadPoolExecutor
import json,re,sys
R=Path(__file__).resolve().parents[1];urls={}
for p in list(R.glob('*.html'))+list((R/'data').glob('*.json')):
 for url in re.findall(r'https?://[^\s<>"\x27]+',unescape(p.read_text())):
  if urlsplit(url).hostname in ['hong1998tw.github.io','schema.org','www.w3.org']:continue
  urls.setdefault(url,set()).add(str(p.relative_to(R)))
def check(pair):
 url,files=pair
 try:
  target=quote(url,safe=':/%?=&+#,;')
  with urlopen(Request(target,headers={'User-Agent':'Mozilla/5.0 (website link audit)'}),timeout=18) as r:
   status='redirect' if r.url!=target else '2xx';code=r.status
 except HTTPError as e:
  code=e.code;status={401:'auth required',403:'unknown (access denied)',429:'rate limited',404:'broken',410:'broken'}.get(code,'unknown')
 except (URLError,TimeoutError,ValueError,OSError):code=None;status='unknown'
 return {'url':url,'files':sorted(files),'status':status,'httpStatus':code}
results=list(ThreadPoolExecutor(max_workers=8).map(check,sorted(urls.items())))
path=Path(sys.argv[1]) if len(sys.argv)>1 else R/'external-links.json'
path.write_text(json.dumps({'checkedAt':'2026-09-08','method':'GET headers only; no forms submitted; network failures not CI blockers','links':results},ensure_ascii=False,indent=2)+'\n')
from collections import Counter
print(json.dumps(dict(Counter(x['status'] for x in results))))
