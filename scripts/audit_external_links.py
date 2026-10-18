#!/usr/bin/env python3
"""Bounded, read-only external link audit. Availability is not fact verification."""
from pathlib import Path
from urllib.parse import urlsplit, urldefrag, quote, urlunsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from datetime import datetime, timezone
from bs4 import BeautifulSoup
from collections import Counter
import argparse, hashlib, json, socket, ssl, time

ROOT = Path(__file__).resolve().parents[1]
MAX_TIMEOUT_SECONDS = 30

FORBIDDEN_IMAGE_SOURCE_DOMAINS = (
    'fbcdn.net', 'instagram.com', 'cdninstagram.com', 'googleusercontent.com',
)

def forbidden_image_source_host(raw):
    """Return a disallowed remote image host, without restricting ordinary source links."""
    try:
        parsed = urlsplit(raw)
        host = (parsed.hostname or '').lower().rstrip('.')
    except (TypeError, ValueError):
        return None
    is_remote = parsed.scheme in ('http', 'https') or (not parsed.scheme and bool(parsed.netloc))
    if not is_remote or not host:
        return None
    return next((domain for domain in FORBIDDEN_IMAGE_SOURCE_DOMAINS
                 if host == domain or host.endswith('.' + domain)), None)

def canonical_url(raw):
    """Normalize URL identity conservatively; query order and values stay intact."""
    try:
        parsed = urlsplit(urldefrag(raw.strip())[0])
        if parsed.scheme.lower() not in ('http', 'https') or not parsed.hostname:
            return None
        # Never send or persist credentials embedded in a link.
        if parsed.username is not None or parsed.password is not None:
            return None
        scheme = parsed.scheme.lower()
        hostname = parsed.hostname.rstrip('.').encode('idna').decode('ascii').lower()
        port = parsed.port
    except (UnicodeError, ValueError):
        return None
    if ':' in hostname:  # IPv6 literals require brackets in the authority.
        hostname = f'[{hostname}]'
    netloc = hostname
    if port is not None and not ((scheme == 'http' and port == 80) or (scheme == 'https' and port == 443)):
        netloc += f':{port}'
    return urlunsplit((scheme, netloc, parsed.path or '/', parsed.query, ''))

def url_fingerprint(url):
    return 'sha256:' + hashlib.sha256(url.encode('utf-8')).hexdigest()

def inventory(root):
    urls = {}
    def add(raw, source):
        raw = canonical_url(raw)
        if not raw:
            return
        u = urlsplit(raw)
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

def classify(code, error_class=None):
    if code in (404, 410): return 'FAIL', 'not_found'
    if code is not None and 200 <= code < 400: return 'PASS', 'reachable_not_fact_verified'
    if code is None:
        return 'BLOCKED', error_class or 'unknown_result'
    reasons = {
        401: 'authentication', 403: 'access_denied', 407: 'proxy_authentication',
        408: 'request_timeout', 429: 'rate_limited',
    }
    if code in reasons: return 'BLOCKED', reasons[code]
    if 500 <= code < 600: return 'BLOCKED', 'server_error'
    return 'BLOCKED', 'unexpected_http_status'

def classify_error(exc):
    reason = exc.reason if isinstance(exc, URLError) else exc
    if isinstance(reason, ssl.SSLError): return 'tls_error'
    if isinstance(reason, (TimeoutError, socket.timeout)): return 'timeout'
    if isinstance(exc, ValueError): return 'invalid_request'
    if isinstance(exc, (URLError, OSError)): return 'network_error'
    return 'unknown_transport_error'

def retryable(code, error_class):
    if code in (401, 403, 404, 407, 410, 429) or (code is not None and 200 <= code < 400):
        return False
    if code == 408 or (code is not None and 500 <= code < 600):
        return True
    return code is None and error_class in ('timeout', 'network_error')

def retry_class(attempts, status):
    if len(attempts) > 1:
        if status == 'PASS': return 'recovered_after_retry'
        if status == 'FAIL': return 'terminal_not_found_after_retry'
        return 'bounded_retry_exhausted'
    if attempts and attempts[-1]['retryable']:
        return 'retryable_but_single_attempt'
    return 'not_retryable'

def probe(url, files, timeout, attempts, interval):
    receipt = []
    for attempt in range(attempts):
        code, final, error = None, None, None
        try:
            target = quote(url, safe=':/%?=&+#,;@!()+')
            with urlopen(Request(target, headers={'User-Agent':'Mozilla/5.0 (public website maintenance; link availability)'}), timeout=timeout) as response:
                code, final = response.status, response.url
        except HTTPError as exc:
            code = exc.code
        except (URLError, TimeoutError, ValueError, OSError) as exc:
            error = classify_error(exc)
        can_retry = retryable(code, error)
        will_retry = can_retry and attempt + 1 < attempts
        receipt.append({
            'attempt':attempt+1,'http_status':code,'error_class':error,
            'retryable':can_retry,'retry_scheduled':will_retry,
            'observed_at':datetime.now(timezone.utc).isoformat(),
        })
        if not will_retry:
            break  # In particular, do not retry authentication or rate-limit responses.
        time.sleep(interval)
    status, reason = classify(code, error)
    return {
        'url':url,'fingerprint':url_fingerprint(url),'files':sorted(files),
        'status':status,'httpStatus':code,'final_url':final,'reason':reason,
        'retryClass':retry_class(receipt, status),'attempts':receipt,
    }

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('output',type=Path,nargs='?',default=Path('external-links.json'))
    p.add_argument('--root',type=Path,default=ROOT)
    p.add_argument('--timeout',type=float,default=10)
    p.add_argument('--attempts',type=int,choices=(1,2),default=2)
    p.add_argument('--interval',type=float,default=0.5)
    p.add_argument('--inventory-only',action='store_true')
    a=p.parse_args()
    if a.timeout <= 0 or a.timeout > MAX_TIMEOUT_SECONDS or a.interval < 0.25:
        p.error('timeout must be greater than 0 and at most 30 seconds; interval must be at least 0.25 seconds')
    start=datetime.now(timezone.utc).isoformat(); urls=inventory(a.root)
    report={
        'reportVersion':1,'state':'running','checkedAt':start,
        'probeMode':'inventory_only' if a.inventory_only else 'http_get',
        'limits':{'timeoutSeconds':a.timeout,'maximumTimeoutSeconds':MAX_TIMEOUT_SECONDS,'maxAttempts':a.attempts,'intervalSeconds':a.interval,'minimumIntervalSeconds':0.25},
        'method':'Sequential GET response headers only; no response bodies, submissions, tile downloads or authentication bypass. HTTP PASS is not evidence of article accuracy.',
        'links':[],
    }
    a.output.parent.mkdir(parents=True,exist_ok=True)
    for url, files in sorted(urls.items()):
        row={
            'url':url,'fingerprint':url_fingerprint(url),'files':sorted(files),
            'status':'NOT_RUN','reason':'inventory_only','retryClass':'not_run','attempts':[],
        } if a.inventory_only else probe(url,files,a.timeout,a.attempts,a.interval)
        report['links'].append(row)
        a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        if not a.inventory_only: time.sleep(a.interval)
    report['state']='complete';report['finishedAt']=datetime.now(timezone.utc).isoformat();report['summary']=dict(Counter(r['status'] for r in report['links']))
    a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'total':len(urls),**report['summary']}))
if __name__=='__main__': main()
