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
IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
GENERATED_FONT_PREFIX = 'assets/fonts/huiwen-site-sans/generated/'
GENERATED_FONT_NAME = re.compile(r'[a-z0-9][a-z0-9-]*-([a-f0-9]{12})\.woff2\Z')
CMS_RUNTIME_NAME = re.compile(r'cms-page-editor\.([a-f0-9]{12})\.js\Z')

def immutable_asset_records(root, publication):
    """Return only manifest-listed, locally verified, filename-hashed public assets."""
    root = Path(root).resolve()
    files = publication.get('files') if isinstance(publication, dict) else None
    if not isinstance(files, dict):
        raise ValueError('Public publication manifest has no files map')

    records = []
    for relative, declared_hash in sorted(files.items()):
        if not isinstance(relative, str) or '\\' in relative:
            continue
        name = Path(relative).name
        font_relative = relative.removeprefix(GENERATED_FONT_PREFIX)
        font_match = (GENERATED_FONT_NAME.fullmatch(name)
                      if relative.startswith(GENERATED_FONT_PREFIX) and '/' not in font_relative else None)
        cms_match = CMS_RUNTIME_NAME.fullmatch(name) if '/' not in relative else None
        match = font_match or cms_match
        if not match:
            continue
        if relative.startswith('/') or '..' in Path(relative).parts:
            raise ValueError('Unsafe immutable asset path: ' + relative)
        if not isinstance(declared_hash, str) or not re.fullmatch(r'[a-f0-9]{64}', declared_hash):
            raise ValueError('Invalid manifest SHA-256 for immutable asset: ' + relative)
        asset = root / relative
        if asset.is_symlink() or not asset.is_file() or root not in asset.resolve().parents:
            raise ValueError('Missing or unsafe immutable asset: ' + relative)
        actual_hash = hashlib.sha256(asset.read_bytes()).hexdigest()
        if actual_hash != declared_hash:
            raise ValueError('Manifest SHA-256 differs from immutable asset bytes: ' + relative)
        if not actual_hash.startswith(match.group(1)):
            raise ValueError('Filename hash differs from immutable asset bytes: ' + relative)
        records.append((relative, actual_hash))
    if len(records) + 1 + len(PATH_HEADERS) > 100:
        raise ValueError(f'Cloudflare _headers has {len(records) + 1 + len(PATH_HEADERS)} rules; maximum is 100')
    return records

def render_headers(root, publication):
    """Render exact-path cache rules from the current, byte-verified publication."""
    immutable = immutable_asset_records(root, publication)
    asset_rules = [('/' + relative, (('Cache-Control', IMMUTABLE_CACHE_CONTROL),))
                   for relative, _ in immutable]
    rules = [('/*', SECURITY_HEADERS), *PATH_HEADERS, *asset_rules]
    if len(rules) > 100:
        raise ValueError(f'Cloudflare _headers has {len(rules)} rules; maximum is 100')
    patterns = [path for path, _ in rules]
    if len(patterns) != len(set(patterns)):
        raise ValueError('Cloudflare _headers contains duplicate path rules')
    text = ''.join(path + '\n' + ''.join(f'  {name}: {value}\n' for name, value in headers)
                   for path, headers in rules)
    if any(len(line) > 2000 for line in text.splitlines()):
        raise ValueError('Cloudflare _headers contains a line over 2,000 characters')
    return text

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
    (destination / '_headers').write_text(render_headers(destination, manifest))
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
