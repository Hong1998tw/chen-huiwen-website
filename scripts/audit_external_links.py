#!/usr/bin/env python3
"""Bounded, read-only external link audit. Availability is not fact verification."""
from pathlib import Path
from urllib.parse import urlsplit, urldefrag, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from datetime import datetime, timezone
from bs4 import BeautifulSoup
from collections import Counter
import argparse, json, re, time

ROOT = Path(__file__).resolve().parents[1]

def inventory(root):
    urls = {}
    def add(raw, source):
        raw = urldefrag(raw)[0]
        u = urlsplit(raw)
        if u.scheme not in ('http', 'https') or not u.hostname:
            return
        if u.hostname in ('www.huiwen.tw', 'huiwen.tw', 'schema.org', 'www.w3.org', 'hong1998tw.github.io'):
            return
        # Calendar links prepare a new event; map tiles are resources, not pages to crawl.
        if u.hostname in ('calendar.google.com', 'tile.openstreetmap.org') or '{' in raw:
            return
        urls.setdefault(raw, set()).add(source)
    for p in sorted(root.glob('*.html')):
        doc = BeautifulSoup(p.read_text(), 'html.parser')
        for node in doc.select('a[href], iframe[src], [data-embed-src]'):
            add(node.get('href') or node.get('src') or node['data-embed-src'], p.name)
    def walk(value, source):
        if isinstance(value, dict):
            for k, v in value.items():
                if isinstance(v, str) and (k.lower().endswith('url') or k == 'url'):
                    add(v, source)
                else: walk(v, source)
        elif isinstance(value, list):
            for v in value: walk(v, source)
    for p in sorted((root/'data').glob('*.json')):
        if p.name != 'search-index.json': walk(json.loads(p.read_text()), str(p.relative_to(root)))
    return urls

def classify(code):
    if code in (404, 410): return 'FAIL', 'not_found'
    if code is not None and 200 <= code < 400: return 'PASS', 'reachable_not_fact_verified'
    return 'BLOCKED', {401:'authentication',403:'access_denied',429:'rate_limited'}.get(code,'transport_or_server_error')

def probe(url, files, timeout, attempts, interval):
    receipt = []
    for attempt in range(attempts):
        code, final, error = None, None, None
        try:
            target = quote(url, safe=':/%?=&+#,;@!()+')
            with urlopen(Request(target, headers={'User-Agent':'Mozilla/5.0 (public website maintenance; link availability)'}), timeout=timeout) as response:
                code, final = response.status, response.url
        except HTTPError as exc: code = exc.code
        except (URLError, TimeoutError, ValueError, OSError) as exc: error = type(exc).__name__
        receipt.append({'attempt':attempt+1,'http_status':code,'error_type':error,'observed_at':datetime.now(timezone.utc).isoformat()})
        if code is not None and code < 500: break  # Respect authentication/rate limits; no evasion.
        if attempt+1 < attempts: time.sleep(interval)
    status, reason = classify(code)
    return {'url':url,'files':sorted(files),'status':status,'httpStatus':code,'final_url':final,'reason':reason,'attempts':receipt}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('output',type=Path,nargs='?',default=Path('external-links.json'))
    p.add_argument('--root',type=Path,default=ROOT)
    p.add_argument('--timeout',type=float,default=10)
    p.add_argument('--attempts',type=int,choices=(1,2),default=2)
    p.add_argument('--interval',type=float,default=0.5)
    p.add_argument('--inventory-only',action='store_true')
    a=p.parse_args()
    if a.timeout <= 0 or a.interval < 0.25: p.error('timeout must be positive; interval must be at least 0.25 seconds')
    start=datetime.now(timezone.utc).isoformat(); urls=inventory(a.root)
    report={'checkedAt':start,'method':'Sequential GET response headers only; no response bodies, submissions, tile downloads or authentication bypass. HTTP PASS is not evidence of article accuracy.','links':[]}
    for url, files in sorted(urls.items()):
        row={'url':url,'files':sorted(files),'status':'BLOCKED','reason':'inventory_only'} if a.inventory_only else probe(url,files,a.timeout,a.attempts,a.interval)
        report['links'].append(row)
        a.output.parent.mkdir(parents=True,exist_ok=True)
        a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        if not a.inventory_only: time.sleep(a.interval)
    report['finishedAt']=datetime.now(timezone.utc).isoformat();report['summary']=dict(Counter(r['status'] for r in report['links']))
    a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'total':len(urls),**report['summary']}))
if __name__=='__main__': main()
