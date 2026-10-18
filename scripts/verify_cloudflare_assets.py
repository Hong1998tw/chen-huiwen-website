#!/usr/bin/env python3
"""Verify every published byte against a local or preview Static Assets origin."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from page_font_contract import validate_artifact_contract, validate_font_bytes

PRIVATE_PATHS = (
    'data/case-context.json', 'data/deployment-target.json', 'data/deployment-request.json',
    'scripts/build_all.py', 'admin/wrangler.jsonc',
)

def public_request(url):
    # Identify this read-only verifier consistently, including aliases and absence checks.
    return Request(url, headers={'User-Agent':'huiwen-public-asset-verifier','Accept-Encoding':'identity','Cache-Control':'no-cache'})

def error_summary(error):
    if isinstance(error, HTTPError):
        return 'HTTP ' + str(error.code) + '; content-type=' + str(error.headers.get('Content-Type', ''))
    return type(error).__name__

def verify_private_paths(base, request=urlopen):
    failures = []
    for private in PRIVATE_PATHS:
        try:
            with request(public_request(base.rstrip('/') + '/' + private), timeout=25) as response:
                failures.append(private + ': non-public path returned HTTP ' + str(response.status))
        except HTTPError as error:
            if error.code != 404:
                failures.append(private + ': expected 404, got ' + error_summary(error))
        except OSError as error:
            failures.append(private + ': ' + error_summary(error))
    return failures

def verify(base, root):
    root = Path(root)
    try:
        contract = validate_artifact_contract(root)
    except (OSError, ValueError, TypeError, KeyError) as error:
        return {'status':'FAIL','base':base,'checkedFiles':0,'checkedAliases':0,
                'checkedFonts':0,'failures':['local page-font/publication contract: ' + str(error)]}
    publication = contract['publication']
    files = dict(publication['files'])
    font_rows = contract['fonts']
    for name in ('publication-manifest.json','deployment.json'):
        files[name] = hashlib.sha256((root / name).read_bytes()).hexdigest()
    def check(pair):
        name, expected = pair
        try:
            req = public_request(base.rstrip('/') + '/' + name)
            with urlopen(req, timeout=25) as response:
                body = response.read()
                ok = response.status == 200 and hashlib.sha256(body).hexdigest() == expected
                if ok and name in font_rows:
                    validate_font_bytes(name, body, font_rows[name])
            return None if ok else name + ': bytes differ'
        except (HTTPError, OSError, ValueError) as error:
            return name + ': ' + (str(error) if isinstance(error, ValueError) else error_summary(error))
    with ThreadPoolExecutor(max_workers=8) as pool:
        failures = [error for error in pool.map(check, files.items()) if error]
    routes = {'/':'index.html'}
    routes.update({'/' + name.removesuffix('index.html'):name for name in files if name.endswith('/index.html')})
    for route, name in routes.items():
        try:
            with urlopen(public_request(base.rstrip('/') + route), timeout=25) as response:
                if response.status != 200 or hashlib.sha256(response.read()).hexdigest() != files[name]:
                    failures.append(route + ': directory route differs')
        except (HTTPError, OSError) as error:
            failures.append(route + ': ' + error_summary(error))
    failures.extend(verify_private_paths(base))
    return {'status':'PASS' if not failures else 'FAIL','base':base,'checkedFiles':len(files),
            'checkedAliases':len(routes),'checkedFonts':len(font_rows),'failures':failures}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--root', default='_site')
    parser.add_argument('--report')
    args = parser.parse_args()
    result = verify(args.base_url, args.root)
    if args.report:
        target = Path(args.report);target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(result,indent=2) + '\n')
    print(json.dumps(result,ensure_ascii=False))
    return 0 if result['status'] == 'PASS' else 1

if __name__ == '__main__':
    raise SystemExit(main())
