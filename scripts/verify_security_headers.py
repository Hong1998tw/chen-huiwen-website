#!/usr/bin/env python3
"""Read-only check of public security headers and verified immutable assets.

Run after a deployment (or against `wrangler dev --local`) to confirm the
`_headers` rules reach representative routes and that every locally verified
hashed asset is served with the expected cache policy and exact SHA-256 bytes.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time
from urllib.error import HTTPError
from urllib.request import urlopen

from build_cloudflare_public import (
    IMMUTABLE_CACHE_CONTROL, PATH_HEADERS, SECURITY_HEADERS, immutable_asset_records,
)
from verify_cloudflare_assets import public_request

PATHS = ('/', '/index.html', '/about.html', '/site.js', '/styles.css',
         '/data/search-index.json', '/assets/chen-huiwen-480.webp',
         '/mktexp26/', '/deployment.json')
NOT_FOUND_PROBE = '/__security-header-probe__'
REPORTED = ('content-type', 'cache-control', 'cf-cache-status',
            'strict-transport-security', *(name.lower() for name, _ in SECURITY_HEADERS))


def fetch(url, timeout=25):
    """Return status, final URL, lower-cased headers and exact response bytes."""
    try:
        with urlopen(public_request(url), timeout=timeout) as response:
            return (response.status, response.geturl(),
                    {k.lower(): v for k, v in response.headers.items()}, response.read())
    except HTTPError as error:
        return (error.code, error.geturl(),
                {k.lower(): v for k, v in error.headers.items()}, error.read())


def expected_for(path):
    expected = {name.lower(): value for name, value in SECURITY_HEADERS}
    for pattern, headers in PATH_HEADERS:
        if pattern == path:
            expected.update({name.lower(): value for name, value in headers})
    return expected


def verify_immutable_assets(base, artifact_root, getter=fetch):
    """Check actual response policy and bytes for all locally verified hash assets."""
    root = Path(artifact_root)
    try:
        publication = json.loads((root / 'publication-manifest.json').read_text(encoding='utf-8'))
        records = immutable_asset_records(root, publication)
    except (OSError, ValueError, TypeError) as error:
        return {'status': 'FAIL', 'results': [{
            'failures': [type(error).__name__ + ': ' + str(error)],
        }]}
    if not records:
        return {'status': 'FAIL', 'results': [{
            'failures': ['publication manifest has no verified immutable assets'],
        }]}

    base = base.rstrip('/')
    results = []
    for relative, expected_hash in records:
        url = base + '/' + relative
        started = datetime.now(timezone.utc).isoformat(timespec='seconds')
        try:
            response = getter(url)
            if len(response) < 4:
                raise ValueError('asset getter did not return response bytes')
            status, final_url, headers, body = response[:4]
            observed_hash = hashlib.sha256(body).hexdigest()
            failures = []
            if status != 200:
                failures.append(f'status {status}')
            if final_url.rstrip('/') != url.rstrip('/'):
                failures.append('redirected to ' + final_url)
            observed_cache = headers.get('cache-control')
            if observed_cache != IMMUTABLE_CACHE_CONTROL:
                failures.append(f'cache-control: {observed_cache!r} != {IMMUTABLE_CACHE_CONTROL!r}')
            if observed_hash != expected_hash:
                failures.append(f'sha256: {observed_hash} != {expected_hash}')
            results.append({
                'url': url, 'time': started, 'status': status, 'finalUrl': final_url,
                'expectedSha256': expected_hash, 'observedSha256': observed_hash,
                'headers': {'cache-control': observed_cache}, 'failures': failures,
            })
        except (OSError, ValueError, TypeError) as error:
            results.append({'url': url, 'time': started,
                            'failures': [type(error).__name__ + ': ' + str(error)]})
    return {'status': 'PASS' if not any(result['failures'] for result in results) else 'FAIL',
            'results': results}


def verify(base, paths=PATHS, getter=fetch, artifact_root='_site'):
    base = base.rstrip('/')
    results = []
    for path in (*paths, NOT_FOUND_PROBE):
        url = base + path
        started = datetime.now(timezone.utc).isoformat(timespec='seconds')
        try:
            response = getter(url)
            status, final_url, headers = response[:3]
        except OSError as error:
            results.append({'url': url, 'time': started,
                            'failures': [type(error).__name__ + ': ' + str(error)]})
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

    immutable = verify_immutable_assets(base, artifact_root, getter)
    passed = not any(result['failures'] for result in results) and immutable['status'] == 'PASS'
    return {'base': base, 'status': 'PASS' if passed else 'FAIL',
            'results': results, 'immutableAssets': immutable,
            # Informational only: HSTS is a Cloudflare zone setting, not part of the artifact.
            'hsts': results[0].get('headers', {}).get('strict-transport-security') if results else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='https://www.huiwen.tw')
    parser.add_argument('--artifact-root', type=Path, default=Path('_site'),
                        help='Exact locally built public artifact containing publication-manifest.json')
    parser.add_argument('--attempts', type=int, default=1)
    parser.add_argument('--delay', type=float, default=15)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    for attempt in range(1, args.attempts + 1):
        report = verify(args.base_url, artifact_root=args.artifact_root)
        if report['status'] == 'PASS' or attempt == args.attempts:
            break
        time.sleep(args.delay)
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    print(encoded, end='')
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded, encoding='utf-8')
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
