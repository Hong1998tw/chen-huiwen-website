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
    (destination / '_headers').write_text('/deployment.json\n  Cache-Control: no-store\n')
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
