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
from page_font_contract import FONT_PREFIXES, page_font_namespace_records, validate_artifact_contract

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
    ('/page-font-manifest.json', (('Cache-Control', 'public, max-age=0, must-revalidate'),)),
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
    if len(records) + 1 + len(PATH_HEADERS) + 2 > 100:
        raise ValueError(f'Cloudflare _headers has {len(records) + 1 + len(PATH_HEADERS) + 2} rules; maximum is 100')
    return records

def render_headers(root, publication, font_contract=None):
    """Render exact-path cache rules from the current, byte-verified publication."""
    immutable = immutable_asset_records(root, publication)
    asset_rules = [('/' + relative, (('Cache-Control', IMMUTABLE_CACHE_CONTROL),))
                   for relative, _ in immutable]
    validated_namespaces = (font_contract.get('fontNamespaces')
                            if isinstance(font_contract, dict) else None)
    if validated_namespaces is not None:
        expected_namespaces = {prefix.rstrip('/') for prefix in FONT_PREFIXES}
        if (not isinstance(validated_namespaces, list)
                or set(validated_namespaces) != expected_namespaces
                or len(validated_namespaces) != len(expected_namespaces)):
            raise ValueError('Validated page-font namespace closure is invalid')
        namespaces = {prefix: [] for prefix in validated_namespaces}
    else:
        namespaces = page_font_namespace_records(root, publication)
    namespace_rules = [(f'/{prefix.rstrip("/")}/*', (('Cache-Control', IMMUTABLE_CACHE_CONTROL),))
                       for prefix in namespaces]
    rules = [('/*', SECURITY_HEADERS), *PATH_HEADERS, *asset_rules, *namespace_rules]
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


def _assert_reused_font_contract(destination, publication, font_contract):
    temporary = font_contract.get('publication') if isinstance(font_contract, dict) else None
    temporary_files = temporary.get('files') if isinstance(temporary, dict) else None
    manifest_bytes = font_contract.get('manifestBytes') if isinstance(font_contract, dict) else None
    if (not isinstance(temporary_files, dict) or not isinstance(manifest_bytes, bytes)
            or 'sw.js' in temporary_files):
        raise ValueError('A source-derived temporary font contract is required')
    expected_files = dict(temporary_files)
    worker_path = destination / 'sw.js'
    if worker_path.is_symlink() or not worker_path.is_file():
        raise ValueError('Rendered Service Worker is missing or unsafe')
    expected_files['sw.js'] = hashlib.sha256(worker_path.read_bytes()).hexdigest()
    if (publication.get('version') != temporary.get('version')
            or publication.get('publicRecordCount') != temporary.get('publicRecordCount')
            or publication.get('files') != expected_files):
        raise ValueError('Final publication differs from the validated temporary font contract')
    font_manifest = destination / 'page-font-manifest.json'
    if (font_manifest.is_symlink() or not font_manifest.is_file()
            or font_manifest.read_bytes() != manifest_bytes):
        raise ValueError('Page-font manifest changed after source-derived validation')


def add_delivery_metadata(destination, source_commit, source_root=ROOT, font_contract=None):
    """Attach the canonical deployment identity to an already-built public artifact."""
    destination = Path(destination).resolve()
    source_root = Path(source_root).resolve()
    if not re.fullmatch(r'[a-f0-9]{40}', str(source_commit)):
        raise ValueError('A full Git source commit is required')
    publication = destination / 'publication-manifest.json'
    if not publication.is_file() or publication.is_symlink():
        raise ValueError('A built publication-manifest.json is required')
    manifest = json.loads(publication.read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or not isinstance(manifest.get('files'), dict):
        raise ValueError('The publication manifest is invalid')
    # Do not attach cache policy or a deployment receipt until the exact source-derived
    # route, font namespace, cmap, axis, and publication closure has been validated.
    if font_contract is None:
        font_contract = validate_artifact_contract(destination, source_root)
    else:
        _assert_reused_font_contract(destination, manifest, font_contract)
    # Explicit internal rewrites preserve the existing index and directory URLs.
    aliases = ['/ /index.html 200']
    aliases.extend('/' + path.removesuffix('index.html') + ' /' + path + ' 200'
                   for path in build_public.LEGACY_PAGES)
    (destination / '_redirects').write_text('\n'.join(aliases) + '\n', encoding='utf-8')
    (destination / '_headers').write_text(
        render_headers(destination, manifest, font_contract), encoding='utf-8'
    )
    receipt = {'schemaVersion':1, 'provider':'cloudflare-static-assets',
               'sourceCommit':source_commit,
               'publicArtifactDigest':hashlib.sha256(publication.read_bytes()).hexdigest(),
               'publicFileCount':len(manifest['files']),
               'publicRecordCount':manifest.get('publicRecordCount')}
    (destination / 'deployment.json').write_text(
        json.dumps(receipt, sort_keys=True, separators=(',',':')) + '\n', encoding='utf-8'
    )
    return receipt


def build(root=ROOT, destination=None, source_commit=None):
    root = Path(root).resolve()
    destination = Path(destination or root / '_site').resolve()
    revision = source_commit or subprocess.check_output(['git','rev-parse','HEAD'], cwd=root, text=True).strip()
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('A full Git source commit is required')
    result = build_public.build(root, destination, include_font_contract=True)
    font_contract = result.pop('_fontContract')
    receipt = add_delivery_metadata(destination, revision, root, font_contract=font_contract)
    return {**result, 'sourceCommit':revision, 'provider':receipt['provider']}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--output', type=Path)
    mode.add_argument('--wrap-existing-artifact', type=Path,
                      help='add canonical deployment metadata without rebuilding the public artifact')
    parser.add_argument('--source-commit')
    args = parser.parse_args()
    try:
        if args.wrap_existing_artifact:
            revision = args.source_commit or subprocess.check_output(
                ['git','rev-parse','HEAD'], cwd=ROOT, text=True
            ).strip()
            print(json.dumps(add_delivery_metadata(args.wrap_existing_artifact, revision), ensure_ascii=False))
            return 0
        print(json.dumps(build(destination=args.output, source_commit=args.source_commit), ensure_ascii=False))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
