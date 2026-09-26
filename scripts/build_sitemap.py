#!/usr/bin/env python3
"""Use editorial content dates, never build time, as sitemap lastmod."""
from pathlib import Path
import json
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NS = 'http://www.sitemaps.org/schemas/sitemap/0.9'
BASE = 'https://www.huiwen.tw/'


def build(root=ROOT):
    metadata = json.loads((root / 'data/page-metadata.json').read_text())
    managed = json.loads((root / 'data/page-content.json').read_text()).get('pages', {})
    ET.register_namespace('', NS)
    tree = ET.parse(root / 'sitemap.xml')
    entries = {}
    for entry in tree.getroot():
        loc = entry.find('{' + NS + '}loc').text
        relative = loc.removeprefix(BASE)
        name = 'index.html' if not relative else relative.rstrip('/') + '/index.html' if relative.endswith('/') else relative
        entries[name] = entry
        if name in metadata:
            entry.find('{' + NS + '}lastmod').text = metadata[name]['contentUpdated']
    for name, state in managed.items():
        if not name.endswith('.html'):
            continue
        status = state.get('status', 'published')
        if status not in {'published', 'unpublished', 'deleted'}:
            raise ValueError('PAGE_CONTENT_STATUS: ' + name)
        if status != 'published':
            entry = entries.pop(name, None)
            if entry is not None:
                tree.getroot().remove(entry)
            continue
        if name not in entries:
            entry = ET.SubElement(tree.getroot(), '{'+NS+'}url')
            location = '' if name == 'index.html' else name[:-10] if name.endswith('/index.html') else name
            ET.SubElement(entry, '{'+NS+'}loc').text = BASE + location
            lastmod = state.get('lastmod') or metadata.get(name, {}).get('contentUpdated')
            if not lastmod:
                raise ValueError('PAGE_CONTENT_LASTMOD_REQUIRED: ' + name)
            ET.SubElement(entry, '{'+NS+'}lastmod').text = lastmod
            entries[name] = entry
        elif state.get('lastmod'):
            entries[name].find('{' + NS + '}lastmod').text = state['lastmod']
    existing = {entry.find('{'+NS+'}loc').text for entry in tree.getroot()}
    for name in ('service-guides.html', 'service-print.html', 'updates.html'):
        if BASE + name not in existing and managed.get(name, {}).get('status', 'published') == 'published':
            entry = ET.SubElement(tree.getroot(), '{'+NS+'}url')
            ET.SubElement(entry, '{'+NS+'}loc').text = BASE + name
            ET.SubElement(entry, '{'+NS+'}lastmod').text = metadata[name]['contentUpdated']
    ET.indent(tree, space='  ')
    (root / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(tree.getroot(), encoding='unicode') + '\n')
    print('Built sitemap from recorded content dates')


if __name__ == '__main__':
    build()
