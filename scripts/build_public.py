#!/usr/bin/env python3
"""Build the explicit public projection and Pages artifact; never publish the repo root."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from urllib.parse import unquote, urljoin, urlsplit

from achievement_metadata import is_public
from page_copy import render_with_manifest

ROOT = Path(__file__).resolve().parents[1]
PROJECTION = 'data/achievements-public.json'
PUBLIC_DATA = (
    PROJECTION, 'data/achievement-map.json', 'data/election-2026.json',
    'data/platforms.json', 'data/events.json', 'data/search-index.json',
    'data/legal-schedule.json', 'data/service-search.json', 'data/site-profile.json',
)
ROOT_FILES = (
    '.nojekyll', 'CNAME', 'robots.txt', 'sitemap.xml', 'manifest.webmanifest',
    '404.html', 'offline.html', 'styles.css', 'mobile.css', 'layout.css',
    'civic.css', 'digital.css', 'home.css', 'campaign.css', 'embeds.css',
    'map.css', 'news.css', 'political-donation.css', 'site.js', 'civic.js',
    'digital.js', 'home.js', 'small-q.css', 'small-q.js', 'campaign.js', 'embeds.js', 'map.js', 'news.js',
    'activities.js', 'activities.css', 'legal-calendar.js', 'legal-calendar.css', 'press.js', 'election.js', 'explore.js', 'sw.js', 'updates.xml',
)
LEGACY_PAGES = (
    'mktexp26/index.html', 'd13de1081a3a49219363e5a0ace2c83b/index.html',
    '8-14-340-bc3304be04fa445d8423e6bd9764847a/index.html',
    '16-396bd146805480b1ad78e832b20b6565/index.html',
    '398bd146805480f98aecedb69d2e1070/index.html', 'renwu-anju-social-housing/index.html',
)
MEDIA_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg', '.gif', '.ico', '.pdf', '.geojson', '.woff', '.woff2', '.mp4', '.webm', '.mp3'}
VENDOR_FILES = {'assets/vendor/leaflet.js', 'assets/vendor/leaflet.css', 'assets/vendor/LEAFLET-LICENSE.txt', 'assets/legal/OFL.txt', 'assets/home-OFL.txt'}
MAP_FIELDS = {'id', 'title', 'summary', 'categories', 'subcategories', 'villages', 'scope', 'status', 'coordinates', 'locationName', 'locationNote', 'history', 'updated', 'searchText', 'years', 'funding'}


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def validate_schema(value, schema, label='public record'):
    """Validate the small, deliberately dependency-free JSON Schema subset we ship."""
    if 'anyOf' in schema:
        for choice in schema['anyOf']:
            try:
                validate_schema(value, choice, label)
                return
            except ValueError:
                pass
        raise ValueError(label + ': no permitted type')
    kinds = {'object': dict, 'array': list, 'string': str, 'number': (int, float), 'integer': int, 'null': type(None), 'boolean': bool}
    kind = schema.get('type')
    if kind and (not isinstance(value, kinds[kind]) or kind in ('number', 'integer') and isinstance(value, bool)):
        raise ValueError(label + ': wrong type')
    if 'enum' in schema and value not in schema['enum']:
        raise ValueError(label + ': value outside public allowlist')
    if isinstance(value, dict):
        properties = schema.get('properties', {})
        if set(schema.get('required', [])) - value.keys():
            raise ValueError(label + ': missing required public fields')
        if schema.get('additionalProperties') is False and value.keys() - properties.keys():
            raise ValueError(label + ': field outside public allowlist')
        for key, child in value.items():
            rule = properties.get(key, schema.get('additionalProperties'))
            if isinstance(rule, dict):
                validate_schema(child, rule, label + '.' + key)
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0):
            raise ValueError(label + ': too few items')
        for child in value:
            validate_schema(child, schema.get('items', {}), label + '[]')
    if isinstance(value, str):
        if len(value) < schema.get('minLength', 0) or 'pattern' in schema and not re.search(schema['pattern'], value):
            raise ValueError(label + ': invalid text')


def project_value(value, schema):
    if 'anyOf' in schema:
        schema = next((s for s in schema['anyOf'] if s.get('type') == ('null' if value is None else 'array' if isinstance(value, list) else 'string')), schema['anyOf'][0])
    if isinstance(value, dict):
        allowed = schema.get('properties')
        if allowed is not None:
            return {key: project_value(value[key], rule) for key, rule in allowed.items() if key in value}
        return {key: project_value(child, schema.get('additionalProperties', {})) for key, child in value.items()}
    if isinstance(value, list):
        return [project_value(child, schema.get('items', {})) for child in value]
    return value


def public_records(root=ROOT):
    schema = json.loads((root / 'schema/public-achievement.schema.json').read_text())
    raw = json.loads((root / 'data/achievements.json').read_text())
    records = [project_value(row, schema['items']) for row in raw if is_public(row)]
    validate_schema(records, schema)
    if len({row['id'] for row in records}) != len(records):
        raise ValueError('Duplicate public record IDs')
    return records


def validate_map(root, records):
    rows = json.loads((root / 'data/achievement-map.json').read_text())
    if not isinstance(rows, list) or {r.get('id') for r in rows} != {r['id'] for r in records} or len(rows) != len(records):
        raise ValueError('Map/public projection IDs differ')
    by_id = {r['id']: r for r in records}
    for row in rows:
        if row.get('funding') != by_id[row['id']].get('funding'):
            raise ValueError('Map funding differs from reviewed public source')
        if row.keys() - MAP_FIELDS or not is_public(row):
            raise ValueError('Map contains a non-public field or record')
        for event in row.get('history', []):
            if event.keys() - {'date', 'title', 'text'}:
                raise ValueError('Map history contains a review-only field')


def write_projection(root=ROOT, check=False):
    records = public_records(root)
    # Source changes can add/remove a public record before the map builder runs.
    # Projection generation must not depend on yesterday's generated map. The
    # publication/check gate still requires both generated views to agree.
    if check:
        validate_map(root, records)
    payload = encoded(records)
    destination = root / PROJECTION
    if check:
        if not destination.exists() or destination.read_bytes() != payload:
            raise ValueError('PUBLIC_PROJECTION_STALE: run scripts/build_public.py --projection-only')
    else:
        destination.write_bytes(payload)
    return records


def public_paths(root=ROOT):
    paths = set(ROOT_FILES) | set(PUBLIC_DATA) | set(LEGACY_PAGES)
    state_path = root / 'data/page-content.json'
    inactive = set()
    if state_path.is_file():
        state = json.loads(state_path.read_text(encoding='utf-8'))
        if isinstance(state, dict) and isinstance(state.get('pages'), dict):
            inactive = {name for name, entry in state['pages'].items()
                        if isinstance(entry, dict) and entry.get('status', 'published') in {'unpublished', 'deleted'}}
    paths.difference_update(inactive)
    # Event routes are generated from validated immutable ids, never an HTML glob.
    from build_events import event_path, public_events
    event_source = root / 'data/events.json'
    if event_source.is_file():
        paths.update(event_path(event) for event in public_events(json.loads(event_source.read_text()))
                     if event_path(event) not in inactive)
    # The sitemap is the reviewed page allowlist, not an arbitrary *.html glob.
    for loc in ET.parse(root / 'sitemap.xml').iter('{http://www.sitemaps.org/schemas/sitemap/0.9}loc'):
        url = urlsplit(loc.text or '')
        if url.hostname != 'www.huiwen.tw' or url.query or url.fragment:
            raise ValueError('Sitemap has a non-canonical public URL')
        path = unquote(url.path).lstrip('/')
        paths.add(path + 'index.html' if not path or path.endswith('/') else path)
    for path in (root / 'assets').rglob('*'):
        rel = path.relative_to(root).as_posix()
        if path.is_file() and (path.suffix.lower() in MEDIA_EXTENSIONS or rel in VENDOR_FILES):
            paths.add(rel)
    for rel in paths:
        path = root / rel
        if Path(rel).is_absolute() or '..' in Path(rel).parts or path.is_symlink() or not path.is_file() or root.resolve() not in path.resolve().parents:
            raise ValueError('Missing or unsafe public artifact path: ' + rel)
    return sorted(paths)


class LocalReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        for key in ('src', 'href', 'poster'):
            if values.get(key):
                self.references.append(values[key])


def validate_artifact_links(destination, root=ROOT):
    state = json.loads((root / 'data/page-content.json').read_text(encoding='utf-8'))
    intentionally_removed = {name for name, entry in state.get('pages', {}).items()
                              if isinstance(entry, dict) and entry.get('status') in {'unpublished', 'deleted'}}
    for path in destination.rglob('*.html'):
        parser = LocalReferences()
        parser.feed(path.read_text())
        base = 'https://www.huiwen.tw/' + path.relative_to(destination).as_posix()
        for raw in parser.references:
            url = urlsplit(urljoin(base, raw))
            if url.scheme not in ('http', 'https') or url.hostname != 'www.huiwen.tw':
                continue
            relative = unquote(url.path).lstrip('/')
            target = destination / (relative + 'index.html' if not relative or relative.endswith('/') else relative)
            route = relative.rstrip('/') + '/index.html' if relative.endswith('/') and relative else 'index.html' if not relative else relative
            if route in intentionally_removed:
                continue
            # Historical extensionless redirects are provided by the existing edge contract.
            if target.suffix and not target.is_file():
                raise ValueError(f'Artifact reference missing: {path.name} -> {relative}')


def build_page_editor_artifacts(staging, root):
    """Apply approved copy in the Pages artifact and publish editor-only indexes."""
    from page_authority import classify

    state = json.loads((root / 'data/page-content.json').read_text(encoding='utf-8'))
    entries = state.get('pages', {})
    editor_asset = root / 'cms-page-editor.js'
    if not editor_asset.is_file():
        raise ValueError('CMS editor runtime is missing from the reviewed source')
    editor_name = 'cms-page-editor.' + hashlib.sha256(editor_asset.read_bytes()).hexdigest()[:12] + '.js'
    shutil.copyfile(editor_asset, staging / editor_name)
    manifests = 0
    for path in public_paths(root):
        if not path.endswith('.html'):
            continue
        _, kind, _ = classify(path)
        if kind in {'system', 'legacy-redirect', 'excluded-intake'}:
            continue
        target = staging / path
        if not target.is_file():
            continue  # Unpublished or deleted pages are absent from the public artifact.
        entry = entries.get(path, {})
        edits = entry.get('edits', {}) if isinstance(entry, dict) else {}
        rendered, count, fields = render_with_manifest(target.read_text(encoding='utf-8'), path, edits)
        if count == 0:
            raise ValueError('CMS editor page has no editable copy: ' + path)
        manifest_bytes = encoded({'schemaVersion': 1, 'path': path, 'fields': fields})
        manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()[:12]
        manifest_name = path + '.' + manifest_hash + '.json'
        manifest_uri = '/cms-editor-manifests/' + manifest_name
        rendered, loader_count = re.subn(
            r'(<script\b(?=[^>]*data-cms-editor-loader)[^>]*)(>)',
            lambda match: match.group(1) + f' data-cms-manifest="{manifest_uri}"' + match.group(2),
            rendered,
            count=1,
            flags=re.I,
        )
        if loader_count != 1:
            raise ValueError('CMS editor loader is missing from public page: ' + path)
        loader, loader_count = re.subn(
            r'(<script\b[^>]*data-cms-editor-loader[^>]*>)(.*?)(</script>)',
            lambda match: match.group(1) + match.group(2).replace(
                'src="/cms-page-editor.js"', f'src="/{editor_name}"'
            ) + match.group(3),
            rendered,
            count=1,
            flags=re.I | re.S,
        )
        if loader_count != 1 or f'src="/{editor_name}"' not in loader:
            raise ValueError('CMS editor runtime URL could not be versioned for page: ' + path)
        target.write_text(loader, encoding='utf-8')
        manifest_path = staging / 'cms-editor-manifests' / manifest_name
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_bytes(manifest_bytes)
        manifests += 1
    return manifests


def build(root=ROOT, destination=None):
    root = root.resolve()
    destination = (destination or root / '_site').resolve()
    if destination == root or destination in root.parents:
        raise ValueError('Refusing to replace source directory')
    records = write_projection(root, check=True)
    paths = public_paths(root)
    if destination.exists() and any(destination.iterdir()) and not (destination / 'publication-manifest.json').is_file():
        raise ValueError('Refusing to replace a directory without a publication manifest')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.public-build-', dir=destination.parent) as temporary:
        staging = Path(temporary) / 'site'
        staging.mkdir()
        for rel in paths:
            target = staging / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / rel, target)
        # Preserve the historical public endpoint for older clients, with the exact
        # same safe projection. Raw canonical data remains in Git, never in _site.
        (staging / 'data/achievements.json').write_bytes(encoded(records))
        editor_manifests = build_page_editor_artifacts(staging, root)
        validate_artifact_links(staging, root)
        manifest = {path.relative_to(staging).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(staging.rglob('*')) if path.is_file()}
        (staging / 'publication-manifest.json').write_bytes(encoded({'version': 1, 'publicRecordCount': len(records), 'files': manifest}))
        if destination.exists():
            shutil.rmtree(destination)
        staging.replace(destination)
    return {'files': len(manifest) + 1, 'publicRecords': len(records), 'editorManifests': editor_manifests, 'output': str(destination)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--projection-only', action='store_true')
    args = parser.parse_args()
    try:
        rows = write_projection(args.root, check=args.check)
        if args.check or args.projection_only:
            print(f'PASS: public projection contains {len(rows)} reviewed records')
        else:
            print(json.dumps(build(args.root, args.output), ensure_ascii=False))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
