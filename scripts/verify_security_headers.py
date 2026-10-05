#!/usr/bin/env python3
"""Read-only check that a public origin returns the reviewed security headers.

Run it after a deployment (or against `wrangler dev --local`) to confirm the
`_headers` rules reach every kind of path: the internal `/` rewrite, a legacy
directory rewrite, HTML, JS, CSS, JSON, an image, the receipt and the 404 page.
"""
import argparse
from datetime import datetime, timezone
import json
import sys
import time
from urllib.error import HTTPError
from urllib.request import urlopen

from build_cloudflare_public import PATH_HEADERS, SECURITY_HEADERS
from verify_cloudflare_assets import public_request

PATHS = ('/', '/index.html', '/about.html', '/site.js', '/styles.css',
         '/data/search-index.json', '/assets/chen-huiwen-480.webp',
         '/mktexp26/', '/deployment.json')
NOT_FOUND_PROBE = '/__security-header-probe__'
REPORTED = ('content-type', 'cache-control', 'cf-cache-status',
            'strict-transport-security', *(name.lower() for name, _ in SECURITY_HEADERS))


def fetch(url, timeout=25):
    """Return (status, final_url, lower-cased headers); HTTP errors still carry headers."""
    try:
        with urlopen(public_request(url), timeout=timeout) as response:
            return response.status, response.geturl(), {k.lower(): v for k, v in response.headers.items()}
    except HTTPError as error:
        return error.code, error.geturl(), {k.lower(): v for k, v in error.headers.items()}


def expected_for(path):
    expected = {name.lower(): value for name, value in SECURITY_HEADERS}
    for pattern, headers in PATH_HEADERS:
        if pattern == path:
            expected.update({name.lower(): value for name, value in headers})
    return expected


def verify(base, paths=PATHS, getter=fetch):
    base = base.rstrip('/')
    results = []
    for path in (*paths, NOT_FOUND_PROBE):
        url = base + path
        started = datetime.now(timezone.utc).isoformat(timespec='seconds')
        try:
            status, final_url, headers = getter(url)
        except OSError as error:
            results.append({'url': url, 'time': started, 'failures': [type(error).__name__ + ': ' + str(error)]})
            continue
        probe = path == NOT_FOUND_PROBE
        failures = []
        if status != (404 if probe else 200):
            failures.append(f'status {status}')
        if final_url.rstrip('/') != url.rstrip('/'):
            failures.append('redirected to ' + final_url)
        for name, value in expected_for(path).items():
            if headers.get(name) != value:
                failures.append(f'{name}: {headers.get(name)!r} != {value!r}')
        if path not in {p for p, _ in PATH_HEADERS} and 'no-store' in headers.get('cache-control', ''):
            failures.append('unexpected no-store')
        results.append({'url': url, 'time': started, 'status': status, 'finalUrl': final_url,
                        'headers': {k: headers[k] for k in REPORTED if k in headers}, 'failures': failures})
    return {'base': base, 'status': 'PASS' if not any(r['failures'] for r in results) else 'FAIL',
            'results': results,
            # Informational only: HSTS is a Cloudflare zone setting, not part of the artifact.
            'hsts': results[0].get('headers', {}).get('strict-transport-security') if results else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='https://www.huiwen.tw')
    parser.add_argument('--attempts', type=int, default=1)
    parser.add_argument('--delay', type=float, default=15)
    args = parser.parse_args(argv)
    for attempt in range(1, args.attempts + 1):
        report = verify(args.base_url)
        if report['status'] == 'PASS' or attempt == args.attempts:
            break
        time.sleep(args.delay)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
