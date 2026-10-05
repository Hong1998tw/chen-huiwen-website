#!/usr/bin/env python3
"""Package only the reviewed public artifact for code-free Cloudflare Static Assets."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import sys
import build_public

ROOT = Path(__file__).resolve().parents[1]

# Minimal response headers for the code-free static delivery. Cloudflare Static
# Assets reads them from `_headers` and applies them to every asset response
# (including the internal `/` and legacy-directory rewrites and the 404 page).
# Deliberately NOT included here (see docs/CLOUDFLARE-EDGE-RUNBOOK.md): a full CSP, COEP/CORP
# and HSTS. HSTS is a Cloudflare zone setting, not a per-artifact header.
SECURITY_HEADERS = (
    ('X-Content-Type-Options', 'nosniff'),
    ('Referrer-Policy', 'strict-origin-when-cross-origin'),
    # Denies only features the public pages never use. Facebook's embed keeps
    # its own `allow=` delegation (encrypted-media, picture-in-picture, web-share).
    ('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()'),
    # The admin preview loads pages through its same-origin /api/page-preview
    # proxy, so no first-party site needs to frame these pages.
    ('X-Frame-Options', 'DENY'),
    ('Content-Security-Policy', "frame-ancestors 'none'"),
)
PATH_HEADERS = (
    ('/deployment.json', (('Cache-Control', 'no-store'),)),
)

def render_headers():
    """Return the `_headers` file text: one catch-all rule plus per-path overrides."""
    rules = [('/*', SECURITY_HEADERS), *PATH_HEADERS]
    return ''.join(path + '\n' + ''.join(f'  {name}: {value}\n' for name, value in headers)
                   for path, headers in rules)

def build(root=ROOT, destination=None, source_commit=None):
    root = Path(root).resolve()
    destination = Path(destination or root / '_site').resolve()
    revision = source_commit or subprocess.check_output(['git','rev-parse','HEAD'], cwd=root, text=True).strip()
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('A full Git source commit is required')
    result = build_public.build(root, destination)
    publication = destination / 'publication-manifest.json'
    manifest = json.loads(publication.read_text())
    # Explicit internal rewrites preserve the existing index and directory URLs.
    aliases = ['/ /index.html 200']
    aliases.extend('/' + path.removesuffix('index.html') + ' /' + path + ' 200'
                   for path in build_public.LEGACY_PAGES)
    (destination / '_redirects').write_text('\n'.join(aliases) + '\n')
    (destination / '_headers').write_text(render_headers())
    receipt = {'schemaVersion':1, 'provider':'cloudflare-static-assets',
               'sourceCommit':revision,
               'publicArtifactDigest':hashlib.sha256(publication.read_bytes()).hexdigest(),
               'publicFileCount':len(manifest['files']),
               'publicRecordCount':manifest['publicRecordCount']}
    (destination / 'deployment.json').write_text(json.dumps(receipt, sort_keys=True, separators=(',',':')) + '\n')
    return {**result, 'sourceCommit':revision, 'provider':receipt['provider']}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(build(destination=args.output), ensure_ascii=False))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
